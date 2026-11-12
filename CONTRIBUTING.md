# Contributing

## Development

```bash
npm install
npm run check
npm test
npm run build:open-loops
```

Use Node.js 22.15 or newer. The CLI stores local data under the user data directory; do not commit `data/`, logs, or local databases.

## Pull requests

- Keep one concern per pull request.
- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`).
- Add or update tests for behavior changes.
- Run `npm run release:audit` and `npm run release:check` before requesting review.
- Do not include real session data, credentials, internal URLs, or personal paths in code, fixtures, screenshots, or documentation.

## Reporting bugs

Open an issue with the smallest reproducible case, the Node.js version, the operating system, and the command you ran. Redact local paths and session content.
