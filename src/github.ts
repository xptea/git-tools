import { mapConcurrent, safeArchivePath } from './utils.ts';

export interface Repository {
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  default_branch: string;
  stargazers_count: number;
  forks_count: number;
  size: number;
  language: string | null;
  private: boolean;
  archived: boolean;
  owner: { login: string };
  license: { spdx_id: string } | null;
}
export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
  mode: string;
}
interface GitTree {
  sha: string;
  truncated: boolean;
  tree: TreeEntry[];
}
interface Commit {
  sha: string;
  commit: { tree: { sha: string } };
}
export interface ParsedInput {
  owner: string;
  repo: string;
  kind?: 'tree' | 'blob';
  tail: string[];
}
export interface Snapshot {
  repo: Repository;
  ref: string;
  sha: string;
  path: string;
  isFile: boolean;
  files: TreeEntry[];
  directories: string[];
  submodules: number;
}
export interface SearchResult {
  total_count: number;
  incomplete_results: boolean;
  items: Repository[];
}
export const SEARCH_PAGE_SIZE = 10;

export class GitHubError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function parseInput(input: string): ParsedInput {
  let value = input.trim();
  if (!value) throw new Error('Enter a GitHub repository or directory URL.');
  if (/^github\.com\//i.test(value)) value = `https://${value}`;
  let segments: string[];
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== 'github.com' || url.username || url.password || url.port)
      throw new Error('Use a link from github.com.');
    segments = url.pathname.replace(/\/$/, '').slice(1).split('/').map(decodeURIComponent);
  } else {
    segments = value.replace(/\/$/, '').split('/');
  }
  const [owner, repoName, kind, ...tail] = segments;
  const repo = repoName?.replace(/\.git$/, '');
  if (
    !owner ||
    !repo ||
    !/^[a-zA-Z0-9-]+$/.test(owner) ||
    !/^[a-zA-Z0-9_.-]+$/.test(repo) ||
    ['.', '..'].includes(repo)
  ) {
    throw new Error('Use owner/repo or a GitHub repository, folder, or file URL.');
  }
  if (kind && kind !== 'tree' && kind !== 'blob')
    throw new Error('Open the repository’s Code tab and copy a repository, folder, or file URL.');
  if (kind && !tail.length) throw new Error('The URL is missing its branch or commit.');
  if (tail.some((part) => !part || part === '.' || part === '..' || part.includes('\\')))
    throw new Error('The GitHub URL contains an invalid path.');
  return { owner, repo, kind: kind as ParsedInput['kind'], tail };
}

export function isRepositoryInput(value: string): boolean {
  return (
    /^https?:\/\//i.test(value.trim()) ||
    /^github\.com\//i.test(value.trim()) ||
    /^[\w.-]+\/[\w.-]+$/.test(value.trim())
  );
}

export class GitHubClient {
  private token = '';
  private cache = new Map<string, unknown>();
  setToken(token: string) {
    this.token = token.trim();
    this.cache.clear();
  }
  get hasToken() {
    return !!this.token;
  }

  async request<T>(path: string, signal: AbortSignal, cache = true): Promise<T> {
    signal.throwIfAborted();
    if (!path.startsWith('/repos/') && !path.startsWith('/search/'))
      throw new Error('Unsupported GitHub API path.');
    if (cache && this.cache.has(path)) return this.cache.get(path) as T;
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let response: Response;
    try {
      response = await fetch(`https://api.github.com${path}`, {
        headers,
        signal,
        credentials: 'omit',
        redirect: 'error',
      });
    } catch (error) {
      signal.throwIfAborted();
      throw new Error(
        'Could not connect to GitHub. Check your internet connection and try again.',
        { cause: error },
      );
    }
    if (!response.ok) {
      let message = '';
      try {
        message = (await response.json()).message ?? '';
      } catch {
        /* Fall back to HTTP status. */
      }
      if (response.status === 401)
        throw new GitHubError(
          'GitHub rejected the access token. Clear it or use a valid token.',
          401,
        );
      if (response.status === 404)
        throw new GitHubError(
          'Repository, branch, or path not found. Private repositories need a token with Contents read access.',
          404,
        );
      if (response.status === 403 || response.status === 429) {
        const reset = Number(response.headers.get('x-ratelimit-reset'));
        const remaining = response.headers.get('x-ratelimit-remaining');
        if (remaining === '0' || /rate limit/i.test(message) || response.status === 429) {
          const time = reset
            ? ` Try again after ${new Date(reset * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}, or add a token under GitHub access.`
            : ' Wait a moment or add a token under GitHub access.';
          throw new GitHubError(`GitHub’s request limit was reached.${time}`, response.status);
        }
        throw new GitHubError(
          'GitHub denied access. Check the token’s repository permissions.',
          response.status,
        );
      }
      throw new GitHubError(
        `GitHub returned an error (${response.status}). ${message}`,
        response.status,
      );
    }
    const data = (await response.json()) as T;
    // Bound retained API data so browsing many repositories cannot grow memory indefinitely.
    if (cache) {
      if (this.cache.size >= 30) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(path, data);
    }
    return data;
  }

