import { escapeHtml } from './utils.ts';

export function renderShell(sourceUrl: string): string {
  return /* HTML */ ` <div class="flex min-h-dvh flex-col">
    <header class="flex items-center justify-between gap-2 px-4 py-4 sm:px-8">
      <a
        href="#download"
        class="flex min-w-0 items-center gap-2.5 text-sm font-semibold"
        aria-label="Git Tools home"
      >
        <span class="flex size-8 items-center justify-center rounded-full bg-ink text-canvas"
          ><i data-lucide="git-branch"></i
        ></span>
        <span class="truncate">git.seths.app</span>
      </a>
      <nav aria-label="Primary navigation" class="flex shrink-0 items-center gap-1">
        <a class="nav-link active" href="#download" id="tools-nav">Tools</a>
        <a class="nav-link" href="#about" id="about-nav">About</a>
        <a
          class="nav-link flex size-9 items-center justify-center !p-0"
          href="${escapeHtml(sourceUrl)}"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="GitHub"
          title="GitHub"
          ><i data-lucide="github"></i
        ></a>
      </nav>
    </header>
    <main class="mx-auto w-full max-w-3xl flex-1 px-5 pb-12 pt-12 sm:pt-20" id="main">
      <section id="tools-view">
        <div class="mb-8 text-center">
          <h1 class="text-4xl font-bold tracking-tight">Local Git Tools</h1>
          <p class="mx-auto mt-2 max-w-md text-base leading-relaxed text-muted">
            A few things GitHub should make easier.
          </p>
        </div>
        <div
          role="tablist"
          aria-label="GitHub tools"
          class="mx-auto mb-5 flex max-w-xl gap-1 rounded-2xl border border-line bg-panel p-1.5"
        >
          <button
            class="tool-tab"
            id="download-tab"
            role="tab"
            aria-selected="true"
            aria-controls="download-panel"
            tabindex="0"
          >
            <i data-lucide="folder-down"></i><span>Download directory</span>
          </button>
          <button
            class="tool-tab"
            id="explore-tab"
            role="tab"
            aria-selected="false"
            aria-controls="explore-panel"
            tabindex="-1"
          >
            <i data-lucide="search"></i><span>Explore repositories</span>
          </button>
        </div>
        <section
          id="download-panel"
          role="tabpanel"
          aria-labelledby="download-tab"
          class="view-enter"
        >
          <div class="panel border-dashed p-6 sm:p-8">
            <div class="icon-tile"><i data-lucide="folder-down"></i></div>
            <h2 class="text-center text-xl font-semibold">Just the folder you need.</h2>
            <p class="mx-auto mt-2 max-w-md text-center text-sm leading-relaxed text-muted">
              Paste a GitHub folder link to download its files as a ZIP.
            </p>
            <form id="download-form" class="mt-7">
              <label class="mb-2 block text-sm text-muted" for="directory-url"
                >GitHub directory URL</label
              >
              <div class="flex flex-col gap-3 sm:flex-row">
                <input
                  id="directory-url"
                  class="input"
                  type="text"
                  inputmode="url"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="https://github.com/owner/repo/tree/main/src"
                  required
                />
                <button class="primary" type="submit">
                  <i data-lucide="search"></i>Find directory
                </button>
              </div>
              <p class="mt-3 text-xs text-muted">Works with public repositories.</p>
            </form>
          </div>
          <div id="download-status" class="mt-4" role="status" aria-live="polite"></div>
          <div id="directory-result" class="mt-5"></div>
        </section>
        <section
          id="explore-panel"
          role="tabpanel"
          aria-labelledby="explore-tab"
          class="view-enter"
          hidden
        >
          <div id="explore-workspace" class="panel border-dashed p-6 sm:p-8">
            <div id="explore-intro">
              <div class="icon-tile"><i data-lucide="code-xml"></i></div>
              <h2 class="text-center text-xl font-semibold">Get a feel for a repository.</h2>
              <p class="mx-auto mt-2 max-w-md text-center text-sm leading-relaxed text-muted">
                Search GitHub or paste a repository link to explore its files.
              </p>
            </div>
            <form id="search-form" class="mt-7">
              <label class="mb-2 block text-sm text-muted" for="repository-query"
                >Search or repository URL</label
              >
              <div class="flex flex-col gap-3 sm:flex-row">
                <input
                  id="repository-query"
                  class="input"
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="e.g. a markdown editor, or owner/repo"
                  required
                />
                <button class="primary" type="submit"><i data-lucide="search"></i>Explore</button>
              </div>
              <p class="mt-3 text-xs text-muted">GitHub search filters work here, too.</p>
            </form>
            <div id="repository-summary" class="mt-4 border-t border-line pt-4" hidden></div>
          </div>
          <div id="explore-status" class="mt-4" role="status" aria-live="polite"></div>
          <div id="search-results" class="mt-5"></div>
          <div id="repository-result" class="mt-5"></div>
        </section>
        <details id="access-settings" class="mx-auto mt-6 max-w-xl text-sm text-muted">
          <summary class="mx-auto flex w-fit list-none items-center gap-2 rounded-lg px-2 py-1">
            <i data-lucide="key-round"></i>GitHub access
            <span class="text-xs text-neutral-500">optional</span>
          </summary>
          <div class="notice mt-3">
            <label for="github-token" class="mb-2 block text-ink">Personal access token</label>
            <div class="flex gap-2">
              <input
                id="github-token"
                class="input py-2 text-sm"
                type="password"
                autocomplete="off"
                spellcheck="false"
                placeholder="github_pat_…"
              /><button type="button" class="secondary" id="clear-token">Clear</button>
            </div>
            <p class="mt-3">
              Use a token for higher API limits or private repositories. It stays in memory for this
              page and is sent only to GitHub’s API. For private repos, grant read access to
              Contents.
            </p>
            <p id="token-status" class="mt-2 text-xs" role="status"></p>
          </div>
        </details>
        <p
          class="mt-8 flex items-center justify-center gap-2 text-center text-xs leading-relaxed text-muted"
        >
          <i data-lucide="lock-keyhole" class="!size-3.5"></i>Processed on this device. Fetched
          directly from GitHub.
        </p>
      </section>
      <section id="about-view" class="view-enter" hidden>
        <h1 class="text-4xl font-bold tracking-tight">About Local Git Tools</h1>
        <p class="mt-4 leading-relaxed text-muted">
          Small tools for working with GitHub, made by
          <a href="https://seths.app/" class="underline underline-offset-4 text-ink">Seth</a>.
        </p>
        <div class="panel mt-8 space-y-6 p-6 sm:p-8">
          <div>
            <h2 class="font-semibold">Download only what you need</h2>
            <p class="mt-2 leading-relaxed text-muted">
              Paste a folder, file, or repository URL. The selected files are fetched directly from
              GitHub and packed into a ZIP in your browser. Git history and unrelated folders aren’t
              downloaded. Submodules and Git LFS file contents aren’t included; LFS pointer files
              are preserved.
            </p>
          </div>
          <div>
            <h2 class="font-semibold">Understand a repository’s size</h2>
            <p class="mt-2 leading-relaxed text-muted">
              Search public repositories or paste a URL to inspect a branch. File sizes come from
              its current Git tree. Text lines are counted automatically and include comments; blank
              lines are counted separately. Each file and folder shows its source lines and share of
              the current directory. Colored row fills show that share across the full row width.
              The source breakdown follows the folder you’re viewing, including its nested files.
              Totals update during scanning, and a + marks incomplete counts. Binary, non-UTF-8, and
              files over 2 MB are excluded. Turn off “Include generated files & lockfiles” to
              exclude dependencies and build output, too.
            </p>
          </div>
          <div>
            <h2 class="font-semibold">Your browser does the work</h2>
            <p class="mt-2 leading-relaxed text-muted">
              This is a static website. There’s no processing server, analytics, account, or upload
              service. Network requests go to GitHub for repository data and files. Public file
              counts are cached on this device by their content hash, so unchanged files don’t need
              to be fetched again. Private counts and optional access tokens stay only in page
              memory. Tokens are never saved to storage or sent to another service.
            </p>
          </div>
          <div>
            <h2 class="font-semibold">GitHub limits still apply</h2>
            <p class="mt-2 leading-relaxed text-muted">
              GitHub limits unauthenticated API requests. A personal access token can raise those
              limits. Large downloads are capped at 200 MB, and single files at 50 MB, to keep
              browser memory use manageable. Line counting stops before fetching if the selected
              source files exceed 100 MB.
            </p>
          </div>
        </div>
        <a href="#download" class="secondary mt-6"
          ><i data-lucide="folder-down"></i>Back to tools</a
        >
      </section>
    </main>
    <footer class="px-5 py-6 text-center text-xs text-muted">
      © ${new Date().getFullYear()}
      <a
        href="https://seths.app/"
        class="text-ink underline decoration-neutral-600 underline-offset-4"
        >seths.app</a
      >
    </footer>
  </div>`;
}
