import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addFileCount,
  analyzeSnapshot,
  classifyFile,
  countTextLines,
  createAnalysis,
  folderLanguages,
  registerEligibleFile,
} from '../src/counter.ts';
import {
  clearPrivateCounts,
  privateCacheGeneration,
  readCounts,
  validCachedCount,
  writeCounts,
} from '../src/count-cache.ts';
import { GitHubClient } from '../src/github.ts';
import type { Snapshot } from '../src/github.ts';

test('folder totals accumulate every descendant once, including partial and empty files', () => {
  const result = createAnalysis();
  for (const path of ['src/a.ts', 'src/nested/b.ts', 'readme.md'])
    registerEligibleFile(result, path);
  addFileCount(result, 'src/a.ts', 'TypeScript', {
    sha: 'one',
    bytes: 20,
    counts: { lines: 5, source: 4, blank: 1 },
    used: 1,
  });
  assert.equal(result.paths.src.source, 4);
  assert.equal(result.paths.src.processed, 1);
  assert.equal(result.paths.src.eligible, 2);
  addFileCount(result, 'src/nested/b.ts', 'TypeScript', {
    sha: 'two',
    bytes: 0,
    counts: { lines: 0, source: 0, blank: 0 },
    used: 1,
  });
  assert.equal(result.paths.src.processed, 2);
  assert.equal(result.paths['src/nested'].files, 1);
  addFileCount(result, 'readme.md', 'Markdown', { sha: 'three', bytes: 4, counts: null, used: 1 });
  assert.equal(result.paths[''].source, result.source);
  assert.equal(result.paths[''].processed, 3);
  assert.equal(result.excluded.binary, 1);
  assert.equal(result.skipped['readme.md'], 'Binary or non-UTF-8');
});

test('all-text mode includes lockfiles, SVG, generated files, and unfamiliar text extensions', () => {
  assert.deepEqual(classifyFile({ path: 'Cargo.lock' }, true), { language: 'Lockfile' });
  assert.deepEqual(classifyFile({ path: 'theme/icon.svg' }, true), { language: 'SVG' });
  assert.deepEqual(classifyFile({ path: 'build/file.generated.ts' }, true), {
    language: 'TypeScript',
  });
  assert.deepEqual(classifyFile({ path: 'some/custom.unknown' }, true), { language: 'Other text' });
  assert.deepEqual(classifyFile({ path: 'assets/photo.png' }, true), { excluded: 'unsupported' });
});

test('folder languages include descendants and empty files but exclude sibling prefixes and binaries', () => {
  const result = createAnalysis();
  const files = [
    ['src/main.rs', 'Rust', 6],
    ['src/nested/extra.rs', 'Rust', 4],
    ['src/readme.md', 'Markdown', 2],
    ['src/empty.rs', 'Rust', 0],
    ['src-other/main.ts', 'TypeScript', 20],
    ['README.md', 'Markdown', 3],
    ['src/binary.txt', 'Text', null],
  ] as const;
  for (const [path, language, lines] of files) {
    registerEligibleFile(result, path);
    addFileCount(result, path, language, {
      sha: path,
      bytes: lines ?? 1,
      counts: lines === null ? null : { lines, source: lines, blank: 0 },
      used: 1,
    });
  }
  const folder = folderLanguages(result, 'src');
  assert.deepEqual(
    folder.map(({ language, source, files }) => ({ language, source, files })),
    [
      { language: 'Rust', source: 10, files: 3 },
      { language: 'Markdown', source: 2, files: 1 },
    ],
  );
  assert.equal(
    folder.reduce((sum, language) => sum + language.source, 0),
    result.paths.src.source,
  );
  assert.equal(folderLanguages(result, 'src/nested')[0].source, 4);
  assert.deepEqual(folderLanguages(result, 'missing'), []);
  assert.equal(
    folderLanguages(result, '').reduce((sum, language) => sum + language.source, 0),
    result.source,
  );
});

