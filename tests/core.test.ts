import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInput, GitHubClient, downloadFiles, DOWNLOAD_LIMIT } from '../src/github.ts';
import type { Snapshot } from '../src/github.ts';
import { classifyFile, countTextLines } from '../src/counter.ts';
import { safeArchivePath, escapeHtml, mapConcurrent } from '../src/utils.ts';
import { unzipSync, strFromU8 } from 'fflate';

test('GitHub input accepts repository, encoded branch and folder links, and rejects other hosts', () => {
  assert.deepEqual(parseInput('octocat/Hello-World.git'), {
    owner: 'octocat',
    repo: 'Hello-World',
    kind: undefined,
    tail: [],
  });
  assert.deepEqual(
    parseInput('https://github.com/acme/code/tree/feature%2Ftools/src/hello%20world?tab=readme'),
    { owner: 'acme', repo: 'code', kind: 'tree', tail: ['feature/tools', 'src', 'hello world'] },
  );
  for (const input of [
    'https://evil.example/acme/code',
    'https://github.com.evil.example/acme/code',
    'https://user:pass@github.com/acme/code',
    'https://github.com/acme/code/issues',
    'not a repo',
    'acme/..',
  ])
    assert.throws(() => parseInput(input));
});

test('line counts handle empty files, final newlines, CRLF, blank lines, and comments honestly', () => {
  const bytes = (value: string) => new TextEncoder().encode(value);
  assert.deepEqual(countTextLines(bytes('')), { lines: 0, source: 0, blank: 0 });
  assert.deepEqual(countTextLines(bytes('hello\n')), { lines: 1, source: 1, blank: 0 });
  assert.deepEqual(countTextLines(bytes('\n')), { lines: 1, source: 0, blank: 1 });
  assert.deepEqual(countTextLines(bytes('// comment\r\n \t\r\nconst x = 1;')), {
    lines: 3,
    source: 2,
    blank: 1,
  });
  assert.equal(countTextLines(new Uint8Array([0, 1, 2])), null);
  assert.equal(countTextLines(new Uint8Array([255, 254])), null);
});

test('analysis excludes dependencies, build files, lockfiles, binaries and large source files', () => {
  for (const path of [
    'node_modules/a/index.js',
    'target/debug/file.rs',
    'package-lock.json',
    'src/app.min.js',
    'src/file.generated.ts',
  ])
    assert.deepEqual(classifyFile({ path }), { excluded: 'generated' });
  assert.deepEqual(classifyFile({ path: 'src/app.ts' }), { language: 'TypeScript' });
  assert.deepEqual(classifyFile({ path: 'Dockerfile' }), { language: 'Dockerfile' });
  assert.deepEqual(classifyFile({ path: 'photo.png' }), { excluded: 'unsupported' });
  assert.deepEqual(classifyFile({ path: 'src/large.ts', size: 3 * 1024 * 1024 }), {
    excluded: 'large',
  });
});

test('archive paths cannot escape the selected directory, and UI text is escaped', () => {
  for (const path of ['../secret', '/absolute', 'dir/../secret', 'a\\b', 'dir//file', 'file\0name'])
    assert.throws(() => safeArchivePath(path));
  assert.equal(safeArchivePath('src/hello world.ts'), 'src/hello world.ts');
  assert.equal(escapeHtml('<img onerror="x">&'), '&lt;img onerror=&quot;x&quot;&gt;&amp;');
});

test('concurrency is bounded and cancellation stops subsequent requests', async () => {
  let active = 0;
  let maximum = 0;
  const result = await mapConcurrent([1, 2, 3, 4, 5], 2, async (value) => {
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return value * 2;
  });
  assert.deepEqual(result, [2, 4, 6, 8, 10]);
  assert.equal(maximum, 2);
  const canceled = new AbortController();
  canceled.abort();
  await assert.rejects(
    mapConcurrent([1], 2, async () => 1, canceled.signal),
    { name: 'AbortError' },
  );
});

