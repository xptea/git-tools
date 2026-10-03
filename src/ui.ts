import {
  GitHubClient,
  downloadFiles,
  isRepositoryInput,
  parseInput,
  SEARCH_PAGE_SIZE,
} from './github.ts';
import type { Repository, Snapshot } from './github.ts';
import { analyzeSnapshot, folderLanguages } from './counter.ts';
import type { Analysis } from './counter.ts';
import { escapeHtml as escape, formatBytes, formatNumber as number, saveBlob } from './utils.ts';
import { registerBrowserTools } from './webmcp.ts';
import { clearPrivateCounts } from './count-cache.ts';
import { refreshIcons } from './icons.ts';

type Area = 'download' | 'explore';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const icon = (name: string) => `<i data-lucide="${name}"></i>`;

export function initializeTools() {
  const client = new GitHubClient();
  const controllers: Partial<Record<Area, AbortController>> = {};
  let directory: Snapshot | undefined;
  let repository: Snapshot | undefined;
  let analysis: Analysis | undefined;
  let directoryPrefix = '';
  let repositoryPrefix = '';
  let lastQuery = '';
  let page = 1;
  let sort = '';
  let counting = false;
  let includeGenerated = true;
  let allLanguages = false;
  const countColors = ['#818cf8', '#60a5fa', '#2dd4bf', '#c084fc', '#fbbf24', '#fb7185'];

  function compactExplorer() {
    $('explore-workspace').classList.add('is-compact');
    $('main').classList.toggle('exploring', location.hash === '#explore');
  }

  function status(area: Area, message: string, percent?: number) {
    const busy = !!controllers[area];
    const existing = $(`${area}-status`).querySelector<HTMLElement>('[data-status-message]');
    if (busy && existing && $(`${area}-status`).querySelector('[data-cancel]')) {
      existing.textContent = message;
      const bar = $(`${area}-status`).querySelector<HTMLProgressElement>('progress');
      if (bar && percent !== undefined) {
        bar.hidden = false;
        bar.value = percent;
      }
      return;
    }
    $(`${area}-status`).innerHTML = /* HTML */ `<div class="notice flex items-center gap-3">
      ${icon(busy ? 'loader-circle' : 'check')}
      <div class="min-w-0 flex-1">
        <p class="break-words" data-status-message>${escape(message)}</p>
        <progress
          class="mt-2 h-1.5 w-full accent-neutral-300"
          max="100"
          value="${percent ?? 0}"
          aria-label="Progress"
          ${percent === undefined ? 'hidden' : ''}
        ></progress>
      </div>
      ${busy ? `<button class="secondary !p-2" type="button" data-cancel="${area}" aria-label="Cancel operation">${icon('x')}</button>` : ''}
    </div>`;
    refreshIcons();
    if (busy) $(`${area}-status`).querySelector('.lucide-loader-circle')?.classList.add('spinner');
  }

  function error(area: Area, cause: unknown) {
    $(`${area}-status`).innerHTML = /* HTML */ `<div
      class="notice border-red-900/50 text-red-200"
      role="alert"
    >
      ${escape(cause instanceof Error ? cause.message : 'Something went wrong. Please try again.')}
    </div>`;
  }

  async function task<T>(
    area: Area,
    message: string,
    job: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    controllers[area]?.abort();
    const controller = new AbortController();
    controllers[area] = controller;
    const formId = area === 'download' ? 'download-form' : 'search-form';
    $(formId)
      .querySelectorAll<HTMLButtonElement>('button[type="submit"]')
      .forEach((button) => {
        button.disabled = true;
      });
    status(area, message);
    try {
      const value = await job(controller.signal);
      controller.signal.throwIfAborted();
      if (controllers[area] === controller) {
        delete controllers[area];
        $(`${area}-status`).innerHTML = '';
      }
      return value;
    } catch (cause) {
      if (controllers[area] === controller) {
        delete controllers[area];
        if (controller.signal.aborted)
          status(area, 'Canceled. You can try again when you’re ready.');
        else {
          controller.abort();
          error(area, cause);
        }
      }
      return undefined;
    } finally {
      if (!controllers[area])
        $(formId)
          .querySelectorAll<HTMLButtonElement>('button[type="submit"]')
          .forEach((button) => {
            button.disabled = false;
          });
    }
  }

  function repoHeader(snapshot: Snapshot) {
    const repo = snapshot.repo;
    return /* HTML */ `<div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="break-words text-lg font-semibold">${escape(repo.full_name)}</h2>
          <p class="mt-1 break-words text-sm text-muted">
            ${escape(snapshot.path || snapshot.ref)}
          </p>
        </div>
        <a
          class="secondary !p-2"
          href="${escape(repo.html_url)}"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open ${escape(repo.full_name)} on GitHub"
          >${icon('external-link')}</a
        >
      </div>
      <div class="mt-3 flex flex-wrap gap-2">
        <span class="badge">${icon('git-branch')}${escape(snapshot.ref)}</span
        ><span class="badge font-mono">${snapshot.sha.slice(0, 7)}</span
        >${repo.private ? '<span class="badge">Private</span>' : ''}${repo.archived ? '<span class="badge">Archived</span>' : ''}
      </div>`;
  }

  function browser(snapshot: Snapshot, prefix: string, area: Area) {
    const base = prefix ? `${prefix}/` : '';
    const folders = snapshot.directories
      .filter((path) => path.startsWith(base) && !path.slice(base.length).includes('/'))
      .sort();
    const files = snapshot.files
      .filter((file) => file.path.startsWith(base) && !file.path.slice(base.length).includes('/'))
      .sort((a, b) => a.path.localeCompare(b.path));
    const shown = [
      ...folders.map((path) => ({ path, folder: true, size: 0 })),
      ...files.map((file) => ({ path: file.path, folder: false, size: file.size ?? 0 })),
    ].slice(0, 200);
    const parent = prefix.split('/').slice(0, -1).join('/');
    const rowCounts = (path: string) =>
      area === 'explore'
        ? `<span class="shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-muted" data-path-count="${escape(path)}">${pathCount(path)}</span>`
        : '';
    const fill = (path: string) =>
      area === 'explore'
        ? `<span class="row-fill" aria-hidden="true" data-path-fill="${escape(path)}" style="width:${pathShare(path)}%;background:${pathColor(path)}"></span>`
        : '';
    const rowClass = area === 'explore' ? 'result-row count-row' : 'result-row';
    return /* HTML */ `<div
      class="${area === 'explore' ? 'directory-list' : 'overflow-hidden rounded-2xl border border-line'}"
    >
      <div
        class="${area === 'explore' ? 'directory-heading' : 'flex min-w-0 items-center gap-2 border-b border-line bg-raised/50 px-4 py-3 text-sm'}"
      >
        ${prefix ? `<button type="button" class="secondary !p-1" data-browse="${area}" data-prefix="${escape(parent)}" aria-label="Go up one directory">${icon('chevron-left')}</button>` : icon('folder')}<span
          class="min-w-0 flex-1 break-words font-mono text-xs"
          >${escape(prefix || snapshot.path || '/')}</span
        >${area === 'explore' ? '<span class="text-xs text-muted" title="Percentage of source lines in this directory">Lines · % of folder</span>' : ''}
      </div>
      ${shown.map((item) => (item.folder ? `<button type="button" class="${rowClass}" data-browse="${area}" data-prefix="${escape(item.path)}">${fill(item.path)}${icon('folder')}<span class="min-w-0 flex-1 break-words">${escape(item.path.slice(base.length))}</span>${rowCounts(item.path)}${icon('chevron-right')}</button>` : `<a class="${rowClass}" href="https://github.com/${escape(snapshot.repo.full_name)}/blob/${snapshot.sha}/${(snapshot.isFile ? snapshot.path : [snapshot.path, item.path].filter(Boolean).join('/')).split('/').map(encodeURIComponent).join('/')}" target="_blank" rel="noopener noreferrer">${fill(item.path)}${icon('file')}<span class="min-w-0 flex-1 break-words">${escape(item.path.slice(base.length))}</span><span class="shrink-0 text-xs text-muted ${area === 'explore' ? 'hidden sm:inline' : ''}">${formatBytes(item.size)}</span>${rowCounts(item.path)}</a>`)).join('')}${!shown.length ? '<p class="p-4 text-sm text-muted">This directory has no regular files.</p>' : ''}${folders.length + files.length > 200 ? '<p class="border-t border-line p-3 text-xs text-muted">Showing the first 200 entries. Downloads and counts still include every file.</p>' : ''}
    </div>`;
  }

  function pathColor(path: string) {
    let hash = 0;
    for (const char of path) hash = (hash * 31 + char.charCodeAt(0)) | 0;
    return countColors[(hash >>> 0) % countColors.length];
  }

  function pathShare(path: string) {
    if (!analysis || analysis.skipped[path]) return 0;
    const total = analysis.paths[repositoryPrefix]?.source ?? 0;
    return total ? Math.min(100, ((analysis.paths[path]?.source ?? 0) / total) * 100) : 0;
  }

  function pathCount(path: string) {
    if (!analysis) return 'Not counted';
    if (analysis.skipped[path])
      return /* HTML */ `<span title="${escape(analysis.skipped[path])}">Excluded</span>`;
    const stats = analysis.paths[path];
    if (!stats?.eligible) return 'Excluded';
    if (!stats.processed) return counting ? 'Counting…' : 'Pending';
    const partial = stats.processed < stats.eligible;
    return /* HTML */ `<span class="text-ink">${number(stats.source)}${partial ? '+' : ''}</span>
      <span>(${pathShare(path).toFixed(1)}%)</span>`;
  }

  function updatePathCounts() {
    $('repository-result')
      .querySelectorAll<HTMLElement>('[data-path-count]')
      .forEach((node) => {
        node.innerHTML = pathCount(node.dataset.pathCount!);
      });
    $('repository-result')
      .querySelectorAll<HTMLElement>('[data-path-fill]')
      .forEach((node) => {
        node.style.width = `${pathShare(node.dataset.pathFill!)}%`;
      });
  }

  function renderDirectory() {
    if (!directory) return;
    const files = directory.files.filter(
      (file) => !directoryPrefix || file.path.startsWith(`${directoryPrefix}/`),
    );
    const size = files.reduce((sum, file) => sum + (file.size ?? 0), 0);
    $('directory-result').innerHTML = /* HTML */ `<div class="panel p-5 sm:p-6">
      ${repoHeader(directory)}
      <div class="my-5 flex flex-wrap items-center justify-between gap-3">
        <p class="text-sm text-muted">
          ${number(files.length)} ${files.length === 1 ? 'file' : 'files'}
          <span class="mx-2 text-neutral-600">·</span> ${formatBytes(size)}
        </p>
        <button class="primary" type="button" data-zip="download" ${files.length ? '' : 'disabled'}>
          ${icon('download')}Download ZIP
        </button>
      </div>
      ${browser(directory, directoryPrefix, 'download')}${directory.submodules ? `<p class="mt-4 text-xs leading-relaxed text-muted">${number(directory.submodules)} submodule${directory.submodules === 1 ? '' : 's'} excluded. Submodules belong to separate repositories.</p>` : ''}
      <p class="mt-4 text-xs leading-relaxed text-muted">
        Includes nested folders. ZIP creation happens locally.
      </p>
    </div>`;
    refreshIcons();
  }

  async function findDirectory(value: string) {
    directory = undefined;
    directoryPrefix = '';
    $('directory-result').innerHTML = '';
    const loaded = await task('download', 'Finding your directory…', (signal) =>
      client.load(parseInput(value), signal),
    );
    if (loaded) {
      directory = loaded;
      renderDirectory();
    }
    return loaded;
  }

  function stat(label: string, value: string, hint: string) {
    return /* HTML */ `<div class="stat">
      <p class="text-xs text-muted">${label}</p>
      <p class="mt-2 break-words text-2xl font-semibold tracking-tight">${value}</p>
      <p class="mt-1 text-xs leading-relaxed text-muted">${hint}</p>
    </div>`;
  }

  function statsMarkup(snapshot: Snapshot) {
    const partial = analysis && !analysis.complete ? '+' : '';
    const bytes = snapshot.files.reduce((sum, file) => sum + (file.size ?? 0), 0);
    return `${stat('Source lines', analysis ? number(analysis.source) + partial : 'Not counted', 'Non-empty; includes comments')}${stat('Total lines', analysis ? number(analysis.lines) + partial : 'Not counted', analysis ? `${number(analysis.blank)} blank lines` : 'Counted in your browser')}${stat('Files', number(snapshot.files.length), analysis ? `${number(analysis.files)} text files counted` : 'In the selected Git tree')}${stat('File size', formatBytes(bytes), 'Current files, without history')}`;
  }

  function breakdownMarkup() {
    const languages = analysis ? folderLanguages(analysis, repositoryPrefix) : [];
    const visible = allLanguages ? languages : languages.slice(0, 8);
    const folder = analysis?.paths[repositoryPrefix];
    const partial = folder && folder.processed < folder.eligible;
    const folderPath = [repository?.path, repositoryPrefix].filter(Boolean).join('/') || '/';
    const excluded = analysis
      ? Object.keys(analysis.skipped).filter(
          (path) => !repositoryPrefix || path.startsWith(`${repositoryPrefix}/`),
        ).length
      : 0;
    return /* HTML */ `<div class="mb-3 flex min-h-8 items-center">
        <h3 class="font-semibold">Source breakdown</h3>
      </div>
      <div class="directory-list">
        <div class="directory-heading">
          <span class="min-w-0 flex-1 break-words font-mono text-xs">${escape(folderPath)}</span
          ><span class="shrink-0 text-muted"
            >${analysis ? `${number(folder?.source ?? 0)}${partial ? '+' : ''} lines` : 'Not counted'}</span
          >
        </div>
        ${
          languages.length
            ? `<table class="w-full text-left text-xs" aria-label="Source languages in ${escape(folderPath)}"><thead class="text-muted"><tr><th class="px-3 py-2 font-normal">Language</th><th class="px-2 py-2 text-right font-normal">Files</th><th class="px-2 py-2 text-right font-normal">Lines</th><th class="px-3 py-2 text-right font-normal">Share</th></tr></thead><tbody>${visible
                .map((lang) => {
                  const share = folder?.source ? (lang.source / folder.source) * 100 : 0;
                  const color = pathColor(lang.language);
                  return /* HTML */ `<tr
                    class="border-t border-line"
                    style="background:linear-gradient(to right,${color}26 ${share}%,transparent ${share}%)"
                  >
                    <td class="px-3 py-2">
                      <span
                        class="mr-2 inline-block size-2 rounded-sm"
                        style="background:${color}"
                      ></span
                      >${escape(lang.language)}
                    </td>
                    <td class="px-2 py-2 text-right tabular-nums text-muted">
                      ${number(lang.files)}
                    </td>
                    <td class="px-2 py-2 text-right tabular-nums">${number(lang.source)}</td>
                    <td class="px-3 py-2 text-right tabular-nums text-muted">
                      ${share.toFixed(1)}%
                    </td>
                  </tr>`;
                })
                .join('')}</tbody></table>`
            : `<p class="p-4 text-xs text-muted">${!analysis ? 'Text lines are counted locally as files arrive.' : partial ? 'Counting this folder…' : 'No supported text files in this folder.'}</p>`
        }
      </div>
      ${languages.length > 8 ? `<button type="button" id="toggle-languages" class="text-button mt-2 text-xs">${allLanguages ? 'Show fewer languages' : `Show all ${languages.length} languages`}</button>` : ''}
      <p class="mt-2 text-xs leading-relaxed text-muted">
        Non-empty lines, including
        comments.${analysis ? ` ${number(folder?.files ?? 0)} text files · ${number(excluded)} excluded in this folder.` : ''}
      </p>
      <label class="mt-2 flex items-center gap-2 text-xs text-muted"
        ><input
          id="include-generated"
          type="checkbox"
          class="accent-neutral-300"
          ${includeGenerated ? 'checked' : ''}
          ${counting ? 'disabled' : ''}
        />Include generated files & lockfiles</label
      >${analysis ? `<p class="mt-2 text-xs text-muted">${analysis.complete ? `Repository scan: ${(analysis.elapsedMs / 1000).toFixed(1)}s · ${number(analysis.cachedFiles)} files cached` : 'Live totals · + means counting is incomplete.'}</p>` : ''}`;
  }

  function updateAnalysis() {
    if (!repository || !$('repo-stats')) return;
    $('repo-stats').innerHTML = statsMarkup(repository);
    $('source-breakdown').innerHTML = breakdownMarkup();
    updatePathCounts();
    refreshIcons();
  }

  function renderRepository() {
    if (!repository) return;
    const snapshot = repository;
    const repo = snapshot.repo;
    $('repository-summary').hidden = false;
    $('repository-summary').innerHTML = /* HTML */ `<div
        class="flex min-w-0 items-start justify-between gap-3"
      >
        <div class="min-w-0">
          <h2 class="break-words text-base font-semibold">${escape(repo.full_name)}</h2>
          ${repo.description ? `<p class="mt-1 text-sm leading-relaxed text-muted">${escape(repo.description)}</p>` : ''}
        </div>
        <a
          class="secondary shrink-0 !p-2"
          href="${escape(repo.html_url)}"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open ${escape(repo.full_name)} on GitHub"
          >${icon('external-link')}</a
        >
      </div>
      <div class="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div class="flex flex-wrap items-center gap-3 text-xs text-muted">
          <span class="inline-flex items-center gap-1"
            >${icon('star')}${number(repo.stargazers_count)}</span
          ><span class="inline-flex items-center gap-1"
            >${icon('git-fork')}${number(repo.forks_count)}</span
          >${repo.license && repo.license.spdx_id !== 'NOASSERTION' ? `<span>${escape(repo.license.spdx_id)}</span>` : ''}<span
            class="font-mono"
            title="Commit"
            >${snapshot.sha.slice(0, 7)}</span
          >${repo.private ? '<span class="badge">Private</span>' : ''}${repo.archived ? '<span class="badge">Archived</span>' : ''}${snapshot.path ? `<span class="break-all font-mono">${escape(snapshot.path)}</span>` : ''}
        </div>
        <form
          id="ref-form"
          class="flex min-w-0 flex-1 basis-full items-center gap-2 sm:max-w-xs sm:basis-0"
        >
          <label for="repository-ref" class="sr-only">Branch / tag / commit</label
          >${icon('git-branch')}<input
            id="repository-ref"
            class="input min-w-0 flex-1 !py-1.5 !text-sm"
            aria-label="Branch / tag / commit"
            placeholder="Branch / tag / commit"
            value="${escape(snapshot.ref)}"
            required
          /><button class="secondary !px-3 !py-1.5 !text-xs" type="submit">Load</button>
        </form>
      </div>`;
    $('repository-result').innerHTML = /* HTML */ `<div
        id="repo-stats"
        class="grid grid-cols-2 gap-3 sm:grid-cols-4"
      >
        ${statsMarkup(snapshot)}
      </div>
      <div class="analysis-grid">
        <div class="analysis-section">
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 class="font-semibold">Files & directories</h3>
            <button
              class="secondary"
              type="button"
              data-zip="explore"
              ${snapshot.files.length ? '' : 'disabled'}
            >
              ${icon('download')}Download ${repositoryPrefix ? 'folder' : 'ZIP'}
            </button>
          </div>
          ${browser(snapshot, repositoryPrefix, 'explore')}
          <p class="mt-2 text-xs leading-relaxed text-muted">
            Row width = 100% of this folder’s counted
            lines.${snapshot.submodules ? ` ${number(snapshot.submodules)} submodules excluded.` : ''}
          </p>
          <p class="mt-1 text-xs text-muted">
            GitHub storage: ${formatBytes(snapshot.repo.size * 1024)}, including history.
          </p>
        </div>
        <div id="source-breakdown" class="analysis-section">${breakdownMarkup()}</div>
      </div>`;
    refreshIcons();
  }

  async function loadRepository(value: string, ref?: string, autoCount = true) {
    compactExplorer();
    $('search-results').innerHTML = '';
    counting = false;
    analysis = undefined;
    repository = undefined;
    repositoryPrefix = '';
    $('repository-result').innerHTML = '';
    $('repository-summary').innerHTML = '';
    $('repository-summary').hidden = true;
    const loaded = await task('explore', 'Reading the repository’s file tree…', (signal) =>
      client.load(parseInput(value), signal, ref),
    );
    if (loaded) {
      repository = loaded;
      renderRepository();
      if (autoCount) void countLines();
    }
    return loaded;
  }

  async function countLines() {
    if (!repository || counting) return;
    const snapshot = repository;
    counting = true;
    analysis = undefined;
    updateAnalysis();
    let lastPaint = 0;
    const result = await task(
      'explore',
      'Fetching text files in parallel and counting locally…',
      (signal) =>
        analyzeSnapshot(
          client,
          snapshot,
          signal,
          (done, total, file, partial) => {
            if (signal.aborted || repository !== snapshot) return;
            analysis = partial;
            // Avoid rebuilding icons and tables once per file in a large repository.
            const now = performance.now();
            if (now - lastPaint >= 200 || done === total) {
              lastPaint = now;
              status(
                'explore',
                `Counting ${number(done)} / ${number(total)} files · ${file}`,
                total ? (done / total) * 100 : 100,
              );
              updateAnalysis();
            }
          },
          includeGenerated,
        ),
    );
    if (repository === snapshot) {
      counting = false;
      if (result) analysis = result;
      updateAnalysis();
    }
    return result;
  }

  function searchCard(repo: Repository) {
    return /* HTML */ `<article class="panel p-5">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <button
          type="button"
          class="min-w-0 break-words text-left text-base font-semibold hover:underline underline-offset-4"
          data-repository="${escape(repo.full_name)}"
        >
          ${escape(repo.full_name)}
        </button>
      </div>
      <p class="mt-2 line-clamp-2 text-sm leading-relaxed text-muted">
        ${escape(repo.description ?? 'No description provided.')}
      </p>
      <div class="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap gap-3 text-xs text-muted">
          <span class="inline-flex items-center gap-1"
            >${icon('star')}${number(repo.stargazers_count)}</span
          >${repo.language ? `<span>${escape(repo.language)}</span>` : ''}${repo.archived ? '<span>Archived</span>' : ''}
        </div>
        <button type="button" class="text-button" data-repository="${escape(repo.full_name)}">
          Inspect repository
        </button>
      </div>
    </article>`;
  }

  async function searchRepositories(query: string, requestedPage = 1) {
    compactExplorer();
    counting = false;
    repository = undefined;
    analysis = undefined;
    $('repository-result').innerHTML = '';
    $('repository-summary').innerHTML = '';
    $('repository-summary').hidden = true;
    $('search-results').innerHTML = '';
    const result = await task('explore', 'Searching GitHub…', (signal) =>
      client.search(query, requestedPage, sort, signal),
    );
    if (!result) return;
    lastQuery = query;
    page = requestedPage;
    const maxPages = Math.ceil(Math.min(result.total_count, 1000) / SEARCH_PAGE_SIZE);
    $('search-results').innerHTML = /* HTML */ `<div
        class="mb-4 flex flex-wrap items-center justify-between gap-3"
      >
        <p class="text-sm text-muted">
          ${number(result.total_count)} ${result.total_count === 1 ? 'repository' : 'repositories'}
        </p>
        <div class="flex items-center gap-2">
          <label for="search-sort" class="text-xs text-muted">Sort by</label
          ><select id="search-sort" class="input !w-auto !py-2 !text-sm">
            <option value="" ${!sort ? 'selected' : ''}>Best match</option>
            <option value="stars" ${sort === 'stars' ? 'selected' : ''}>Stars</option>
            <option value="updated" ${sort === 'updated' ? 'selected' : ''}>
              Recently updated
            </option>
          </select>
        </div>
      </div>
      ${result.incomplete_results ? '<p class="notice mb-4">GitHub returned partial search results. Try a more specific query.</p>' : ''}
      <div class="space-y-3">
        ${result.items.map(searchCard).join('') || '<div class="panel p-8 text-center"><h2 class="font-semibold">No repositories found.</h2><p class="mt-2 text-sm text-muted">Try another name, topic, or GitHub search filter.</p></div>'}
      </div>
      ${maxPages > 1 ? `<div class="mt-5 flex items-center justify-center gap-4"><button class="secondary" type="button" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>${icon('chevron-left')}Previous</button><span class="text-xs text-muted">${page} / ${maxPages}</span><button class="secondary" type="button" data-page="${page + 1}" ${page >= maxPages ? 'disabled' : ''}>Next${icon('chevron-right')}</button></div>` : ''}`;
    refreshIcons();
    return result;
  }

  async function zipDownload(area: Area) {
    const snapshot = area === 'download' ? directory : repository;
    const prefix = area === 'download' ? directoryPrefix : repositoryPrefix;
    if (!snapshot) return;
    const bytes = await task(area, 'Downloading files from GitHub…', (signal) =>
      downloadFiles(client, snapshot, prefix, signal, (done, total, file) => {
        if (!signal.aborted)
          status(
            area,
            file === 'Creating ZIP…'
              ? file
              : `Downloading ${number(done)} / ${number(total)} files · ${file}`,
            total ? (done / total) * 100 : 0,
          );
      }),
    );
    if (bytes) {
      const name =
        prefix.split('/').at(-1) || snapshot.path.split('/').at(-1) || snapshot.repo.name;
      saveBlob(
        new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' }),
        `${snapshot.repo.name}-${name === snapshot.repo.name ? snapshot.sha.slice(0, 7) : name}.zip`,
      );
      status(area, 'Your ZIP is ready. Check your browser’s downloads.');
    }
  }

  $('download-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void findDirectory($<HTMLInputElement>('directory-url').value);
  });
  $('search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = $<HTMLInputElement>('repository-query').value.trim();
    if (isRepositoryInput(value)) {
      $('search-results').innerHTML = '';
      void loadRepository(value);
    } else void searchRepositories(value);
  });
  $('app').addEventListener('click', (event) => {
    const target = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!target) return;
    const data = target.dataset;
    if (data.cancel) controllers[data.cancel as Area]?.abort();
    if (data.browse) {
      if (data.browse === 'download') {
        directoryPrefix = data.prefix || '';
        renderDirectory();
      } else {
        repositoryPrefix = data.prefix || '';
        renderRepository();
      }
    }
    if (data.zip) void zipDownload(data.zip as Area);
    if (data.repository) void loadRepository(data.repository);
    if (data.page) void searchRepositories(lastQuery, Number(data.page));
    if (target.id === 'toggle-languages') {
      allLanguages = !allLanguages;
      updateAnalysis();
    }
  });
  $('repository-summary').addEventListener('submit', (event) => {
    event.preventDefault();
    if (repository)
      void loadRepository(
        `https://github.com/${repository.repo.full_name}${repository.path ? `/${repository.isFile ? 'blob' : 'tree'}/${encodeURIComponent(repository.ref)}/${repository.path.split('/').map(encodeURIComponent).join('/')}` : ''}`,
        $<HTMLInputElement>('repository-ref').value,
      );
  });
  $('repository-result').addEventListener('change', (event) => {
    if ((event.target as HTMLElement).id === 'include-generated') {
      includeGenerated = (event.target as HTMLInputElement).checked;
      void countLines();
    }
  });
  $('search-results').addEventListener('change', (event) => {
    if ((event.target as HTMLElement).id === 'search-sort') {
      sort = (event.target as HTMLSelectElement).value;
      void searchRepositories(lastQuery);
    }
  });

  function updateToken() {
    for (const area of ['download', 'explore'] as const) controllers[area]?.abort();
    client.setToken($<HTMLInputElement>('github-token').value);
    clearPrivateCounts();
    counting = false;
    directory = undefined;
    repository = undefined;
    analysis = undefined;
    $('directory-result').innerHTML = '';
    $('repository-result').innerHTML = '';
    $('search-results').innerHTML = '';
    $('repository-summary').innerHTML = '';
    $('repository-summary').hidden = true;
    $('token-status').textContent = client.hasToken
      ? 'Token set for this page. Reloading clears it.'
      : 'No token set. Public repositories work without one.';
  }
  $('github-token').addEventListener('change', updateToken);
  $('clear-token').addEventListener('click', () => {
    $<HTMLInputElement>('github-token').value = '';
    updateToken();
  });

  registerBrowserTools({
    async directory(url) {
      location.hash = 'download';
      $<HTMLInputElement>('directory-url').value = url;
      const snapshot = await findDirectory(url);
      if (!snapshot) throw new Error($('download-status').innerText);
      return {
        repository: snapshot.repo.full_name,
        ref: snapshot.ref,
        commit: snapshot.sha,
        path: snapshot.path,
        files: snapshot.files.length,
        bytes: snapshot.files.reduce((sum, file) => sum + (file.size ?? 0), 0),
      };
    },
    async search(query) {
      location.hash = 'explore';
      $<HTMLInputElement>('repository-query').value = query;
      const result = await searchRepositories(query);
      if (!result) throw new Error($('explore-status').innerText);
      return {
        total: result.total_count,
        repositories: result.items.map((repo) => ({
          name: repo.full_name,
          sizeKiB: repo.size,
          stars: repo.stargazers_count,
        })),
      };
    },
    async inspect(url) {
      location.hash = 'explore';
      $<HTMLInputElement>('repository-query').value = url;
      $('search-results').innerHTML = '';
      const snapshot = await loadRepository(url, undefined, false);
      if (!snapshot) throw new Error($('explore-status').innerText);
      return {
        repository: snapshot.repo.full_name,
        ref: snapshot.ref,
        commit: snapshot.sha,
        files: snapshot.files.length,
        bytes: snapshot.files.reduce((sum, file) => sum + (file.size ?? 0), 0),
      };
    },
  });
}