  search(query: string, page: number, sort: string, signal: AbortSignal) {
    const params = new URLSearchParams({
      q: query,
      per_page: String(SEARCH_PAGE_SIZE),
      page: String(page),
    });
    if (sort) params.set('sort', sort);
    return this.request<SearchResult>(`/search/repositories?${params}`, signal, false);
  }

  private async resolveUrlRef(
    base: string,
    input: ParsedInput,
    signal: AbortSignal,
  ): Promise<{ ref: string; path: string }> {
    const prefix = input.tail[0];
    // Ref names may contain slashes. Resolve the longest matching branch or tag before interpreting the folder path.
    const refs = await Promise.all(
      ['heads', 'tags'].map((type) =>
        this.request<{ ref: string }[]>(
          `${base}/git/matching-refs/${type}/${encodeURIComponent(prefix)}`,
          signal,
        ),
      ),
    );
    const suffix = input.tail.join('/');
    const names = refs.flat().map((entry) => entry.ref.replace(/^refs\/(heads|tags)\//, ''));
    const ref = names
      .filter((name) => suffix === name || suffix.startsWith(`${name}/`))
      .sort((a, b) => b.length - a.length)[0];
    if (ref) return { ref, path: suffix.slice(ref.length).replace(/^\//, '') };
    // Commit URLs do not appear in the branch/tag listings.
    if (/^[a-f0-9]{7,40}$/i.test(prefix))
      return { ref: prefix, path: input.tail.slice(1).join('/') };
    throw new GitHubError(
      'This branch or tag was not found. Check the URL, or use a commit URL.',
      404,
    );
  }

  async load(input: ParsedInput, signal: AbortSignal, refOverride?: string): Promise<Snapshot> {
    const base = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
    const repo = await this.request<Repository>(base, signal);
    let ref = refOverride?.trim() || repo.default_branch;
    let path = '';
    if (input.kind) {
      const resolved = await this.resolveUrlRef(base, input, signal);
      ref = refOverride?.trim() || resolved.ref;
      path = resolved.path;
    }
    const commit = await this.request<Commit>(
      `${base}/commits/${encodeURIComponent(ref)}`,
      signal,
      false,
    );
    let treeSha = commit.commit.tree.sha;
    let selectedFile: TreeEntry | undefined;
    const pathParts = path ? path.split('/') : [];
    for (let i = 0; i < pathParts.length; i++) {
      const tree = await this.request<GitTree>(`${base}/git/trees/${treeSha}`, signal);
      if (tree.truncated)
        throw new Error(
          'GitHub returned an incomplete directory listing. Choose a smaller folder.',
        );
      const entry = tree.tree.find((item) => item.path === pathParts[i]);
      if (!entry)
        throw new GitHubError('This directory or file does not exist on the selected branch.', 404);
      if (entry.type === 'tree') treeSha = entry.sha;
      else if (entry.type === 'blob' && i === pathParts.length - 1) selectedFile = entry;
      else
        throw new Error(
          'This path is a submodule or is not a directory. Open the submodule’s own repository instead.',
        );
    }
    if (input.kind === 'blob' && !selectedFile)
      throw new Error('This file URL points to a directory. Use the directory’s tree URL instead.');
    let entries: TreeEntry[];
    if (selectedFile) entries = [{ ...selectedFile, path: selectedFile.path }];
    else {
      const tree = await this.request<GitTree>(`${base}/git/trees/${treeSha}?recursive=1`, signal);
      entries = tree.truncated ? await this.walkTree(base, treeSha, '', signal) : tree.tree;
    }
    for (const entry of entries) safeArchivePath(entry.path);
    const files = entries.filter((item) => item.type === 'blob');
    return {
      repo,
      ref,
      sha: commit.sha,
      path,
      isFile: !!selectedFile,
      files,
      directories: entries.filter((item) => item.type === 'tree').map((item) => item.path),
      submodules: entries.filter((item) => item.type === 'commit').length,
    };
  }

  private async walkTree(
    base: string,
    sha: string,
    prefix: string,
    signal: AbortSignal,
    depth = 0,
  ): Promise<TreeEntry[]> {
    if (depth > 100)
      throw new Error('This repository’s directory tree is too deep to load in the browser.');
    const tree = await this.request<GitTree>(`${base}/git/trees/${sha}`, signal);
    if (tree.truncated)
      throw new Error('GitHub returned an incomplete tree. Choose a smaller directory.');
    const entries = tree.tree.map((entry) => ({ ...entry, path: prefix + entry.path }));
    // Sequential subtrees keep the fallback bounded instead of multiplying pools at each tree level.
    for (const entry of [...entries]) {
      if (entry.type === 'tree')
        entries.push(
          ...(await this.walkTree(base, entry.sha, `${entry.path}/`, signal, depth + 1)),
        );
    }
    return entries;
  }

  async readFile(snapshot: Snapshot, file: TreeEntry, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    const base = `/repos/${snapshot.repo.full_name}`;
    if (snapshot.repo.private) {
      const blob = await this.request<{ encoding: string; content: string }>(
        `${base}/git/blobs/${file.sha}`,
        signal,
        false,
      );
      if (blob.encoding !== 'base64')
        throw new Error(`Unsupported GitHub blob encoding for ${file.path}.`);
      const binary = atob(blob.content.replace(/\s/g, ''));
      return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    }
    const path = snapshot.isFile
      ? snapshot.path
      : [snapshot.path, file.path].filter(Boolean).join('/');
    const url = `https://raw.githubusercontent.com/${snapshot.repo.full_name}/${snapshot.sha}/${path.split('/').map(encodeURIComponent).join('/')}`;
    let response: Response;
    try {
      response = await fetch(url, { signal, credentials: 'omit' });
    } catch (error) {
      signal.throwIfAborted();
      throw new Error(`Could not fetch ${file.path}. Check your connection and try again.`, {
        cause: error,
      });
    }
    if (!response.ok)
      throw new Error(`Could not fetch ${file.path} (GitHub returned ${response.status}).`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

export const DOWNLOAD_LIMIT = 200 * 1024 * 1024;
export const FILE_LIMIT = 50 * 1024 * 1024;

export async function downloadFiles(
  client: GitHubClient,
  snapshot: Snapshot,
  prefix: string,
  signal: AbortSignal,
  progress: (done: number, total: number, file: string) => void,
): Promise<Uint8Array> {
  const files = snapshot.files.filter((file) => !prefix || file.path.startsWith(`${prefix}/`));
  if (!files.length) throw new Error('There are no files in this directory to download.');
  if (files.some((file) => (file.size ?? 0) > FILE_LIMIT))
    throw new Error(
      'This directory contains a file larger than 50 MB. Choose a smaller directory.',
    );
  if (files.reduce((sum, file) => sum + (file.size ?? 0), 0) > DOWNLOAD_LIMIT)
    throw new Error(
      'This directory is larger than the 200 MB browser download limit. Choose a smaller directory.',
    );
  const archive: Record<string, Uint8Array> = Object.create(null);
  let done = 0;
  let actualBytes = 0;
  await mapConcurrent(
    files,
    5,
    async (file) => {
      const data = await client.readFile(snapshot, file, signal);
      actualBytes += data.byteLength;
      if (data.byteLength > FILE_LIMIT || actualBytes > DOWNLOAD_LIMIT)
        throw new Error(
          'The actual download exceeds the browser memory limit. Choose a smaller directory.',
        );
      const name = safeArchivePath(prefix ? file.path.slice(prefix.length + 1) : file.path);
      archive[name] = data;
      progress(++done, files.length, file.path);
    },
    signal,
  );
  signal.throwIfAborted();
  progress(done, files.length, 'Creating ZIP…');
  const { zip } = await import('fflate');
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      terminate();
      reject(signal.reason);
    };
    const terminate = zip(archive, { level: 6 }, (error, data) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) reject(signal.reason);
      else if (error) reject(error);
      else resolve(data);
    });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