const fixture = (): Snapshot => ({
  repo: {
    name: 'code',
    full_name: 'acme/code',
    description: '',
    html_url: 'https://github.com/acme/code',
    default_branch: 'main',
    stargazers_count: 1,
    forks_count: 0,
    size: 1,
    language: 'TypeScript',
    private: false,
    archived: false,
    owner: { login: 'acme' },
    license: null,
  },
  ref: 'main',
  sha: 'commit',
  path: '',
  isFile: false,
  directories: ['src', 'other'],
  submodules: 0,
  files: [
    { path: 'src/index.ts', type: 'blob', sha: 'a', size: 5, mode: '100644' },
    { path: 'src/nested/helper.ts', type: 'blob', sha: 'b', size: 5, mode: '100644' },
    { path: 'other/secret.ts', type: 'blob', sha: 'c', size: 5, mode: '100644' },
  ],
});

test('ZIP contains only the selected folder, preserves nested paths, and refuses oversized downloads', async () => {
  const client = new GitHubClient();
  const requested: string[] = [];
  client.readFile = async (_snapshot, file) => {
    requested.push(file.path);
    return new TextEncoder().encode('hello');
  };
  const zip = await downloadFiles(client, fixture(), 'src', new AbortController().signal, () => {});
  const entries = unzipSync(zip);
  assert.deepEqual(Object.keys(entries).sort(), ['index.ts', 'nested/helper.ts']);
  assert.equal(strFromU8(entries['nested/helper.ts']), 'hello');
  assert.deepEqual(requested.sort(), ['src/index.ts', 'src/nested/helper.ts']);
  const huge = fixture();
  huge.files[0].size = DOWNLOAD_LIMIT + 1;
  await assert.rejects(
    downloadFiles(client, huge, '', new AbortController().signal, () => {}),
    /larger than 50 MB/,
  );
});

test('slash-containing refs resolve to the longest branch and files pin to a commit', async () => {
  const client = new GitHubClient();
  const requested: string[] = [];
  client.request = async <T>(path: string): Promise<T> => {
    requested.push(path);
    if (path === '/repos/acme/code') return fixture().repo as T;
    if (path.includes('matching-refs/heads'))
      return [{ ref: 'refs/heads/feature' }, { ref: 'refs/heads/feature/tools' }] as T;
    if (path.includes('matching-refs/tags')) return [] as T;
    if (path.includes('/commits/'))
      return { sha: 'pinned', commit: { tree: { sha: 'root' } } } as T;
    if (path.endsWith('/git/trees/root'))
      return { truncated: false, tree: [{ path: 'src', type: 'tree', sha: 'source' }] } as T;
    if (path.endsWith('/git/trees/source?recursive=1'))
      return {
        truncated: false,
        tree: [{ path: 'app.ts', type: 'blob', sha: 'app', size: 10, mode: '100644' }],
      } as T;
    throw new Error(`Unexpected request: ${path}`);
  };
  const snapshot = await client.load(
    parseInput('https://github.com/acme/code/tree/feature/tools/src'),
    new AbortController().signal,
  );
  assert.equal(snapshot.ref, 'feature/tools');
  assert.equal(snapshot.path, 'src');
  assert.equal(snapshot.sha, 'pinned');
  assert.ok(requested.includes('/repos/acme/code/commits/feature%2Ftools'));
  assert.deepEqual(
    snapshot.files.map((file) => file.path),
    ['app.ts'],
  );
});

test('truncated recursive trees are traversed completely instead of returning partial counts', async () => {
  const client = new GitHubClient();
  client.request = async <T>(path: string): Promise<T> => {
    if (path === '/repos/acme/code') return fixture().repo as T;
    if (path.includes('/commits/'))
      return { sha: 'pinned', commit: { tree: { sha: 'root' } } } as T;
    if (path.endsWith('/git/trees/root?recursive=1')) return { truncated: true, tree: [] } as T;
    if (path.endsWith('/git/trees/root'))
      return {
        truncated: false,
        tree: [
          { path: 'src', type: 'tree', sha: 'source' },
          { path: 'README.md', type: 'blob', sha: 'readme' },
        ],
      } as T;
    if (path.endsWith('/git/trees/source'))
      return { truncated: false, tree: [{ path: 'app.ts', type: 'blob', sha: 'app' }] } as T;
    throw new Error(`Unexpected request: ${path}`);
  };
  const snapshot = await client.load(parseInput('acme/code'), new AbortController().signal);
  assert.deepEqual(snapshot.files.map((file) => file.path).sort(), ['README.md', 'src/app.ts']);
});
