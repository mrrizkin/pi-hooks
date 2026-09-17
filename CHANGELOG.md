# Changelog

## Unreleased

- Updated the LSP protocol import and dependency for `vscode-languageserver-protocol` 3.18+.
- Added LSP health reporting, bounded restart backoff, actionable diagnostics errors, and process-group cleanup.
- Added opt-in transactional application of in-workspace LSP rename edits.
- Added validated global/project declarative LSP configuration, clangd C/C++ support, and safe Ruby LSP resolution/tests.
- Added numbered selection shortcuts to extension prompts using the current pi custom UI API.
- Hardened checkpoint Git argv/path handling and permission classification coverage.
- Added repository-wide typecheck, smoke-import, and CI validation.
