import type { Snapshot, TreeEntry } from './github.ts';
import { GitHubClient } from './github.ts';
import { mapConcurrent } from './utils.ts';
import { privateCacheGeneration, readCounts, writeCounts } from './count-cache.ts';
import type { CachedCount } from './count-cache.ts';

export interface LineCounts {
  lines: number;
  source: number;
  blank: number;
}
export interface LanguageStats extends LineCounts {
  language: string;
  files: number;
  bytes: number;
}
export interface PathCounts extends LineCounts {
  files: number;
  eligible: number;
  processed: number;
}
export interface FileStats extends LineCounts {
  language: string;
  bytes: number;
}
export interface Analysis extends LineCounts {
  files: number;
  bytes: number;
  languages: LanguageStats[];
  fileStats: Record<string, FileStats>;
  paths: Record<string, PathCounts>;
  skipped: Record<string, string>;
  complete: boolean;
  elapsedMs: number;
  cachedFiles: number;
  fetchedFiles: number;
  excluded: { generated: number; unsupported: number; large: number; binary: number };
}

const extensions: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  pyi: 'Python',
  rs: 'Rust',
  go: 'Go',
  java: 'Java',
  kt: 'Kotlin',
  kts: 'Kotlin',
  c: 'C',
  h: 'C',
  cc: 'C++',
  cpp: 'C++',
  cxx: 'C++',
  hpp: 'C++',
  hh: 'C++',
  cs: 'C#',
  rb: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  m: 'Objective-C',
  mm: 'Objective-C++',
  dart: 'Dart',
  html: 'HTML',
  htm: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  sass: 'Sass',
  less: 'Less',
  vue: 'Vue',
  svelte: 'Svelte',
  astro: 'Astro',
  json: 'JSON',
  jsonc: 'JSON',
  yml: 'YAML',
  yaml: 'YAML',
  toml: 'TOML',
  xml: 'XML',
  sql: 'SQL',
  graphql: 'GraphQL',
  gql: 'GraphQL',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  fish: 'Shell',
  ps1: 'PowerShell',
  bat: 'Batch',
  cmd: 'Batch',
  md: 'Markdown',
  mdx: 'MDX',
  rst: 'reStructuredText',
  txt: 'Text',
  tex: 'LaTeX',
  lua: 'Lua',
  r: 'R',
  jl: 'Julia',
  ex: 'Elixir',
  exs: 'Elixir',
  erl: 'Erlang',
  hrl: 'Erlang',
  hs: 'Haskell',
  clj: 'Clojure',
  cljs: 'Clojure',
  scala: 'Scala',
  sc: 'Scala',
  zig: 'Zig',
  nim: 'Nim',
  pl: 'Perl',
  pm: 'Perl',
  proto: 'Protocol Buffers',
  tf: 'Terraform',
  tfvars: 'Terraform',
  make: 'Makefile',
  cmake: 'CMake',
  ini: 'INI',
  conf: 'Config',
  properties: 'Properties',
  svg: 'SVG',
  nix: 'Nix',
  scm: 'Scheme',
  lock: 'Lockfile',
  sum: 'Checksum',
  env: 'Config',
  gd: 'GDScript',
  glsl: 'GLSL',
  vert: 'GLSL',
  frag: 'GLSL',
  wgsl: 'WGSL',
  sol: 'Solidity',
  fs: 'F#',
  fsx: 'F#',
  vb: 'Visual Basic',
  pas: 'Pascal',
  d: 'D',
  v: 'V',
  vhd: 'VHDL',
  vhdl: 'VHDL',
};
const specialNames: Record<string, string> = {
  dockerfile: 'Dockerfile',
  makefile: 'Makefile',
  gnumakefile: 'Makefile',
  'cmakelists.txt': 'CMake',
  '.gitignore': 'Git config',
  '.gitattributes': 'Git config',
  '.editorconfig': 'Config',
  license: 'Text',
  licence: 'Text',
  readme: 'Text',
};
const generatedFolders = new Set([
  'node_modules',
  'vendor',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.output',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  'bower_components',
  'third_party',
  'third-party',
  'generated',
]);
const lockfiles = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'composer.lock',
  'poetry.lock',
  'uv.lock',
  'gemfile.lock',
  'pipfile.lock',
  'go.sum',
]);