test('private count caches are separate from public ones and invalidated on token changes', async () => {
  const entry = {
    sha: 'cache-test',
    bytes: 5,
    counts: { lines: 1, source: 1, blank: 0 },
    used: Date.now(),
  };
  const generation = privateCacheGeneration();
  await writeCounts([entry], false, generation);
  assert.equal((await readCounts([entry.sha], false)).size, 1);
  assert.equal((await readCounts([entry.sha], true)).size, 0);
  clearPrivateCounts();
  await writeCounts([entry], false, generation);
  assert.equal((await readCounts([entry.sha], false)).size, 0);
  assert.ok(validCachedCount(entry));
  assert.equal(validCachedCount({ ...entry, counts: { lines: 3, source: 5, blank: 0 } }), false);
});

test('analysis fetches public files concurrently, streams counts, and reuses unchanged blob counts', async () => {
  let workers = 0;
  class TestWorker {
    onmessage?: (event: {
      data: { id: number; counts: ReturnType<typeof countTextLines> };
    }) => void;
    onerror?: () => void;
    stopped = false;
    constructor() {
      workers++;
    }
    postMessage(data: { id: number; bytes: Uint8Array }) {
      queueMicrotask(() => {
        if (!this.stopped)
          this.onmessage?.({ data: { id: data.id, counts: countTextLines(data.bytes) } });
      });
    }
    terminate() {
      this.stopped = true;
    }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: TestWorker });
  try {
    const snapshot: Snapshot = {
      repo: {
        name: 'fixture',
        full_name: 'tests/fixture',
        description: '',
        html_url: 'https://github.com/tests/fixture',
        default_branch: 'main',
        stargazers_count: 0,
        forks_count: 0,
        size: 1,
        language: 'Rust',
        private: false,
        archived: false,
        owner: { login: 'tests' },
        license: null,
      },
      sha: 'revision-one',
      ref: 'main',
      path: '',
      isFile: false,
      directories: ['src'],
      submodules: 0,
      files: Array.from({ length: 64 }, (_, i) => ({
        path: `src/${i}.rs`,
        sha: `analysis-blob-${i}`,
        type: 'blob',
        size: 12,
        mode: '100644',
      })),
    };
    let fetched = 0;
    let active = 0;
    let peak = 0;
    let partial = false;
    const client = new GitHubClient();
    client.readFile = async (_snapshot, _file, signal) => {
      fetched++;
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      signal.throwIfAborted();
      return new TextEncoder().encode('hello\n\n// hi\n');
    };
    const result = await analyzeSnapshot(
      client,
      snapshot,
      new AbortController().signal,
      (done, total, _file, current) => {
        if (done > 0 && done < total) {
          partial = true;
          assert.ok(current.source > 0);
          assert.equal(current.complete, false);
        }
      },
    );
    assert.ok(partial);
    assert.equal(fetched, 64);
    assert.equal(peak, 32);
    assert.equal(result.source, 128);
    assert.equal(result.paths.src.source, 128);
    assert.equal(result.paths.src.processed, 64);
    assert.equal(result.complete, true);
    const repeated = await analyzeSnapshot(
      client,
      snapshot,
      new AbortController().signal,
      () => {},
    );
    assert.equal(fetched, 64);
    assert.equal(repeated.cachedFiles, 64);
    assert.equal(repeated.fetchedFiles, 0);
    assert.equal(workers, 1);
    assert.equal(repeated.source, result.source);
    snapshot.sha = 'revision-two';
    snapshot.files[0].sha = 'changed-analysis-blob';
    const changed = await analyzeSnapshot(client, snapshot, new AbortController().signal, () => {});
    assert.equal(fetched, 65);
    assert.equal(changed.cachedFiles, 63);
    assert.equal(changed.fetchedFiles, 1);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      analyzeSnapshot(client, snapshot, controller.signal, () => {}),
      { name: 'AbortError' },
    );
  } finally {
    if (previous) Object.defineProperty(globalThis, 'Worker', previous);
    else Reflect.deleteProperty(globalThis, 'Worker');
  }
});
