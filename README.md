# Local Git Tools

[git.seths.app](https://git.seths.app/)

Download GitHub folders and explore repositories. Built with TypeScript and Tailwind CSS, with all processing handled in your browser.

- Download a folder, file, or repository as a ZIP.
- Search GitHub and browse branches, tags, and commits.
- See file sizes and line counts by folder, file, and language.
- Use an optional GitHub token for private repositories or higher API limits.

## Development

Requires Node.js 22.18 or newer.

```sh
npm ci
npm run dev
```

Run `npm run check` to check formatting, run tests, and build. Use `npm run build` to generate the static site in `dist/`.

## Line counts and privacy

Source lines are non-empty text lines, including comments. Total lines include blank lines. Binary files and oversized text files are excluded.

Repository data is fetched directly from GitHub. Public file counts are cached locally and reused for unchanged files. Private counts and access tokens stay in page memory. Tokens are sent only to GitHub's API.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution instructions.
