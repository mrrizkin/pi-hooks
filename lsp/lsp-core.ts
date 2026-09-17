/**
 * LSP Core - Language Server Protocol client management
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  defaultGlobalLSPConfigPath,
  resolveLSPConfig,
  type LSPConfigWarning,
  type LSPServerDefinition,
  type ResolvedLSPServerConfig,
} from "./lsp-config.js";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
  InitializeRequest,
  InitializedNotification,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidSaveTextDocumentNotification,
  PublishDiagnosticsNotification,
  DocumentDiagnosticRequest,
  WorkspaceDiagnosticRequest,
  DefinitionRequest,
  ReferencesRequest,
  HoverRequest,
  SignatureHelpRequest,
  DocumentSymbolRequest,
  RenameRequest,
  CodeActionRequest,
} from "vscode-languageserver-protocol/node";
import {
  type Diagnostic,
  type Location,
  type LocationLink,
  type DocumentSymbol,
  type SymbolInformation,
  type Hover,
  type SignatureHelp,
  type WorkspaceEdit,
  type CodeAction,
  type Command,
  DiagnosticSeverity,
  CodeActionKind,
  DocumentDiagnosticReportKind,
} from "vscode-languageserver-protocol";

// Config
const INIT_TIMEOUT_MS = 30000;
const MAX_OPEN_FILES = 30;
const IDLE_TIMEOUT_MS = 60_000;
const CLEANUP_INTERVAL_MS = 30_000;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BACKOFF_MS = [250, 1_000, 4_000];
const STABLE_PROCESS_MS = 30_000;

export const LANGUAGE_IDS: Record<string, string> = {
  ".dart": "dart", ".ts": "typescript", ".tsx": "typescriptreact",
  ".js": "javascript", ".jsx": "javascriptreact", ".mjs": "javascript",
  ".cjs": "javascript", ".mts": "typescript", ".cts": "typescript",
  ".vue": "vue", ".svelte": "svelte", ".astro": "astro",
  ".py": "python", ".pyi": "python", ".go": "go", ".rs": "rust",
  ".kt": "kotlin", ".kts": "kotlin",
  ".swift": "swift",
  ".rb": "ruby", ".rake": "ruby", ".gemspec": "ruby", ".ru": "ruby",
  ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp",
  ".hpp": "cpp", ".hxx": "cpp",
};

// Types
export interface LSPServerConfig extends LSPServerDefinition {
  findRoot: (file: string, cwd: string) => string | undefined;
  spawn: (root: string) => Promise<{ process: ChildProcessWithoutNullStreams; initOptions?: Record<string, unknown> } | undefined>;
}

interface OpenFile { version: number; lastAccess: number; }

interface LSPClient {
  connection: MessageConnection;
  process: ChildProcessWithoutNullStreams;
  diagnostics: Map<string, Diagnostic[]>;
  openFiles: Map<string, OpenFile>;
  listeners: Map<string, Array<() => void>>;
  stderr: string[];
  capabilities?: any;
  root: string;
  config: ResolvedLSPServerConfig;
  closed: boolean;
  stopping: boolean;
  failureRecorded: boolean;
}

export interface FileDiagnosticItem {
  file: string;
  diagnostics: Diagnostic[];
  status: 'ok' | 'timeout' | 'error' | 'unsupported';
  error?: string;
}

export interface FileDiagnosticsResult { items: FileDiagnosticItem[]; }

// Utilities
const SEARCH_PATHS = [
  ...(process.env.PATH?.split(path.delimiter) || []),
  "/usr/local/bin", "/opt/homebrew/bin",
  `${process.env.HOME}/.pub-cache/bin`, `${process.env.HOME}/fvm/default/bin`,
  `${process.env.HOME}/go/bin`, `${process.env.HOME}/.cargo/bin`,
];

function which(cmd: string): string | undefined {
  const ext = process.platform === "win32" ? ".exe" : "";
  for (const dir of SEARCH_PATHS) {
    const full = path.join(dir, cmd + ext);
    try { if (fs.existsSync(full) && fs.statSync(full).isFile()) return full; } catch {}
  }
}

function normalizeFsPath(p: string): string {
  try {
    // realpathSync.native is faster on some platforms, but not always present
    const fn: any = (fs as any).realpathSync?.native || fs.realpathSync;
    return fn(p);
  } catch {
    return p;
  }
}

function findNearestFile(startDir: string, targets: string[], stopDir: string): string | undefined {
  let current = path.resolve(startDir);
  const stop = path.resolve(stopDir);
  while (current.length >= stop.length) {
    for (const t of targets) {
      const candidate = path.join(current, t);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function findRoot(file: string, cwd: string, markers: string[]): string | undefined {
  const found = findNearestFile(path.dirname(file), markers, cwd);
  return found ? path.dirname(found) : undefined;
}

function timeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} timed out`)), ms);
    promise.then(r => { clearTimeout(timer); resolve(r); }, e => { clearTimeout(timer); reject(e); });
  });
}


function terminateProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals = "SIGTERM"): void {
  if (child.exitCode !== null) return;
  try {
    // Language servers may spawn helper processes. Detached process groups let us
    // terminate those helpers as well instead of leaving orphans behind.
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* already exited */ }
  }
}

function resolveExecutable(command: string): string | undefined {
  if (path.isAbsolute(command)) {
    try {
      if (!fs.statSync(command).isFile()) return undefined;
      if (process.platform !== "win32") fs.accessSync(command, fs.constants.X_OK);
      return command;
    } catch { return undefined; }
  }
  return which(command);
}

function simpleSpawn(bin: string, args: string[] = ["--stdio"]): LSPServerConfig["spawn"] {
  return async (root: string) => {
    const cmd = resolveExecutable(bin);
    if (!cmd) return undefined;
    const process = await spawnChecked(cmd, args, root);
    return process ? { process } : undefined;
  };
}

async function spawnChecked(cmd: string, args: string[], cwd: string): Promise<ChildProcessWithoutNullStreams | undefined> {
  try {
    const child = spawn(cmd, args, { cwd, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });

    // If the process exits immediately (e.g. unsupported flag), treat it as a failure
    return await new Promise((resolve) => {
      let settled = false;

      const cleanup = () => {
        child.removeListener("exit", onExit);
        child.removeListener("error", onError);
      };

      let timer: NodeJS.Timeout | null = null;

      const finish = (value: ChildProcessWithoutNullStreams | undefined) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        cleanup();
        resolve(value);
      };

      const onExit = () => finish(undefined);
      const onError = () => finish(undefined);

      child.once("exit", onExit);
      child.once("error", onError);

      timer = setTimeout(() => finish(child), 200);
      (timer as any).unref?.();
    });
  } catch {
    return undefined;
  }
}

async function spawnWithFallback(cmd: string, argsVariants: string[][], cwd: string): Promise<ChildProcessWithoutNullStreams | undefined> {
  for (const args of argsVariants) {
    const child = await spawnChecked(cmd, args, cwd);
    if (child) return child;
  }
  return undefined;
}

function findRootKotlin(file: string, cwd: string): string | undefined {
  // Prefer Gradle settings root for multi-module projects
  const gradleRoot = findRoot(file, cwd, ["settings.gradle.kts", "settings.gradle"]);
  if (gradleRoot) return gradleRoot;

  // Fallbacks for single-module Gradle or Maven builds
  return findRoot(file, cwd, [
    "build.gradle.kts",
    "build.gradle",
    "gradlew",
    "gradlew.bat",
    "gradle.properties",
    "pom.xml",
  ]);
}

