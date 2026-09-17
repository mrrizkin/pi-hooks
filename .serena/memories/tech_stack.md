# Technology stack
- TypeScript ES modules; package manifests use `"type": "module"` where module-local.
- NodeNext module/moduleResolution, ES2022 target/lib, strict type checking, `noEmit`, and `skipLibCheck` in `checkpoint/tsconfig.json` and `lsp/tsconfig.json`.
- npm is the documented package manager; lockfiles are intentionally gitignored. Dependencies include `vscode-languageserver-protocol` and `shell-quote`; tests commonly use `tsx`.
- Peer integrations target `@earendil-works/pi-ai`, `pi-coding-agent`, and `pi-tui` around version `^0.74.0` in the LSP package.
- Serena `.serena/project.yml` selects `typescript` as the language server; do not confuse this development tooling with the repository's LSP extension.