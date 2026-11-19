# Changelog

## Unreleased

- Updated the LSP protocol import and dependency for `vscode-languageserver-protocol` 3.18+.
- Added LSP health reporting, bounded restart backoff, actionable diagnostics errors, and process-group cleanup.
- Added opt-in transactional application of in-workspace LSP rename edits.
- Added validated global/project declarative LSP configuration, clangd C/C++ support, and safe Ruby LSP resolution/tests.
- Added numbered selection shortcuts to extension prompts using the current pi custom UI API.
- Hardened checkpoint Git argv/path handling and permission classification coverage.
- Added repository-wide typecheck, smoke-import, and CI validation.
- CI now installs with pnpm and `--frozen-lockfile`, and runs lint, consistency checks, typecheck, tests, and smoke import.
- Added Biome linting and fixed unused imports/parameters, implicit `any` bindings, and dead code it found.
- Added `pnpm check:sync` to guard root/sub-package dependency drift, duplicated `ui.ts` copies, and missing test scripts.
- Typecheck now covers test files in every package.
- Extracted pure helpers into `repeat/repeat-core.ts` and `token-rate/token-rate-core.ts` and added unit tests (15 and 12 cases); the root `test` script now runs them.
- Split ralph-loop's pure completion/handoff, RPC, and limit definitions into `completion.ts`, `rpc.ts`, and `loop-constants.ts` (re-exported from `ralph-loop.ts` for compatibility).
- Added Biome formatting (`pnpm format`, `pnpm format:check`) with 2-space indentation (tabs for `repeat/` and `ralph-loop/`), and added a format check to CI.
- Made `shared/ui.ts` the canonical source for the interactive UI helper; `pnpm sync:ui` regenerates the four per-package copies and `check:sync` verifies them.
- Documented the security model: `permission` is not a sandbox, and `checkpoint` can capture un-ignored secrets into `refs/pi-checkpoints/`.
