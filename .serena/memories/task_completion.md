# Task completion checks
- Before a coding task is complete, inspect `git diff` and `git status`; do not include `.serena/` or generated dependencies.
- Run relevant module tests, then `cd lsp && npm run test:all` for LSP changes and module `npm test` for checkpoint/permission changes.
- Run TypeScript no-emit checks for changed modules (`npx tsc -p <module>/tsconfig.json`).
- For cross-package or manifest changes, verify extension imports/smoke loading and run all available suites; update README when public behavior or filenames change.
- Use separate commits for logically distinct improvements and push only to the user's fork after review.