export function classifyFile(
  file: Pick<TreeEntry, 'path' | 'size'>,
  includeGenerated = false,
): { language: string } | { excluded: 'generated' | 'unsupported' | 'large' } {
  const parts = file.path.toLowerCase().split('/');
  const name = parts.at(-1)!;
  if (
    !includeGenerated &&
    (parts.slice(0, -1).some((part) => generatedFolders.has(part)) ||
      lockfiles.has(name) ||
      /\.(min\.(js|css)|map|generated\.[^.]+)$/.test(name))
  )
    return { excluded: 'generated' };
  const extension = name.includes('.') ? name.split('.').at(-1)! : '';
  if (
    /^(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|pdf|zip|gz|tar|xz|7z|rar|woff2?|ttf|otf|eot|mp[34]|wav|ogg|flac|webm|mov|wasm|exe|dll|so|dylib|bin|sqlite3?|db|icns|psd|sketch|glb|blend|ds_store)$/.test(
      extension,
    )
  )
    return { excluded: 'unsupported' };
  const language =
    specialNames[name] ||
    (name.startsWith('dockerfile.') ? 'Dockerfile' : extensions[extension]) ||
    (includeGenerated ? 'Other text' : undefined);
  if (!language) return { excluded: 'unsupported' };
  if ((file.size ?? 0) > 2 * 1024 * 1024) return { excluded: 'large' };
  return { language };
}

/** Counts physical text lines. "source" is non-empty text, including comments. */
export function countTextLines(bytes: Uint8Array): LineCounts | null {
  if (bytes.subarray(0, 8192).includes(0)) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (!text) return { lines: 0, source: 0, blank: 0 };
  const lines = text.split(/\r\n|\n|\r/);
  if (/\r?\n$|\r$/.test(text)) lines.pop();
  const blank = lines.filter((line) => !line.trim()).length;
  return { lines: lines.length, source: lines.length - blank, blank };
}

export function createAnalysis(): Analysis {
  return {
    lines: 0,
    source: 0,
    blank: 0,
    files: 0,
    bytes: 0,
    languages: [],
    fileStats: Object.create(null),
    paths: Object.create(null),
    skipped: Object.create(null),
    complete: false,
    elapsedMs: 0,
    cachedFiles: 0,
    fetchedFiles: 0,
    excluded: { generated: 0, unsupported: 0, large: 0, binary: 0 },
  };
}

function ancestors(path: string): string[] {
  const parts = path.split('/');
  return ['', ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))];
}

export function registerEligibleFile(result: Analysis, path: string) {
  for (const key of ancestors(path)) {
    result.paths[key] ??= { lines: 0, source: 0, blank: 0, files: 0, eligible: 0, processed: 0 };
    result.paths[key].eligible++;
  }
}

export function addFileCount(result: Analysis, path: string, language: string, entry: CachedCount) {
  for (const key of ancestors(path)) {
    const stats = result.paths[key];
    stats.processed++;
    if (entry.counts) {
      stats.files++;
      for (const field of ['lines', 'source', 'blank'] as const)
        stats[field] += entry.counts[field];
    }
  }
  if (!entry.counts) {
    result.excluded.binary++;
    result.skipped[path] = 'Binary or non-UTF-8';
    return;
  }
  result.fileStats[path] = { ...entry.counts, language, bytes: entry.bytes };
  let stats = result.languages.find((item) => item.language === language);
  if (!stats) {
    stats = { language, lines: 0, source: 0, blank: 0, files: 0, bytes: 0 };
    result.languages.push(stats);
  }
  for (const key of ['lines', 'source', 'blank'] as const) {
    result[key] += entry.counts[key];
    stats[key] += entry.counts[key];
  }
  result.files++;
  result.bytes += entry.bytes;
  stats.files++;
  stats.bytes += entry.bytes;
}

/** Uses retained counts only: navigating folders never fetches source files again. */
export function folderLanguages(result: Analysis, prefix: string): LanguageStats[] {
  const groups = new Map<string, LanguageStats>();
  for (const [path, file] of Object.entries(result.fileStats)) {
    if (prefix && !path.startsWith(`${prefix}/`)) continue;
    let group = groups.get(file.language);
    if (!group) {
      group = { language: file.language, lines: 0, source: 0, blank: 0, files: 0, bytes: 0 };
      groups.set(file.language, group);
    }
    for (const key of ['lines', 'source', 'blank', 'bytes'] as const) group[key] += file[key];
    group.files++;
  }
  return [...groups.values()].sort((a, b) => b.source - a.source || b.bytes - a.bytes);
}

