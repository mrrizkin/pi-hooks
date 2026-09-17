# Suggested commands
- Inspect state: `git status --short --branch`; remotes: `git remote -v`.
- Install/test LSP: `cd lsp && npm install`; `npm run test:all` (runs unit, tool, and integration suites).
- Checkpoint tests: `cd checkpoint && npm install && npm test`.
- Permission tests: `cd permission && npm install && npm test`.
- Typecheck a module without emitting: `npx tsc -p lsp/tsconfig.json` or `npx tsc -p checkpoint/tsconfig.json` (install module dependencies first as needed).
- The fork is preferred as `origin` via SSH (`git@github.com:mrrizkin/pi-hooks.git`); upstream is `upstream` (`https://github.com/prateekmedia/pi-hooks`).