# LSP Extension

Language Server Protocol integration for pi-coding-agent.

## Highlights

- **Hook** (`lsp.ts`): Auto-diagnostics (default at agent end; optional per `write`/`edit`)
- **Tool** (`lsp-tool.ts`): On-demand LSP queries (definitions, references, hover, symbols, diagnostics, signatures, rename, and code actions)
- Manages one LSP server per project root and reuses them across turns
- Retries failed starts with bounded exponential backoff and terminates detached process groups during cleanup
- **Efficient**: Bounded memory usage via LRU cache and idle file cleanup
- Supports TypeScript/JavaScript, C/C++, Vue, Svelte, Dart/Flutter, Python, Go, Kotlin, Ruby, Swift, and Rust

## Supported Languages

| Language | Server | Detection |
|----------|--------|-----------|
| TypeScript/JavaScript | `typescript-language-server` | `package.json`, `tsconfig.json`, `jsconfig.json` |
| C/C++ | `clangd --background-index` | nearest `compile_commands.json`, `.clangd`, `CMakeLists.txt` |
| Ruby | `ruby-lsp` | `Gemfile`, `Gemfile.lock`, `.ruby-version` |
| Vue | `vue-language-server` | `package.json`, `vite.config.ts` |
| Svelte | `svelteserver` | `svelte.config.js` |
| Dart/Flutter | `dart language-server` | `pubspec.yaml` |
| Python | `pyright-langserver` | `pyproject.toml`, `requirements.txt` |
| Go | `gopls` | `go.mod` |
| Kotlin | `kotlin-ls` | `settings.gradle(.kts)`, `build.gradle(.kts)`, `pom.xml` |
| Swift | `sourcekit-lsp` | `Package.swift`, Xcode (`*.xcodeproj` / `*.xcworkspace`) |
| Rust | `rust-analyzer` | `Cargo.toml` |

### Known Limitations

**rust-analyzer**: Very slow to initialize (30-60+ seconds) because it compiles the entire Rust project before returning diagnostics. This is a known rust-analyzer behavior, not a bug in this extension. For quick feedback, consider using `cargo check` directly.

## Usage

### Installation

Install the package and enable extensions:
```bash
pi install npm:lsp-pi
pi config
```

Dependencies are installed automatically during `pi install`.

### Prerequisites

Install the language servers you need:

```bash
# TypeScript/JavaScript
npm i -g typescript-language-server typescript

# C/C++
# Install clangd from your platform's LLVM package.

# Ruby (use the ruby-lsp gem in your application bundle)
gem install ruby-lsp

# Vue
npm i -g @vue/language-server

# Svelte
npm i -g svelte-language-server

# Python
npm i -g pyright

# Go (install gopls via go install)
go install golang.org/x/tools/gopls@latest

# Kotlin (kotlin-lsp; fallback: kotlin-language-server)
brew install JetBrains/utils/kotlin-lsp

# Swift (sourcekit-lsp; macOS)
# Usually available via Xcode / Command Line Tools
xcrun sourcekit-lsp --help

# Rust (install via rustup)
rustup component add rust-analyzer
```

Ruby LSP resolution is intentionally explicit and shell-free: `PI_LSP_RUBY_LSP_PATH` may point to a `ruby-lsp` executable, then a project-local `bin/ruby-lsp`, PATH, or `bundle exec ruby-lsp` is tried. The integration tests skip when the executable or a usable bundle is unavailable.

The extension spawns binaries from your PATH.

## How It Works

### Hook (auto-diagnostics)

1. On `session_start`, warms up LSP for detected project type
2. Tracks files touched by `write`/`edit`
3. Default (`agent_end`): at agent end, sends touched files to LSP and posts a diagnostics message
4. Optional (`edit_write`): per `write`/`edit`, appends diagnostics to the tool result
5. Shows notification with diagnostic summary
6. **Memory Management**: Keeps up to 30 files open per LSP server (LRU eviction), automatically closes idle files (> 60s), and shuts down all LSP servers after 2 minutes of post-agent inactivity (servers restart lazily when files are read again).
7. **Robustness**: Reuses cached diagnostics if a server doesn't re-publish them for unchanged files, avoiding false timeouts on re-analysis.

### Tool (on-demand queries)

The `lsp` tool provides these actions:

| Action | Description | Requires |
|--------|-------------|----------|
| `health` | Show server health, restart backoff, and last failure | None |
| `definition` | Jump to definition | `file` + (`line`/`column` or `query`) |
| `references` | Find all references | `file` + (`line`/`column` or `query`) |
| `hover` | Get type/docs info | `file` + (`line`/`column` or `query`) |
| `symbols` | List symbols in file | `file`, optional `query` filter |
| `diagnostics` | Get single file diagnostics | `file`, optional `severity` filter |
| `workspace-diagnostics` | Get diagnostics for multiple files | `files` array, optional `severity` filter |
| `signature` | Get function signature | `file` + (`line`/`column` or `query`) |
| `rename` | Return (or optionally apply) a WorkspaceEdit across files | `file` + (`line`/`column` or `query`) + `newName`; optional `apply: true` |
| `codeAction` | Get available quick fixes/refactors | `file` + `line`/`column`, optional `endLine`/`endColumn` |

