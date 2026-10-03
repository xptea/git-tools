# Contributing

Use Node.js 22.18 or newer. Install dependencies with `npm ci`, then start Vite with `npm run dev`.

Keep processing in the browser and fetch repository data directly from GitHub. Avoid adding a backend, analytics, or a runtime CDN dependency. Never store access tokens or persist private repository data.

Before opening a pull request:

```sh
npm run format
npm run check
```

For behavior changes, add a regression test in `tests/`. For UI changes, check both tools at desktop and mobile widths. Describe the problem, resulting behavior, and how you checked it in the pull request.

Bug reports should include the GitHub URL or search query, browser, expected behavior, and any visible error. Use a public repository to reproduce private-repository problems; leave tokens and private source out of reports.