function dirContainsNestedProjectFile(dir: string, dirSuffix: string, markerFile: string): boolean {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!e.name.endsWith(dirSuffix)) continue;
      if (fs.existsSync(path.join(dir, e.name, markerFile))) return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function findRootSwift(file: string, cwd: string): string | undefined {
  let current = path.resolve(path.dirname(file));
  const stop = path.resolve(cwd);

  while (current.length >= stop.length) {
    if (fs.existsSync(path.join(current, "Package.swift"))) return current;

    // Xcode projects/workspaces store their marker files *inside* a directory
    if (dirContainsNestedProjectFile(current, ".xcodeproj", "project.pbxproj")) return current;
    if (dirContainsNestedProjectFile(current, ".xcworkspace", "contents.xcworkspacedata")) return current;

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}

async function runCommand(cmd: string, args: string[], cwd: string): Promise<boolean> {
  return await new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      p.on("error", () => resolve(false));
      p.on("exit", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

async function ensureJetBrainsKotlinLspInstalled(): Promise<string | undefined> {
  // Opt-in download (to avoid surprising network activity)
  const allowDownload = process.env.PI_LSP_AUTO_DOWNLOAD_KOTLIN_LSP === "1" || process.env.PI_LSP_AUTO_DOWNLOAD_KOTLIN_LSP === "true";
  const installDir = path.join(os.homedir(), ".pi", "agent", "lsp", "kotlin-ls");
  const launcher = process.platform === "win32"
    ? path.join(installDir, "kotlin-lsp.cmd")
    : path.join(installDir, "kotlin-lsp.sh");

  if (fs.existsSync(launcher)) return launcher;
  if (!allowDownload) return undefined;

  const curl = which("curl");
  const unzip = which("unzip");
  if (!curl || !unzip) return undefined;

  try {
    // Determine latest version
    const res = await fetch("https://api.github.com/repos/Kotlin/kotlin-lsp/releases/latest", {
      headers: { "User-Agent": "pi-lsp" },
    });
    if (!res.ok) return undefined;
    const release: any = await res.json();
    const versionRaw = (release?.name || release?.tag_name || "").toString();
    const version = versionRaw.replace(/^v/, "");
    if (!version) return undefined;

    // Map platform/arch to JetBrains naming
    const platform = process.platform;
    const arch = process.arch;

    let kotlinArch: string = arch;
    if (arch === "arm64") kotlinArch = "aarch64";
    else if (arch === "x64") kotlinArch = "x64";

    let kotlinPlatform: string = platform;
    if (platform === "darwin") kotlinPlatform = "mac";
    else if (platform === "linux") kotlinPlatform = "linux";
    else if (platform === "win32") kotlinPlatform = "win";

    const supportedCombos = new Set(["mac-x64", "mac-aarch64", "linux-x64", "linux-aarch64", "win-x64", "win-aarch64"]);
    const combo = `${kotlinPlatform}-${kotlinArch}`;
    if (!supportedCombos.has(combo)) return undefined;

    const assetName = `kotlin-lsp-${version}-${kotlinPlatform}-${kotlinArch}.zip`;
    const url = `https://download-cdn.jetbrains.com/kotlin-lsp/${version}/${assetName}`;

    fs.mkdirSync(installDir, { recursive: true });
    const zipPath = path.join(installDir, "kotlin-lsp.zip");

    const okDownload = await runCommand(curl, ["-L", "-o", zipPath, url], installDir);
    if (!okDownload || !fs.existsSync(zipPath)) return undefined;

    const okUnzip = await runCommand(unzip, ["-o", zipPath, "-d", installDir], installDir);
    try { fs.rmSync(zipPath, { force: true }); } catch {}
    if (!okUnzip) return undefined;

    if (process.platform !== "win32") {
      try { fs.chmodSync(launcher, 0o755); } catch {}
    }

    return fs.existsSync(launcher) ? launcher : undefined;
  } catch {
    return undefined;
  }
}

async function spawnKotlinLanguageServer(root: string): Promise<ChildProcessWithoutNullStreams | undefined> {
  // Prefer JetBrains Kotlin LSP (Kotlin/kotlin-lsp) – better diagnostics for Gradle/Android projects.
  const explicit = process.env.PI_LSP_KOTLIN_LSP_PATH;
  if (explicit && fs.existsSync(explicit)) {
    return spawnWithFallback(explicit, [["--stdio"]], root);
  }

  const jetbrains = which("kotlin-lsp") || which("kotlin-lsp.sh") || which("kotlin-lsp.cmd") || await ensureJetBrainsKotlinLspInstalled();
  if (jetbrains) {
    return spawnWithFallback(jetbrains, [["--stdio"]], root);
  }

  // Fallback: org.javacs/kotlin-language-server (often lacks diagnostics without full classpath)
  const kls = which("kotlin-language-server");
  if (!kls) return undefined;
  return spawnWithFallback(kls, [[]], root);
}

async function spawnSourcekitLsp(root: string): Promise<ChildProcessWithoutNullStreams | undefined> {
  const direct = which("sourcekit-lsp");
  if (direct) return spawnWithFallback(direct, [[], ["--stdio"]], root);

  // macOS/Xcode: sourcekit-lsp is often available via xcrun
  const xcrun = which("xcrun");
  if (!xcrun) return undefined;
  return spawnWithFallback(xcrun, [["sourcekit-lsp"], ["sourcekit-lsp", "--stdio"]], root);
}

// Builtin server definitions. Their custom spawn functions retain language-specific
// discovery and fallback behavior unless global config overrides command/args.
function languageIds(extensions: string[]): Record<string, string> {
  return Object.fromEntries(extensions.map((extension) => [extension, LANGUAGE_IDS[extension] ?? "plaintext"]));
}

export const LSP_SERVERS: LSPServerConfig[] = [
  {
    id: "dart", command: "dart", args: ["language-server", "--protocol=lsp"],
    extensions: [".dart"], rootMarkers: ["pubspec.yaml", "analysis_options.yaml"],
    languageIds: { ".dart": "dart" }, diagnosticsWaitMs: 3000,
    findRoot: (f, cwd) => findRoot(f, cwd, ["pubspec.yaml", "analysis_options.yaml"]),
    spawn: async (root) => {
      let dart = which("dart");
      const pubspec = path.join(root, "pubspec.yaml");
      if (fs.existsSync(pubspec)) {
        try {
          const content = fs.readFileSync(pubspec, "utf-8");
          if (content.includes("flutter:") || content.includes("sdk: flutter")) {
            const flutter = which("flutter");
            if (flutter) {
              const dir = path.dirname(fs.realpathSync(flutter));
              for (const p of ["cache/dart-sdk/bin/dart", "../cache/dart-sdk/bin/dart"]) {
                const c = path.join(dir, p);
                if (fs.existsSync(c)) { dart = c; break; }
              }
            }
          }
        } catch {}
      }
      if (!dart) return undefined;
      const process = await spawnChecked(dart, ["language-server", "--protocol=lsp"], root);
      return process ? { process } : undefined;
    },
  },
  {
    id: "typescript", command: "typescript-language-server", args: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    rootMarkers: ["package.json", "tsconfig.json", "jsconfig.json"],
    languageIds: languageIds([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]), diagnosticsWaitMs: 3000,
    findRoot: (f, cwd) => {
      if (findNearestFile(path.dirname(f), ["deno.json", "deno.jsonc"], cwd)) return undefined;
      return findRoot(f, cwd, ["package.json", "tsconfig.json", "jsconfig.json"]);
    },
    spawn: async (root) => {
      const local = path.join(root, "node_modules/.bin/typescript-language-server");
      const cmd = fs.existsSync(local) ? local : which("typescript-language-server");
      if (!cmd) return undefined;
      const process = await spawnChecked(cmd, ["--stdio"], root);
      return process ? { process } : undefined;
    },
  },
  {
    id: "vue", command: "vue-language-server", args: ["--stdio"], extensions: [".vue"],
    rootMarkers: ["package.json", "vite.config.ts", "vite.config.js"], languageIds: { ".vue": "vue" }, diagnosticsWaitMs: 3000,
    findRoot: (f, cwd) => findRoot(f, cwd, ["package.json", "vite.config.ts", "vite.config.js"]), spawn: simpleSpawn("vue-language-server"),
  },
  {
    id: "svelte", command: "svelteserver", args: ["--stdio"], extensions: [".svelte"],
    rootMarkers: ["package.json", "svelte.config.js"], languageIds: { ".svelte": "svelte" }, diagnosticsWaitMs: 3000,
    findRoot: (f, cwd) => findRoot(f, cwd, ["package.json", "svelte.config.js"]), spawn: simpleSpawn("svelteserver"),
  },
  {
    id: "pyright", command: "pyright-langserver", args: ["--stdio"], extensions: [".py", ".pyi"],
    rootMarkers: ["pyproject.toml", "setup.py", "requirements.txt", "pyrightconfig.json"], languageIds: languageIds([".py", ".pyi"]), diagnosticsWaitMs: 3000,
    findRoot: (f, cwd) => findRoot(f, cwd, ["pyproject.toml", "setup.py", "requirements.txt", "pyrightconfig.json"]), spawn: simpleSpawn("pyright-langserver"),
  },
  {
    id: "gopls", command: "gopls", args: [], extensions: [".go"], rootMarkers: ["go.work", "go.mod"],
    languageIds: { ".go": "go" }, diagnosticsWaitMs: 3000,
    findRoot: (f, cwd) => findRoot(f, cwd, ["go.work"]) || findRoot(f, cwd, ["go.mod"]), spawn: simpleSpawn("gopls", []),
  },
  {
    id: "kotlin", command: "kotlin-lsp", args: ["--stdio"], extensions: [".kt", ".kts"],
    rootMarkers: ["settings.gradle.kts", "settings.gradle", "build.gradle.kts", "build.gradle", "gradlew", "gradlew.bat", "gradle.properties", "pom.xml"],
    languageIds: languageIds([".kt", ".kts"]), diagnosticsWaitMs: 30000,
    findRoot: (f, cwd) => findRootKotlin(f, cwd),
    spawn: async (root) => {
      const proc = await spawnKotlinLanguageServer(root);
      if (!proc) return undefined;
      return { process: proc };
    },
  },
  {
    id: "swift", command: "sourcekit-lsp", args: [], extensions: [".swift"],
    rootMarkers: ["Package.swift"], languageIds: { ".swift": "swift" }, diagnosticsWaitMs: 20000,
    findRoot: (f, cwd) => findRootSwift(f, cwd),
    spawn: async (root) => {
      const proc = await spawnSourcekitLsp(root);
      if (!proc) return undefined;
      return { process: proc };
    },
  },
  {
    id: "rust-analyzer", command: "rust-analyzer", args: [], extensions: [".rs"], rootMarkers: ["Cargo.toml"],
    languageIds: { ".rs": "rust" }, diagnosticsWaitMs: 20000,
    findRoot: (f, cwd) => findRoot(f, cwd, ["Cargo.toml"]), spawn: simpleSpawn("rust-analyzer", []),
  },
  {
    id: "ruby", command: "ruby-lsp", args: [],
    extensions: [".rb", ".rake", ".gemspec", ".ru"],
    rootMarkers: ["Gemfile", "Gemfile.lock", ".ruby-version"],
    languageIds: languageIds([".rb", ".rake", ".gemspec", ".ru"]), diagnosticsWaitMs: 20000,
    findRoot: (f, cwd) => findRoot(f, cwd, ["Gemfile", "Gemfile.lock", ".ruby-version"]),
    spawn: async (root) => {
      const explicit = process.env.PI_LSP_RUBY_LSP_PATH;
      const localCandidates = process.platform === "win32"
        ? [path.join(root, "bin", "ruby-lsp.cmd"), path.join(root, "bin", "ruby-lsp")]
        : [path.join(root, "bin", "ruby-lsp")];
      const command = explicit
        ? resolveExecutable(explicit)
        : localCandidates.map(resolveExecutable).find(Boolean) || resolveExecutable("ruby-lsp");
      if (command) {
        const proc = await spawnChecked(command, [], root);
        if (proc) return { process: proc };
      }
      // Bundler installs ruby-lsp in the project's bundle without exposing it
      // on PATH. Invoke bundle directly, never through a shell.
      const bundle = resolveExecutable("bundle");
      if (!explicit && bundle && fs.existsSync(path.join(root, "Gemfile"))) {
        const proc = await spawnChecked(bundle, ["exec", "ruby-lsp"], root);
        if (proc) return { process: proc };
      }
      return undefined;
    },
  },
  {
    id: "clangd", command: "clangd", args: ["--background-index"],
    extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hxx"],
    rootMarkers: ["compile_commands.json", ".clangd", "CMakeLists.txt"],
    languageIds: languageIds([".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hxx"]), diagnosticsWaitMs: 3000,
    findRoot: (f, cwd) => findRoot(f, cwd, ["compile_commands.json", ".clangd", "CMakeLists.txt"]),
    spawn: simpleSpawn("clangd", ["--background-index"]),
  },
];

type RuntimeServerConfig = ResolvedLSPServerConfig & Pick<LSPServerConfig, "findRoot" | "spawn">;

function runtimeServerConfig(resolved: ResolvedLSPServerConfig): RuntimeServerConfig {
  const builtin = resolved.builtin ? LSP_SERVERS.find((server) => server.id === resolved.id) : undefined;
  const useBuiltinRoot = Boolean(builtin && !resolved.globalOverrides.has("rootMarkers"));
  const useBuiltinSpawn = Boolean(builtin && !resolved.globalOverrides.has("command") && !resolved.globalOverrides.has("args"));
  const baseSpawn = useBuiltinSpawn ? builtin!.spawn : simpleSpawn(resolved.command, resolved.args);

  return {
    ...resolved,
    findRoot: useBuiltinRoot ? builtin!.findRoot : (file, cwd) => findRoot(file, cwd, resolved.rootMarkers),
    spawn: async (root) => {
      const handle = await baseSpawn(root);
      if (!handle) return undefined;
      return {
        process: handle.process,
        initOptions: resolved.globalOverrides.has("initializationOptions")
          ? resolved.initializationOptions
          : (handle.initOptions ?? resolved.initializationOptions),
      };
    },
  };
}

// Singleton Manager
let sharedManager: LSPManager | null = null;
let managerCwd: string | null = null;

export function getOrCreateManager(cwd: string): LSPManager {
  if (!sharedManager || managerCwd !== cwd) {
    sharedManager?.shutdown().catch(() => {});
    sharedManager = new LSPManager(cwd);
    managerCwd = cwd;
  }
  return sharedManager;
}

export function getManager(): LSPManager | null { return sharedManager; }

export async function shutdownManager(): Promise<void> {
  const manager = sharedManager;
  if (!manager) return;

  // Clear singleton pointers first so new requests never receive a manager
  // that's currently being shut down.
  sharedManager = null;
  managerCwd = null;

  await manager.shutdown();
}

// LSP Manager
interface LSPFailure {
  attempts: number;
  nextRetryAt: number;
  message: string;
}

export interface LSPHealth {
  server: string;
  root: string;
  status: "healthy" | "starting" | "backoff" | "failed";
  attempts: number;
  retryAt?: number;
  error?: string;
}

export class LSPManager {
  private clients = new Map<string, LSPClient>();
  private spawning = new Map<string, Promise<LSPClient | undefined>>();
  private broken = new Set<string>();
  private failures = new Map<string, LSPFailure>();
  private cwd: string;
  private serverConfigs: RuntimeServerConfig[];
  private configWarnings: LSPConfigWarning[];
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(cwd: string, configPaths: { globalConfigPath?: string; projectConfigPath?: string } = {}) {
    this.cwd = cwd;
    const config = resolveLSPConfig({
      cwd,
      builtins: LSP_SERVERS,
      projectConfigPath: configPaths.projectConfigPath,
      globalConfigPath: configPaths.globalConfigPath,
    });
    this.serverConfigs = config.servers.filter((server) => !server.disabled).map(runtimeServerConfig);
    this.configWarnings = [...config.warnings];

    // These builtins have special executable discovery/fallback logic. Make
    // an explicit global command/args override visible because it opts out.
    const specialDiscoveryServers = new Set(["dart", "typescript", "kotlin", "swift", "ruby"]);
    for (const server of config.servers) {
      if (server.builtin && specialDiscoveryServers.has(server.id)
        && (server.globalOverrides.has("command") || server.globalOverrides.has("args"))) {
        this.configWarnings.push({
          path: configPaths.globalConfigPath ?? defaultGlobalLSPConfigPath(),
          server: server.id,
          message: "command/args override uses the configured command directly and disables builtin executable discovery/fallbacks",
        });
      }
    }
    this.cleanupTimer = setInterval(() => this.cleanupIdleFiles(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  getConfigWarnings(): readonly LSPConfigWarning[] { return this.configWarnings; }

  getServerConfigs(): readonly ResolvedLSPServerConfig[] { return this.serverConfigs; }

  getServersForFile(filePath: string): readonly ResolvedLSPServerConfig[] {
    const extension = path.extname(filePath).toLowerCase();
    return this.serverConfigs.filter((server) => server.extensions.includes(extension));
  }

  getServerForFile(filePath: string): ResolvedLSPServerConfig | undefined {
    return this.getServersForFile(filePath)[0];
  }

  diagnosticsWaitMsForFile(filePath: string): number {
    const extension = path.extname(filePath).toLowerCase();
    const waits = this.serverConfigs
      .filter((server) => server.extensions.includes(extension))
      .map((server) => server.diagnosticsWaitMs);
    return waits.length ? Math.max(...waits) : 3000;
  }

  private cleanupIdleFiles() {
    const now = Date.now();
    for (const client of this.clients.values()) {
      for (const [fp, state] of client.openFiles) {
        if (now - state.lastAccess > IDLE_TIMEOUT_MS) this.closeFile(client, fp);
      }
    }
  }

  private closeFile(client: LSPClient, absPath: string) {
    if (!client.openFiles.has(absPath)) return;
    client.openFiles.delete(absPath);
    if (client.closed) return;
    try {
      void client.connection.sendNotification(DidCloseTextDocumentNotification.type, {
        textDocument: { uri: pathToFileURL(absPath).href },
      }).catch(() => {});
    } catch {}
  }

  private evictLRU(client: LSPClient) {
    if (client.openFiles.size <= MAX_OPEN_FILES) return;
    let oldest: { path: string; time: number } | null = null;
    for (const [fp, s] of client.openFiles) {
      if (!oldest || s.lastAccess < oldest.time) oldest = { path: fp, time: s.lastAccess };
    }
    if (oldest) this.closeFile(client, oldest.path);
  }

  private key(id: string, root: string) { return `${id}:${root}`; }

  private recordFailure(k: string, error: unknown): void {
    const previous = this.failures.get(k);
    const attempts = Math.min((previous?.attempts ?? 0) + 1, MAX_RESTART_ATTEMPTS);
    const backoff = RESTART_BACKOFF_MS[attempts - 1] ?? RESTART_BACKOFF_MS[RESTART_BACKOFF_MS.length - 1];
    this.failures.set(k, {
      attempts,
      nextRetryAt: Date.now() + backoff,
      message: error instanceof Error ? error.message : String(error || "language server failed"),
    });
    this.broken.add(k);
  }

  private canRetry(k: string): boolean {
    const failure = this.failures.get(k);
    return !failure || Date.now() >= failure.nextRetryAt;
  }

  /** Return process-level health for servers known to this manager. */
  getHealth(): LSPHealth[] {
    const keys = new Set([...this.clients.keys(), ...this.failures.keys(), ...this.spawning.keys()]);
    return [...keys].map((key) => {
      const [server, ...rootParts] = key.split(":");
      const root = rootParts.join(":");
      const client = this.clients.get(key);
      const failure = this.failures.get(key);
      if (client && !client.closed && client.process.exitCode === null) {
        return { server, root, status: "healthy", attempts: failure?.attempts ?? 0 };
      }
      if (this.spawning.has(key)) {
        return { server, root, status: "starting", attempts: failure?.attempts ?? 0 };
      }
      if (failure && Date.now() < failure.nextRetryAt) {
        return { server, root, status: "backoff", attempts: failure.attempts, retryAt: failure.nextRetryAt, error: failure.message };
      }
      return { server, root, status: "failed", attempts: failure?.attempts ?? 0, error: failure?.message };
    });
  }

  private async initClient(config: RuntimeServerConfig, root: string): Promise<LSPClient | undefined> {
    const k = this.key(config.id, root);
    let spawnedProcess: ChildProcessWithoutNullStreams | undefined;
    let failureRecorded = false;
    try {
      const handle = await config.spawn(root);
      spawnedProcess = handle?.process;
      if (!handle) { this.recordFailure(k, `Unable to start ${config.id}`); return undefined; }

      const reader = new StreamMessageReader(handle.process.stdout!);
      const writer = new StreamMessageWriter(handle.process.stdin!);
      const conn = createMessageConnection(reader, writer);
      
      // Prevent crashes from stream errors
      handle.process.stdin?.on("error", () => {});
      handle.process.stdout?.on("error", () => {});

      const stderr: string[] = [];
      const MAX_STDERR_LINES = 200;
      handle.process.stderr?.on("data", (chunk: Buffer) => {
        try {
          const text = chunk.toString("utf-8");
          for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) continue;
            stderr.push(line);
            if (stderr.length > MAX_STDERR_LINES) stderr.splice(0, stderr.length - MAX_STDERR_LINES);
          }
        } catch {
          // ignore
        }
      });
      handle.process.stderr?.on("error", () => {});

      const client: LSPClient = {
        connection: conn,
        process: handle.process,
        diagnostics: new Map(),
        openFiles: new Map(),
        listeners: new Map(),
        stderr,
        root,
        config,
        closed: false,
        stopping: false,
        failureRecorded: false,
      };

      conn.onNotification("textDocument/publishDiagnostics", (params: { uri: string; diagnostics: Diagnostic[] }) => {
        const fpRaw = decodeURIComponent(new URL(params.uri).pathname);
        const fp = normalizeFsPath(fpRaw);

        client.diagnostics.set(fp, params.diagnostics);
        // Notify both raw and normalized paths (macOS often reports /private/var vs /var)
        const listeners1 = client.listeners.get(fp);
        const listeners2 = fp !== fpRaw ? client.listeners.get(fpRaw) : undefined;

        listeners1?.slice().forEach(fn => { try { fn(); } catch { /* listener error */ } });
        listeners2?.slice().forEach(fn => { try { fn(); } catch { /* listener error */ } });
      });

      // Handle errors to prevent crashes
      conn.onError((error) => {
        if (!client.stopping && !client.failureRecorded) {
          client.failureRecorded = true;
          failureRecorded = true;
          this.recordFailure(k, error);
        }
      });
      conn.onClose(() => {
        client.closed = true;
        this.clients.delete(k);
        if (!client.stopping && !client.failureRecorded) {
          client.failureRecorded = true;
          failureRecorded = true;
          this.recordFailure(k, "Language server connection closed unexpectedly");
          terminateProcess(client.process);
        }
      });

      conn.onRequest("workspace/configuration", () => [handle.initOptions ?? {}]);
      conn.onRequest("window/workDoneProgress/create", () => null);
      conn.onRequest("client/registerCapability", () => {});
      conn.onRequest("client/unregisterCapability", () => {});
      conn.onRequest("workspace/workspaceFolders", () => [{ name: "workspace", uri: pathToFileURL(root).href }]);

      handle.process.on("exit", (code, signal) => {
        client.closed = true;
        this.clients.delete(k);
        if (!client.stopping && !client.failureRecorded) {
          client.failureRecorded = true;
          failureRecorded = true;
          this.recordFailure(k, `Language server exited${code !== null ? ` with code ${code}` : ` (${signal || "unknown signal"})`}`);
        }
      });
      handle.process.on("error", (error) => {
        client.closed = true;
        this.clients.delete(k);
        if (!client.stopping && !client.failureRecorded) {
          client.failureRecorded = true;
          failureRecorded = true;
          this.recordFailure(k, error);
        }
      });

      conn.listen();

      const initResult = await timeout(conn.sendRequest(InitializeRequest.method, {
        rootUri: pathToFileURL(root).href,
        rootPath: root,
        processId: process.pid,
        workspaceFolders: [{ name: "workspace", uri: pathToFileURL(root).href }],
        initializationOptions: handle.initOptions ?? {},
        capabilities: {
          window: { workDoneProgress: true },
          workspace: { configuration: true },
          textDocument: {
            synchronization: { didSave: true, didOpen: true, didChange: true, didClose: true },
            publishDiagnostics: { versionSupport: true },
            diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
          },
        },
      }), INIT_TIMEOUT_MS, `${config.id} init`);

      client.capabilities = (initResult as any)?.capabilities;

      conn.sendNotification(InitializedNotification.type, {});
      if (handle.initOptions) {
        conn.sendNotification("workspace/didChangeConfiguration", { settings: handle.initOptions });
      }
      // A server that stays alive briefly is considered healthy; this prevents
      // one transient crash from permanently disabling the project.
      setTimeout(() => {
        if (this.clients.get(k) === client && !client.closed) this.failures.delete(k);
      }, STABLE_PROCESS_MS).unref();
      return client;
    } catch (error) {
      if (spawnedProcess) terminateProcess(spawnedProcess);
      if (!failureRecorded) this.recordFailure(k, error);
      return undefined;
    }
  }

  async getClientsForFile(filePath: string): Promise<LSPClient[]> {
    const ext = path.extname(filePath);
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(this.cwd, filePath);
    const clients: LSPClient[] = [];

    for (const config of this.serverConfigs) {
      if (!config.extensions.includes(ext.toLowerCase())) continue;
      const root = config.findRoot(absPath, this.cwd);
      if (!root) continue;
      const k = this.key(config.id, root);

      const existing = this.clients.get(k);
      if (existing && !existing.closed && existing.process.exitCode === null) {
        clients.push(existing);
        continue;
      }
      if (existing) this.clients.delete(k);
      if (!this.canRetry(k)) continue;

      if (!this.spawning.has(k)) {
        const p = this.initClient(config, root);
        this.spawning.set(k, p);
        p.finally(() => this.spawning.delete(k));
      }
      const client = await this.spawning.get(k);
      if (client && !client.closed && client.process.exitCode === null) {
        this.clients.set(k, client);
        clients.push(client);
      }
    }
    return clients;
  }

  private resolve(fp: string) {
    const abs = path.isAbsolute(fp) ? fp : path.resolve(this.cwd, fp);
    return normalizeFsPath(abs);
  }
  private langId(client: LSPClient, fp: string) {
    const extension = path.extname(fp).toLowerCase();
    return client.config.languageIds[extension] ?? LANGUAGE_IDS[extension] ?? "plaintext";
  }
  private readFile(fp: string): string | null { try { return fs.readFileSync(fp, "utf-8"); } catch { return null; } }

  private explainNoLsp(absPath: string): string {
    const ext = path.extname(absPath).toLowerCase();
    const config = this.serverConfigs.find((server) => server.extensions.includes(ext));

    if (config) {
      const root = runtimeServerConfig(config).findRoot(absPath, this.cwd);
      if (!root) return `No ${config.id} project root detected for ${ext}. Add one of the configured root markers or use a file inside the project.`;

      const failure = this.failures.get(this.key(config.id, root));
      if (failure) {
        const retry = failure.nextRetryAt > Date.now()
          ? ` Retry in ${Math.ceil((failure.nextRetryAt - Date.now()) / 1000)}s.`
          : " Retry will be attempted on the next request.";
        return `${config.id} failed for root ${root}.${failure.message ? ` ${failure.message}.` : ""}${retry}`;
      }

      if (config.id === "kotlin") {
        const hasJetbrains = !!(which("kotlin-lsp") || which("kotlin-lsp.sh") || which("kotlin-lsp.cmd") || process.env.PI_LSP_KOTLIN_LSP_PATH);
        if (!hasJetbrains && !which("kotlin-language-server")) {
          return "No Kotlin LSP binary found. Install Kotlin/kotlin-lsp (recommended) or org.javacs/kotlin-language-server.";
        }
      }
      if (config.id === "swift" && !which("sourcekit-lsp") && !which("xcrun")) {
        return "sourcekit-lsp not found (and xcrun missing).";
      }
      if (config.id === "ruby" && !process.env.PI_LSP_RUBY_LSP_PATH && !which("ruby-lsp") && !which("bundle") && !fs.existsSync(path.join(root, "bin", "ruby-lsp"))) {
        return "Ruby LSP not found. Install the ruby-lsp gem, set PI_LSP_RUBY_LSP_PATH, or add bin/ruby-lsp to the project.";
      }
      return `${config.id} is unavailable for root ${root}; verify its executable is installed and on PATH.`;
    }

    const disabled = LSP_SERVERS.find((server) => server.extensions.includes(ext));
    return disabled
      ? `${disabled.id} is disabled by LSP configuration.`
      : `No configured LSP for ${ext}. Supported project files require a recognized project root and an installed language-server binary.`;
  }

  private toPos(line: number, col: number) { return { line: Math.max(0, line - 1), character: Math.max(0, col - 1) }; }

  private normalizeLocs(result: Location | Location[] | LocationLink[] | null | undefined): Location[] {
    if (!result) return [];
    const items = Array.isArray(result) ? result : [result];
    if (!items.length) return [];
    if ("uri" in items[0] && "range" in items[0]) return items as Location[];
    return (items as LocationLink[]).map(l => ({ uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange }));
  }

  private normalizeSymbols(result: DocumentSymbol[] | SymbolInformation[] | null | undefined): DocumentSymbol[] {
    if (!result?.length) return [];
    const first = result[0];
    if ("location" in first) {
      return (result as SymbolInformation[]).map(s => ({
        name: s.name, kind: s.kind, range: s.location.range, selectionRange: s.location.range,
        detail: s.containerName, tags: s.tags, deprecated: s.deprecated, children: [],
      }));
    }
    return result as DocumentSymbol[];
  }

  private async openOrUpdate(clients: LSPClient[], absPath: string, uri: string, content: string, evict = true) {
    const now = Date.now();
    for (const client of clients) {
      const langId = this.langId(client, absPath);
      if (client.closed) continue;
      const state = client.openFiles.get(absPath);
      try {
        if (state) {
          const v = state.version + 1;
          client.openFiles.set(absPath, { version: v, lastAccess: now });
          void client.connection.sendNotification(DidChangeTextDocumentNotification.type, {
            textDocument: { uri, version: v }, contentChanges: [{ text: content }],
          }).catch(() => {});
        } else {
          // For some servers (e.g. kotlin-language-server), diagnostics only start flowing after a didChange.
          // We open at version 0, then immediately send a full-content didChange at version 1.
          client.openFiles.set(absPath, { version: 1, lastAccess: now });
          void client.connection.sendNotification(DidOpenTextDocumentNotification.type, {
            textDocument: { uri, languageId: langId, version: 0, text: content },
          }).catch(() => {});
          void client.connection.sendNotification(DidChangeTextDocumentNotification.type, {
            textDocument: { uri, version: 1 }, contentChanges: [{ text: content }],
          }).catch(() => {});
          if (evict) this.evictLRU(client);
        }
        // Send didSave to trigger analysis (important for TypeScript)
        void client.connection.sendNotification(DidSaveTextDocumentNotification.type, {
          textDocument: { uri }, text: content,
        }).catch(() => {});
      } catch {}
    }
  }

  private async loadFile(filePath: string) {
    const absPath = this.resolve(filePath);
    const clients = await this.getClientsForFile(absPath);
    if (!clients.length) return null;
    const content = this.readFile(absPath);
    if (content === null) return null;
    return { clients, absPath, uri: pathToFileURL(absPath).href, content };
  }

  private waitForDiagnostics(client: LSPClient, absPath: string, timeoutMs: number, isNew: boolean): Promise<boolean> {
    return new Promise(resolve => {
      if (client.closed) return resolve(false);

      let resolved = false;
      let settleTimer: NodeJS.Timeout | null = null;
      let listener: () => void = () => {};

      const cleanupListener = () => {
        const listeners = client.listeners.get(absPath);
        if (!listeners) return;
        const idx = listeners.indexOf(listener);
        if (idx !== -1) listeners.splice(idx, 1);
        if (listeners.length === 0) client.listeners.delete(absPath);
      };

      const finish = (value: boolean) => {
        if (resolved) return;
        resolved = true;
        if (settleTimer) clearTimeout(settleTimer);
        clearTimeout(timer);
        cleanupListener();
        resolve(value);
      };

      // Some servers publish diagnostics multiple times (often empty first, then real results).
      // For new documents, if diagnostics are still empty, debounce a bit.
      listener = () => {
        if (resolved) return;

        const current = client.diagnostics.get(absPath);
        if (current && current.length > 0) return finish(true);

        if (!isNew) return finish(true);

        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => finish(true), 2500);
        (settleTimer as any).unref?.();
      };

      const timer = setTimeout(() => finish(false), timeoutMs);
      (timer as any).unref?.();

      const listeners = client.listeners.get(absPath) || [];
      listeners.push(listener);
      client.listeners.set(absPath, listeners);
    });
  }

  private async pullDiagnostics(client: LSPClient, absPath: string, uri: string): Promise<{ diagnostics: Diagnostic[]; responded: boolean }> {
    if (client.closed) return { diagnostics: [], responded: false };

    // Only attempt Pull Diagnostics if the server advertises support.
    // (Some servers throw and log noisy errors if we call these methods.)
    if (!client.capabilities || !(client.capabilities as any).diagnosticProvider) {
      return { diagnostics: [], responded: false };
    }

    // Prefer new Pull Diagnostics if supported by the server
    try {
      const res: any = await client.connection.sendRequest(DocumentDiagnosticRequest.method, {
        textDocument: { uri },
      });

      if (res?.kind === DocumentDiagnosticReportKind.Full) {
        return { diagnostics: Array.isArray(res.items) ? res.items : [], responded: true };
      }
      if (res?.kind === DocumentDiagnosticReportKind.Unchanged) {
        return { diagnostics: client.diagnostics.get(absPath) || [], responded: true };
      }
      if (Array.isArray(res?.items)) {
        return { diagnostics: res.items, responded: true };
      }
      return { diagnostics: [], responded: true };
    } catch {
      // ignore
    }

    // Fallback: some servers only support WorkspaceDiagnosticRequest
    try {
      const res: any = await client.connection.sendRequest(WorkspaceDiagnosticRequest.method, {
        previousResultIds: [],
      });

      const items: any[] = res?.items || [];
      const match = items.find((it: any) => it?.uri === uri);
      if (match?.kind === DocumentDiagnosticReportKind.Full) {
        return { diagnostics: Array.isArray(match.items) ? match.items : [], responded: true };
      }
      if (Array.isArray(match?.items)) {
        return { diagnostics: match.items, responded: true };
      }
      return { diagnostics: [], responded: true };
    } catch {
      return { diagnostics: [], responded: false };
    }
  }

  async touchFileAndWait(filePath: string, timeoutMs: number): Promise<{ diagnostics: Diagnostic[]; receivedResponse: boolean; unsupported?: boolean; error?: string }> {
    const absPath = this.resolve(filePath);

    if (!fs.existsSync(absPath)) {
      return { diagnostics: [], receivedResponse: false, unsupported: true, error: "File not found" };
    }

    const clients = await this.getClientsForFile(absPath);
    if (!clients.length) {
      return { diagnostics: [], receivedResponse: false, unsupported: true, error: this.explainNoLsp(absPath) };
    }

    const content = this.readFile(absPath);
    if (content === null) {
      return { diagnostics: [], receivedResponse: false, unsupported: true, error: "Could not read file" };
    }

    const uri = pathToFileURL(absPath).href;
    const isNew = clients.some(c => !c.openFiles.has(absPath));

    const waits = clients.map(c => this.waitForDiagnostics(c, absPath, timeoutMs, isNew));
    await this.openOrUpdate(clients, absPath, uri, content);
    const results = await Promise.all(waits);

    let responded = results.some(r => r);
    const diags: Diagnostic[] = [];
    for (const c of clients) {
      const d = c.diagnostics.get(absPath);
      if (d) diags.push(...d);
    }
    if (!responded && clients.some(c => c.diagnostics.has(absPath))) responded = true;

    // If we didn't get pushed diagnostics (common for some servers), try pull diagnostics.
    if (!responded || diags.length === 0) {
      const pulled = await Promise.all(clients.map(c => this.pullDiagnostics(c, absPath, uri)));
      for (let i = 0; i < clients.length; i++) {
        const r = pulled[i];
        if (r.responded) responded = true;
        if (r.diagnostics.length) {
          clients[i].diagnostics.set(absPath, r.diagnostics);
          diags.push(...r.diagnostics);
        }
      }
    }

    return {
      diagnostics: diags,
      receivedResponse: responded,
      ...(!responded ? { error: "LSP server did not respond. It may still be starting or may have crashed; retry the request." } : {}),
    };
  }

  async getDiagnosticsForFiles(files: string[], timeoutMs: number): Promise<FileDiagnosticsResult> {
    const unique = [...new Set(files.map(f => this.resolve(f)))];
    const results: FileDiagnosticItem[] = [];
    const toClose: Map<LSPClient, string[]> = new Map();

    for (const absPath of unique) {
      if (!fs.existsSync(absPath)) {
        results.push({ file: absPath, diagnostics: [], status: 'error', error: 'File not found' });
        continue;
      }

      let clients: LSPClient[];
      try { clients = await this.getClientsForFile(absPath); }
      catch (e) { results.push({ file: absPath, diagnostics: [], status: 'error', error: String(e) }); continue; }

      if (!clients.length) {
        results.push({ file: absPath, diagnostics: [], status: 'unsupported', error: this.explainNoLsp(absPath) });
        continue;
      }

      const content = this.readFile(absPath);
      if (!content) {
        results.push({ file: absPath, diagnostics: [], status: 'error', error: 'Could not read file' });
        continue;
      }

      const uri = pathToFileURL(absPath).href;
      const isNew = clients.some(c => !c.openFiles.has(absPath));

      for (const c of clients) {
        if (!c.openFiles.has(absPath)) {
          if (!toClose.has(c)) toClose.set(c, []);
          toClose.get(c)!.push(absPath);
        }
      }

      const waits = clients.map(c => this.waitForDiagnostics(c, absPath, timeoutMs, isNew));
      await this.openOrUpdate(clients, absPath, uri, content, false)
      const waitResults = await Promise.all(waits);

      const diags: Diagnostic[] = [];
      for (const c of clients) { const d = c.diagnostics.get(absPath); if (d) diags.push(...d); }

      let responded = waitResults.some(r => r) || diags.length > 0;

      if (!responded || diags.length === 0) {
        const pulled = await Promise.all(clients.map(c => this.pullDiagnostics(c, absPath, uri)));
        for (let i = 0; i < clients.length; i++) {
          const r = pulled[i];
          if (r.responded) responded = true;
          if (r.diagnostics.length) {
            clients[i].diagnostics.set(absPath, r.diagnostics);
            diags.push(...r.diagnostics);
          }
        }
      }

      if (!responded && !diags.length) {
        results.push({ file: absPath, diagnostics: [], status: 'timeout', error: 'LSP server did not respond. It may be starting or have crashed; retry the request.' });
      } else {
        results.push({ file: absPath, diagnostics: diags, status: 'ok' });
      }
    }

    // Cleanup opened files
    for (const [c, fps] of toClose) { for (const fp of fps) this.closeFile(c, fp); }
    for (const c of this.clients.values()) { while (c.openFiles.size > MAX_OPEN_FILES) this.evictLRU(c); }

    return { items: results };
  }

  async getDefinition(fp: string, line: number, col: number): Promise<Location[]> {
    const l = await this.loadFile(fp);
    if (!l) return [];
    await this.openOrUpdate(l.clients, l.absPath, l.uri, l.content);
    const pos = this.toPos(line, col);
    const results = await Promise.all(l.clients.map(async c => {
      if (c.closed) return [];
      try { return this.normalizeLocs(await c.connection.sendRequest(DefinitionRequest.type, { textDocument: { uri: l.uri }, position: pos })); }
      catch { return []; }
    }));
    return results.flat();
  }

  async getReferences(fp: string, line: number, col: number): Promise<Location[]> {
    const l = await this.loadFile(fp);
    if (!l) return [];
    await this.openOrUpdate(l.clients, l.absPath, l.uri, l.content);
    const pos = this.toPos(line, col);
    const results = await Promise.all(l.clients.map(async c => {
      if (c.closed) return [];
      try { return this.normalizeLocs(await c.connection.sendRequest(ReferencesRequest.type, { textDocument: { uri: l.uri }, position: pos, context: { includeDeclaration: true } })); }
      catch { return []; }
    }));
    return results.flat();
  }

  async getHover(fp: string, line: number, col: number): Promise<Hover | null> {
    const l = await this.loadFile(fp);
    if (!l) return null;
    await this.openOrUpdate(l.clients, l.absPath, l.uri, l.content);
    const pos = this.toPos(line, col);
    for (const c of l.clients) {
      if (c.closed) continue;
      try { const r = await c.connection.sendRequest(HoverRequest.type, { textDocument: { uri: l.uri }, position: pos }); if (r) return r; }
      catch {}
    }
    return null;
  }

  async getSignatureHelp(fp: string, line: number, col: number): Promise<SignatureHelp | null> {
    const l = await this.loadFile(fp);
    if (!l) return null;
    await this.openOrUpdate(l.clients, l.absPath, l.uri, l.content);
    const pos = this.toPos(line, col);
    for (const c of l.clients) {
      if (c.closed) continue;
      try { const r = await c.connection.sendRequest(SignatureHelpRequest.type, { textDocument: { uri: l.uri }, position: pos }); if (r) return r; }
      catch {}
    }
    return null;
  }

  async getDocumentSymbols(fp: string): Promise<DocumentSymbol[]> {
    const l = await this.loadFile(fp);
    if (!l) return [];
    await this.openOrUpdate(l.clients, l.absPath, l.uri, l.content);
    const results = await Promise.all(l.clients.map(async c => {
      if (c.closed) return [];
      try { return this.normalizeSymbols(await c.connection.sendRequest(DocumentSymbolRequest.type, { textDocument: { uri: l.uri } })); }
      catch { return []; }
    }));
    return results.flat();
  }

  async rename(fp: string, line: number, col: number, newName: string): Promise<WorkspaceEdit | null> {
    const l = await this.loadFile(fp);
    if (!l) return null;
    await this.openOrUpdate(l.clients, l.absPath, l.uri, l.content);
    const pos = this.toPos(line, col);
    for (const c of l.clients) {
      if (c.closed) continue;
      try {
        const r = await c.connection.sendRequest(RenameRequest.type, {
          textDocument: { uri: l.uri },
          position: pos,
          newName,
        });
        if (r) return r;
      } catch {}
    }
    return null;
  }

  async getCodeActions(fp: string, startLine: number, startCol: number, endLine?: number, endCol?: number): Promise<(CodeAction | Command)[]> {
    const l = await this.loadFile(fp);
    if (!l) return [];
    await this.openOrUpdate(l.clients, l.absPath, l.uri, l.content);
    
    const start = this.toPos(startLine, startCol);
    const end = this.toPos(endLine ?? startLine, endCol ?? startCol);
    const range = { start, end };
    
    // Get diagnostics for this range to include in context
    const diagnostics: Diagnostic[] = [];
    for (const c of l.clients) {
      const fileDiags = c.diagnostics.get(l.absPath) || [];
      for (const d of fileDiags) {
        if (this.rangesOverlap(d.range, range)) diagnostics.push(d);
      }
    }
    
    const results = await Promise.all(l.clients.map(async c => {
      if (c.closed) return [];
      try {
        const r = await c.connection.sendRequest(CodeActionRequest.type, {
          textDocument: { uri: l.uri },
          range,
          context: { diagnostics, only: [CodeActionKind.QuickFix, CodeActionKind.Refactor, CodeActionKind.Source] },
        });
        return r || [];
      } catch { return []; }
    }));
    return results.flat();
  }

  private rangesOverlap(a: { start: { line: number; character: number }; end: { line: number; character: number } }, 
                        b: { start: { line: number; character: number }; end: { line: number; character: number } }): boolean {
    if (a.end.line < b.start.line || b.end.line < a.start.line) return false;
    if (a.end.line === b.start.line && a.end.character < b.start.character) return false;
    if (b.end.line === a.start.line && b.end.character < a.start.character) return false;
    return true;
  }

  async shutdown() {
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
    const clients = Array.from(this.clients.values());
    this.clients.clear();
    for (const c of clients) {
      const wasClosed = c.closed;
      c.stopping = true;
      c.closed = true;
      if (!wasClosed) {
        try {
          await Promise.race([
            c.connection.sendRequest("shutdown"),
            new Promise(r => setTimeout(r, 1000))
          ]);
        } catch {}
        try { void c.connection.sendNotification("exit").catch(() => {}); } catch {}
      }
      try { c.connection.end(); } catch {}
      terminateProcess(c.process);
    }
  }
}

// Diagnostic Formatting
export { DiagnosticSeverity };
export type SeverityFilter = "all" | "error" | "warning" | "info" | "hint";

export function formatDiagnostic(d: Diagnostic): string {
  const sev = ["", "ERROR", "WARN", "INFO", "HINT"][d.severity || 1];
  return `${sev} [${d.range.start.line + 1}:${d.range.start.character + 1}] ${d.message}`;
}

export function filterDiagnosticsBySeverity(diags: Diagnostic[], filter: SeverityFilter): Diagnostic[] {
  if (filter === "all") return diags;
  const max = { error: 1, warning: 2, info: 3, hint: 4 }[filter];
  return diags.filter(d => (d.severity || 1) <= max);
}

// URI utilities
export function uriToPath(uri: string): string {
  if (uri.startsWith("file://")) try { return fileURLToPath(uri); } catch {}
  return uri;
}

export interface WorkspaceEditApplyOptions {
  /** Test hook; production callers use the default filesystem writer. */
  writeFile?: (filePath: string, content: string) => void;
}

/**
 * Apply a text-only WorkspaceEdit transactionally within cwd.
 * Rename remains preview-only by default in the tool; callers must explicitly
 * opt in to this helper because LSP servers can propose edits in many files.
 */
export function applyWorkspaceEdit(edit: WorkspaceEdit, cwd: string, options: WorkspaceEditApplyOptions = {}): number {
  const changes = new Map<string, Array<{ range: any; newText: string }>>();
  const workspaceRoot = fs.realpathSync(path.resolve(cwd));
  const add = (uri: string, edits: any[]) => {
    const filePath = uriToPath(uri);
    if (!path.isAbsolute(filePath)) throw new Error(`WorkspaceEdit contains a non-file path: ${uri}`);
    if (!fs.existsSync(filePath)) throw new Error(`WorkspaceEdit file not found: ${filePath}`);

    // Validate the canonical path as well as the lexical path so a symlink inside
    // the workspace cannot make an edit escape to an external file.
    const canonicalPath = fs.realpathSync(filePath);
    const relative = path.relative(workspaceRoot, canonicalPath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`WorkspaceEdit targets a file outside the workspace: ${filePath}`);
    }
    const existing = changes.get(canonicalPath) || [];
    existing.push(...edits.map((textEdit) => ({ range: textEdit.range, newText: String(textEdit.newText ?? "") })));
    changes.set(canonicalPath, existing);
  };

  for (const [uri, edits] of Object.entries((edit as any).changes || {})) add(uri, edits as any[]);
  for (const change of (edit as any).documentChanges || []) {
    if (!change?.textDocument?.uri || !Array.isArray(change.edits)) {
      throw new Error("WorkspaceEdit contains unsupported resource operations");
    }
    add(change.textDocument.uri, change.edits);
  }

  const originals = new Map<string, string>();
  const updated = new Map<string, string>();
  const offset = (content: string, position: { line: number; character: number }): number => {
    if (!Number.isInteger(position?.line) || !Number.isInteger(position?.character) || position.line < 0 || position.character < 0) {
      throw new Error("WorkspaceEdit contains an invalid text range");
    }
    let index = 0;
    for (let line = 0; line < position.line; line++) {
      const newline = content.indexOf("\n", index);
      if (newline === -1) throw new Error("WorkspaceEdit range is outside the file");
      index = newline + 1;
    }
    const lineEnd = content.indexOf("\n", index);
    const end = lineEnd === -1 ? content.length : lineEnd;
    const result = index + position.character;
    if (result > end) throw new Error("WorkspaceEdit range is outside the file");
    return result;
  };

  let editCount = 0;
  for (const [filePath, fileEdits] of changes) {
    const original = fs.readFileSync(filePath, "utf8");
    originals.set(filePath, original);
    const resolved = fileEdits.map((textEdit) => ({
      start: offset(original, textEdit.range.start),
      end: offset(original, textEdit.range.end),
      newText: textEdit.newText,
    })).sort((a, b) => b.start - a.start || b.end - a.end);
    for (let i = 0; i < resolved.length; i++) {
      if (resolved[i].start > resolved[i].end || (i > 0 && resolved[i - 1].start < resolved[i].end)) {
        throw new Error(`WorkspaceEdit contains overlapping or invalid edits for ${filePath}`);
      }
    }
    let next = original;
    for (const textEdit of resolved) next = next.slice(0, textEdit.start) + textEdit.newText + next.slice(textEdit.end);
    updated.set(filePath, next);
    editCount += resolved.length;
  }

  const writeFile = options.writeFile || ((filePath: string, content: string) => fs.writeFileSync(filePath, content, "utf8"));
  try {
    for (const [filePath, content] of updated) writeFile(filePath, content);
  } catch (error) {
    for (const [filePath, content] of originals) {
      try { writeFile(filePath, content); } catch { /* best-effort rollback */ }
    }
    throw new Error(`Failed to apply WorkspaceEdit: ${error instanceof Error ? error.message : String(error)}`);
  }
  return editCount;
}

// Symbol search
export function findSymbolPosition(symbols: DocumentSymbol[], query: string): { line: number; character: number } | null {
  const q = query.toLowerCase();
  let exact: { line: number; character: number } | null = null;
  let partial: { line: number; character: number } | null = null;

  const visit = (items: DocumentSymbol[]) => {
    for (const sym of items) {
      const name = String(sym?.name ?? "").toLowerCase();
      const pos = sym?.selectionRange?.start ?? sym?.range?.start;
      if (pos && typeof pos.line === "number" && typeof pos.character === "number") {
        if (!exact && name === q) exact = pos;
        if (!partial && name.includes(q)) partial = pos;
      }
      if (sym?.children?.length) visit(sym.children);
    }
  };
  visit(symbols);
  return exact ?? partial;
}

export async function resolvePosition(manager: LSPManager, file: string, query: string): Promise<{ line: number; column: number } | null> {
  const symbols = await manager.getDocumentSymbols(file);
  const pos = findSymbolPosition(symbols, query);
  return pos ? { line: pos.line + 1, column: pos.character + 1 } : null;
}

/**
 * Format a list of document symbols into display lines.
 *
 * Uses `selectionRange` (the identifier's own range) rather than `range` (the
 * full declaration span) so that the reported line:column points at the symbol
 * name itself — the position that hover, definition, and references requests
 * all expect.  Falls back to `range` for servers that omit `selectionRange`.
 */
export function collectSymbols(symbols: DocumentSymbol[], depth = 0, lines: string[] = [], query?: string): string[] {
  for (const sym of symbols) {
    const name = (sym as any)?.name ?? "<unknown>";
    if (query && !name.toLowerCase().includes(query.toLowerCase())) {
      if ((sym as any).children?.length) collectSymbols((sym as any).children, depth + 1, lines, query);
      continue;
    }
    const startPos = sym?.selectionRange?.start ?? sym?.range?.start;
    const loc = startPos ? `${startPos.line + 1}:${startPos.character + 1}` : "";
    lines.push(`${"  ".repeat(depth)}${name}${loc ? ` (${loc})` : ""}`);
    if ((sym as any).children?.length) collectSymbols((sym as any).children, depth + 1, lines, query);
  }
  return lines;
}