export async function analyzeSnapshot(
  client: GitHubClient,
  snapshot: Snapshot,
  signal: AbortSignal,
  progress: (done: number, total: number, file: string, partial: Analysis) => void,
  includeGenerated = true,
): Promise<Analysis> {
  const started = performance.now();
  const cacheGeneration = privateCacheGeneration();
  const result = createAnalysis();
  const sourceFiles: { file: TreeEntry; language: string }[] = [];
  for (const file of snapshot.files) {
    const classification = classifyFile(file, includeGenerated);
    if ('excluded' in classification) {
      result.excluded[classification.excluded]++;
      result.skipped[file.path] = classification.excluded;
    } else {
      sourceFiles.push({ file, language: classification.language });
      registerEligibleFile(result, file.path);
    }
  }
  if (sourceFiles.reduce((sum, { file }) => sum + (file.size ?? 0), 0) > 100 * 1024 * 1024) {
    throw new Error(
      'The source files exceed the 100 MB analysis limit. Paste a directory URL to analyze a smaller part of this repository.',
    );
  }
  const cached = await readCounts(
    sourceFiles.map(({ file }) => file.sha),
    !snapshot.repo.private,
  );
  signal.throwIfAborted();
  const local = new AbortController();
  const forwardAbort = () => local.abort(signal.reason);
  signal.addEventListener('abort', forwardAbort, { once: true });
  let worker: Worker | undefined;
  let id = 0;
  let done = 0;
  const pending = new Map<
    number,
    { resolve: (counts: LineCounts | null) => void; reject: (reason: unknown) => void }
  >();
  const stop = (reason: unknown) => {
    worker?.terminate();
    for (const item of pending.values()) item.reject(reason);
    pending.clear();
  };
  const abort = () => stop(local.signal.reason);
  local.signal.addEventListener('abort', abort, { once: true });
  const newCounts: CachedCount[] = [];
  const report = (path: string) => {
    result.elapsedMs = performance.now() - started;
    progress(done, sourceFiles.length, path, result);
  };
  const remaining = sourceFiles.filter(({ file, language }) => {
    const entry = cached.get(file.sha);
    if (!entry) return true;
    addFileCount(result, file.path, language, entry);
    result.cachedFiles++;
    done++;
    return false;
  });
  report('Reading cached counts…');
  if (remaining.length) {
    worker = new Worker(new URL('./counter.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ id: number; counts: LineCounts | null }>) => {
      pending.get(event.data.id)?.resolve(event.data.counts);
      pending.delete(event.data.id);
    };
    worker.onerror = () =>
      local.abort(new Error('The browser’s line-counting worker stopped. Please try again.'));
  }
  let bytesRead = 0;
  try {
    local.signal.throwIfAborted();
    await mapConcurrent(
      remaining,
      snapshot.repo.private ? 4 : 32,
      async ({ file, language }) => {
        const bytes = await client.readFile(snapshot, file, local.signal);
        local.signal.throwIfAborted();
        bytesRead += bytes.byteLength;
        if (bytesRead > 100 * 1024 * 1024)
          throw new Error(
            'The actual source files exceed the 100 MB analysis limit. Choose a smaller directory.',
          );
        const size = bytes.byteLength;
        if (size > 2 * 1024 * 1024) {
          result.excluded.large++;
          result.skipped[file.path] = 'Over 2 MB';
          for (const key of ancestors(file.path)) result.paths[key].processed++;
          done++;
          report(file.path);
          return;
        }
        const counts = await new Promise<LineCounts | null>((resolve, reject) => {
          const currentId = id++;
          pending.set(currentId, { resolve, reject });
          worker!.postMessage({ id: currentId, bytes }, [bytes.buffer]);
        });
        local.signal.throwIfAborted();
        const entry = { sha: file.sha, counts, bytes: size, used: Date.now() };
        newCounts.push(entry);
        addFileCount(result, file.path, language, entry);
        result.fetchedFiles++;
        done++;
        report(file.path);
      },
      local.signal,
    );
    result.languages.sort((a, b) => b.source - a.source || b.bytes - a.bytes);
    result.complete = true;
    report('Complete');
    return result;
  } finally {
    signal.removeEventListener('abort', forwardAbort);
    local.abort(new DOMException('Analysis finished.', 'AbortError'));
    void writeCounts(newCounts, !snapshot.repo.private, cacheGeneration);
  }
}