**Query resolution**: For position-based actions, you can provide a `query` (symbol name) instead of `line`/`column`. The tool will find the symbol in the file and use its position.

**Rename behavior**: Rename is preview-only by default and returns the server's `WorkspaceEdit`. With `apply: true`, text edits are applied transactionally only to existing files inside the workspace; unsupported resource operations, overlapping edits, and failed writes produce an error.

**Severity filtering**: For `diagnostics` and `workspace-diagnostics` actions, use the `severity` parameter to filter results:
- `all` (default): Show all diagnostics
- `error`: Only errors
- `warning`: Errors and warnings
- `info`: Errors, warnings, and info
- `hint`: All including hints

**Workspace diagnostics**: The `workspace-diagnostics` action analyzes multiple files at once. Pass an array of file paths in the `files` parameter. Each file will be opened, analyzed by the appropriate LSP server, and diagnostics returned. Files are cleaned up after analysis to prevent memory bloat.

```bash
# Find all TypeScript files and check for errors
find src -name "*.ts" -type f | xargs ...

# Example tool call
lsp action=workspace-diagnostics files=["src/index.ts", "src/utils.ts"] severity=error
```

Example questions the LLM can answer using this tool:
- "Where is `handleSessionStart` defined in `lsp.ts`?"
- "Find all references to `getManager`"
- "What type does `getDefinition` return?"
- "List symbols in `lsp-core.ts`"
- "Check all TypeScript files in src/ for errors"
- "Get only errors from `index.ts`"
- "Rename `oldFunction` to `newFunction`"
- "What quick fixes are available at line 10?"

## Settings

Use `/lsp` to configure the auto diagnostics hook:
- Mode: default at agent end; can run after each edit/write or be disabled
- Scope: session-only or global (`~/.pi/agent/settings.json`)

To disable auto diagnostics, choose "Disabled" in `/lsp` or set in `~/.pi/agent/settings.json`:
```json
{
  "lsp": {
    "hookMode": "disabled"
  }
}
```
Other values: `"agent_end"` (default) and `"edit_write"`.

Agent-end mode analyzes files touched during the full agent response (after all tool calls complete) and posts a diagnostics message only once. Disabling the hook does not disable the `/lsp` tool.

### Declarative language-server configuration

Optional JSON configuration is read from:

- Global: `${PI_CODING_AGENT_DIR:-~/.pi/agent}/lsp.json`
- Project: `.pi/lsp.json`

The global file can override builtin servers or add new servers. Commands are launched directly (never through a shell), and must be a bare executable name resolved from `PATH` or an absolute executable path:

```json
{
  "servers": {
    "clangd": { "args": ["--background-index", "--clang-tidy"] },
    "example-ls": {
      "command": "example-language-server",
      "args": ["--stdio"],
      "extensions": [".example"],
      "rootMarkers": ["example.toml"],
      "languageIds": { ".example": "example" },
      "initializationOptions": { "feature": true }
    }
  }
}
```

Global fields are `command`, `args`, `extensions`, `rootMarkers`, `languageIds`, `initializationOptions`, `diagnosticsWaitMs`, and `disabled`. New servers require command, nonempty extensions, and nonempty root markers. Project `.pi/lsp.json` is restricted to existing servers and may only set `disabled: true` and `diagnosticsWaitMs`; the latter is clamped to 250–60000 ms. Invalid JSON, unknown keys, oversized files, and prototype-pollution keys are ignored with warnings, while builtin discovery/fallback behavior remains active unless command or args are explicitly overridden.

No servers are installed or downloaded by configuration. Ruby uses the explicit `PI_LSP_RUBY_LSP_PATH`/local-bin/PATH/Bundler resolution described above.

## File Structure

| File | Purpose |
|------|---------|
| `lsp.ts` | Hook extension (auto-diagnostics; default at agent end) |
| `lsp-tool.ts` | Tool extension (on-demand LSP queries) |
| `lsp-core.ts` | LSPManager class, server configs, singleton manager |
| `package.json` | Declares both extensions via "pi" field |

## Testing

```bash
# Unit tests (root detection, configuration)
npm test

# Tool tests
npm run test:tool

# Integration tests (spawns real language servers)
npm run test:integration

# Run rust-analyzer tests (slow, disabled by default)
RUST_LSP_TEST=1 npm run test:integration
```

## License

MIT
