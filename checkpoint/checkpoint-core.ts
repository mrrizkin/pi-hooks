/**
 * Core checkpoint functions - shared between hook and tests
 *
 * This module contains all git operations for creating and restoring checkpoints.
 * It has no dependencies on the pi-coding-agent hook system.
 */

import { spawn } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { statSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join, isAbsolute } from "path";

// ============================================================================
// Constants & Types
// ============================================================================

export const ZEROS = "0".repeat(40);
export const REF_BASE = "refs/pi-checkpoints";

/** Maximum size for untracked files to be included in snapshot (10 MiB) */
export const MAX_UNTRACKED_FILE_SIZE = 10 * 1024 * 1024; // 10 MiB

/** Maximum number of files in an untracked directory to be included in snapshot */
export const MAX_UNTRACKED_DIR_FILES = 200;

/**
 * Directories to exclude from checkpoint snapshots.
 * Based on Codex's ghost commit implementation.
 * These are matched against any path component (e.g., foo/node_modules/bar is excluded).
 */
export const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  ".venv",
  "venv",
  "env",
  ".env",
  "dist",
  "build",
  ".pytest_cache",
  ".mypy_cache",
  ".cache",
  ".tox",
  "__pycache__",
]);

export interface CheckpointData {
  id: string;
  turnIndex: number;
  sessionId: string;
  headSha: string;
  indexTreeSha: string;
  worktreeTreeSha: string;
  timestamp: number;
  /** Untracked files that existed when snapshot was created (for safe restore) */
  preexistingUntrackedFiles?: string[];
  /** Untracked files that were skipped due to size limits (> 10 MiB) */
  skippedLargeFiles?: string[];
  /** Untracked directories that were skipped due to file count limits (> 200 files) */
  skippedLargeDirs?: string[];
}

// ============================================================================
// Git helpers
// ============================================================================

/**
 * Parse a command string into arguments, handling quotes.
 * This avoids shell injection by not using shell execution.
 */
export function parseGitArgs(cmd: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;

  for (const char of cmd) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }

  if (escaped || quote) throw new Error("Malformed git command: unterminated quote or escape");
  if (started) args.push(current);
  return args;
}

interface GitOptions {
  env?: NodeJS.ProcessEnv;
  input?: string;
  /** Preserve output whitespace for NUL-delimited Git commands. */
  trimOutput?: boolean;
}

function runGit(args: string[], cwd: string, opts: GitOptions = {}): Promise<string> {
  if (args.length === 0 || args.some((arg) => arg.includes("\0"))) {
    return Promise.reject(new Error("Invalid git arguments"));
  }

  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn("git", args, {
        cwd,
        env: opts.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    proc.on("close", (code: number | null) => {
      if (code === 0) resolve(opts.trimOutput === false ? stdout : stdout.trim());
      else reject(new Error(stderr.trim() || `git ${args.join(" ")} failed with code ${code}`));
    });
    proc.on("error", reject);

    if (opts.input !== undefined) proc.stdin.end(opts.input);
    else proc.stdin.end();
  });
}

/** Execute git with an explicit argv array. Dynamic paths must use this API. */
export function gitArgs(args: string[], cwd: string, opts: GitOptions = {}): Promise<string> {
  return runGit(args, cwd, opts);
}

/**
 * Execute a static git command string. This compatibility wrapper does not use a shell;
 * callers handling dynamic values should use gitArgs instead.
 */
export function git(cmd: string, cwd: string, opts: GitOptions = {}): Promise<string> {
  return runGit(parseGitArgs(cmd), cwd, opts);
}

export function gitLowPriorityArgs(args: string[], cwd: string): Promise<string> {
  if (args.length === 0 || args.some((arg) => arg.includes("\0"))) {
    return Promise.reject(new Error("Invalid git arguments"));
  }
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    proc.on("close", (code: number | null) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `git ${args.join(" ")} failed with code ${code}`));
    });
    proc.on("error", reject);
  });
}

export function gitLowPriority(cmd: string, cwd: string): Promise<string> {
  return gitLowPriorityArgs(parseGitArgs(cmd), cwd);
}

export const isGitRepo = (cwd: string) =>
  git("rev-parse --is-inside-work-tree", cwd)
    .then(() => true)
    .catch(() => false);

export const getRepoRoot = (cwd: string) =>
  git("rev-parse --show-toplevel", cwd);

// ============================================================================
// Path filtering
// ============================================================================

/**
 * Check if a path should be ignored for snapshot.
 * Returns true if ANY path component matches IGNORED_DIR_NAMES.
 * @param path - File path (relative to repo root)
 */
export function shouldIgnoreForSnapshot(path: string): boolean {
  // Split on both forward and back slashes for cross-platform support
  const components = path.split(/[/\\]/);
  return components.some((component) => IGNORED_DIR_NAMES.has(component));
}

/**
 * Check if a file is too large to include in snapshot.
 * @param root - Repository root path
 * @param relativePath - File path relative to repo root
 * @returns true if file exceeds MAX_UNTRACKED_FILE_SIZE
 */
export function isLargeFile(root: string, relativePath: string): boolean {
  try {
    const fullPath = join(root, relativePath);
    const stats = statSync(fullPath);
    return stats.isFile() && stats.size > MAX_UNTRACKED_FILE_SIZE;
  } catch {
    return false;
  }
}

/**
 * Count files recursively in a directory.
 * @param dirPath - Full path to directory
 * @param maxCount - Stop counting after this many files (optimization)
 * @returns Number of files (capped at maxCount + 1)
 */
function countFilesInDirectory(dirPath: string, maxCount: number): number {
  let count = 0;

  function countRecursive(currentPath: string): void {
    if (count > maxCount) return; // Early exit optimization

    try {
      const entries = readdirSync(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        if (count > maxCount) return;
        const fullPath = join(currentPath, entry.name);
        if (entry.isDirectory()) {
          countRecursive(fullPath);
        } else if (entry.isFile()) {
          count++;
        }
      }
    } catch {
      // Ignore permission errors etc.
    }
  }

  countRecursive(dirPath);
  return count;
}

/**
 * Check if an untracked directory has too many files to include in snapshot.
 * @param root - Repository root path
 * @param relativePath - Directory path relative to repo root
 * @returns true if directory contains at least MAX_UNTRACKED_DIR_FILES files
 */
export function isLargeDirectory(root: string, relativePath: string): boolean {
  try {
    const fullPath = join(root, relativePath);
    const stats = statSync(fullPath);
    if (!stats.isDirectory()) return false;

    const fileCount = countFilesInDirectory(fullPath, MAX_UNTRACKED_DIR_FILES);
    return fileCount >= MAX_UNTRACKED_DIR_FILES;
  } catch {
    return false;
  }
}

/**
 * Normalize a git-reported path to use forward slashes and no leading ./.
 */
function normalizeGitPath(path: string): string {
  let normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized.replace(/\/$/, "");
}

function getParentDir(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 1) return ".";
  return parts.slice(0, -1).join("/");
}

function pathDepth(path: string): number {
  return path.split(/[/\\]/).filter(Boolean).length;
}

function isPathWithinDir(path: string, dir: string): boolean {
  if (!dir || dir === ".") return true;
  if (path === dir) return true;
  return path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
}

function isPathWithinAnyDir(path: string, dirs: Set<string>): boolean {
  for (const dir of dirs) {
    if (isPathWithinDir(path, dir)) return true;
  }
  return false;
}

function isPathAncestorOfAnyDir(path: string, dirs: Set<string>): boolean {
  for (const dir of dirs) {
    if (isPathWithinDir(dir, path)) return true;
  }
  return false;
}

function extractStatusPathAfterFields(
  record: string,
  fieldsBeforePath: number
): string | null {
  if (fieldsBeforePath <= 0) return null;
  let spaces = 0;
  for (let i = 0; i < record.length; i++) {
    if (record[i] === " ") {
      spaces++;
      if (spaces === fieldsBeforePath) {
        const path = record.slice(i + 1);
        return path.length > 0 ? path : null;
      }
    }
  }
  return null;
}

interface LargeUntrackedDir {
  path: string;
  fileCount: number;
}

function detectLargeUntrackedDirs(
  files: string[],
  dirs: string[],
  threshold: number
): LargeUntrackedDir[] {
  if (threshold <= 0 || files.length === 0) return [];

  const counts = new Map<string, number>();
  const sortedDirs = [...dirs].sort((a, b) => {
    const depthDiff = pathDepth(b) - pathDepth(a);
    return depthDiff !== 0 ? depthDiff : a.localeCompare(b);
  });

  for (const file of files) {
    let key: string | null = null;
    for (const dir of sortedDirs) {
      if (isPathWithinDir(file, dir)) {
        key = dir;
        break;
      }
    }
    if (!key) {
      const parent = getParentDir(file);
      key = parent || ".";
    }
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const result = [...counts.entries()]
    .filter(([, count]) => count >= threshold)
    .map(([path, fileCount]) => ({ path, fileCount }))
    .filter((entry) => entry.path && entry.path !== ".");

  result.sort((a, b) => {
    const countDiff = b.fileCount - a.fileCount;
    return countDiff !== 0 ? countDiff : a.path.localeCompare(b.path);
  });

  return result;
}

/**
 * Get list of untracked files (excluding ignored directories).
 * Note: This always uses the real git index to determine untracked status.
 * @param root - Repository root path
 */
async function getUntrackedFiles(
  root: string
): Promise<string[]> {
  try {
    // Get untracked files (respects .gitignore)
    // Don't pass custom env - we want to use the real index
    const output = await gitArgs(["ls-files", "--others", "--exclude-standard", "-z"], root, { trimOutput: false });
    if (!output) return [];
    return output.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

interface StatusSnapshot {
  trackedPaths: string[];
  untrackedFiles: string[];
  untrackedFilesForIndex: string[];
  untrackedFilesForDirScan: string[];
  untrackedDirs: string[];
  skippedLargeFiles: string[];
}

async function captureStatusSnapshot(root: string): Promise<StatusSnapshot> {
  const snapshot: StatusSnapshot = {
    trackedPaths: [],
    untrackedFiles: [],
    untrackedFilesForIndex: [],
    untrackedFilesForDirScan: [],
    untrackedDirs: [],
    skippedLargeFiles: [],
  };

  const output = await git(
    "status --porcelain=2 -z --untracked-files=all",
    root
  ).catch(() => "");

  if (!output) return snapshot;

  const entries = output.split("\0").filter(Boolean);
  let expectRenameSource = false;

  for (const entry of entries) {
    if (expectRenameSource) {
      const normalized = normalizeGitPath(entry);
      if (normalized) snapshot.trackedPaths.push(normalized);
      expectRenameSource = false;
      continue;
    }

    const recordType = entry[0];
    switch (recordType) {
      case "?":
      case "!": {
        const spaceIndex = entry.indexOf(" ");
        if (spaceIndex === -1) break;
        const rawPath = entry.slice(spaceIndex + 1);
        if (!rawPath) break;
        const normalized = normalizeGitPath(rawPath);
        if (!normalized) break;
        if (shouldIgnoreForSnapshot(normalized)) break;

        const fullPath = join(root, normalized);
        let stats: ReturnType<typeof statSync> | null = null;
        try {
          stats = statSync(fullPath);
        } catch {
          stats = null;
        }

        if (stats?.isDirectory()) {
          snapshot.untrackedDirs.push(normalized);
          break;
        }

        snapshot.untrackedFiles.push(normalized);
        snapshot.untrackedFilesForDirScan.push(normalized);

        const isLarge = stats?.isFile()
          ? stats.size > MAX_UNTRACKED_FILE_SIZE
          : false;
        if (isLarge) {
          snapshot.skippedLargeFiles.push(normalized);
        } else {
          snapshot.untrackedFilesForIndex.push(normalized);
        }
        break;
      }
      case "1": {
        const path = extractStatusPathAfterFields(entry, 8);
        if (path) snapshot.trackedPaths.push(normalizeGitPath(path));
        break;
      }
      case "2": {
        const path = extractStatusPathAfterFields(entry, 9);
        if (path) snapshot.trackedPaths.push(normalizeGitPath(path));
        expectRenameSource = true;
        break;
      }
      case "u": {
        const path = extractStatusPathAfterFields(entry, 10);
        if (path) snapshot.trackedPaths.push(normalizeGitPath(path));
        break;
      }
      default:
        break;
    }
  }

  return snapshot;
}

/**
 * Result of getFilesToAdd with filtering information
 */
interface FilesToAddResult {
  /** Files to add to the snapshot (after all filtering) */
  filtered: string[];
  /** All untracked files (before filtering) */
  allUntracked: string[];
  /** Large files that were skipped (> 10 MiB) */
  skippedLargeFiles: string[];
  /** Large directories that were skipped (>= 200 untracked files) */
  skippedLargeDirs: string[];
}

/**
 * Get all files that would be added by `git add -A`, filtered by ignore list and size limits.
 * Note: This function uses the REAL git index (not a temporary one) to determine
 * which files are tracked/untracked. The env parameter is NOT passed to git commands
 * that query the index state.
 * @param root - Repository root path
 */
async function getFilesToAdd(
  root: string
): Promise<FilesToAddResult> {
  const status = await captureStatusSnapshot(root);

  const largeDirEntries = detectLargeUntrackedDirs(
    status.untrackedFilesForDirScan,
    status.untrackedDirs,
    MAX_UNTRACKED_DIR_FILES
  );

  const skippedLargeDirs = largeDirEntries.map((entry) => entry.path);
  const skippedLargeDirsSet = new Set(skippedLargeDirs);

  const untrackedFilesForIndex = status.untrackedFilesForIndex.filter(
    (path) => !isPathWithinAnyDir(path, skippedLargeDirsSet)
  );

  const skippedLargeFiles = status.skippedLargeFiles.filter(
    (path) => !isPathWithinAnyDir(path, skippedLargeDirsSet)
  );

  const filesToAddSet = new Set<string>();
  status.trackedPaths.forEach((path) => filesToAddSet.add(path));
  untrackedFilesForIndex.forEach((path) => filesToAddSet.add(path));

  return {
    filtered: [...filesToAddSet],
    allUntracked: status.untrackedFiles,
    skippedLargeFiles,
    skippedLargeDirs,
  };
}

// ============================================================================
// Checkpoint operations
// ============================================================================

export async function createCheckpoint(
  root: string,
  id: string,
  turnIndex: number,
  sessionId: string
): Promise<CheckpointData> {
  if (!isSafeId(id)) throw new Error("Checkpoint id contains unsafe characters");

  const timestamp = Date.now();
  const isoTimestamp = new Date(timestamp).toISOString();

  const headSha = await git("rev-parse HEAD", root).catch(() => ZEROS);
  const indexTreeSha = await git("write-tree", root);

  const tmpDir = await mkdtemp(join(tmpdir(), "pi-checkpoint-"));
  const tmpIndex = join(tmpDir, "index");

  try {
    const tmpEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };

    // Get files to add, filtering out ignored directories, large files, and large directories
    // Note: getFilesToAdd uses the real git index to determine tracked/untracked status
    const { filtered: filesToAdd, allUntracked, skippedLargeFiles, skippedLargeDirs } = await getFilesToAdd(
      root
    );

    // Filter untracked files to only include non-ignored, non-large ones for restore tracking
    const skippedLargeDirsSet = new Set(skippedLargeDirs);
    const skippedLargeFilesSet = new Set(skippedLargeFiles);
    const preexistingUntrackedFiles = allUntracked.filter((f) => {
      if (shouldIgnoreForSnapshot(f)) return false;
      if (skippedLargeFilesSet.has(f)) return false;
      if (isPathWithinAnyDir(f, skippedLargeDirsSet)) return false;
      return true;
    });

    // Start with tracked files from HEAD (if it exists)
    if (headSha !== ZEROS) {
      await gitArgs(["read-tree", headSha], root, { env: tmpEnv });
    }

    // Add filtered files to the temporary index
    if (filesToAdd.length > 0) {
      // Add files in batches to avoid command line length limits
      const BATCH_SIZE = 100;
      for (let i = 0; i < filesToAdd.length; i += BATCH_SIZE) {
        const batch = filesToAdd.slice(i, i + BATCH_SIZE);
        // Use -- to separate paths from options
        await gitArgs(["add", "--all", "--", ...batch], root, { env: tmpEnv });
      }
    }

    const worktreeTreeSha = await git("write-tree", root, { env: tmpEnv });

    // Encode data as JSON for storage in commit message
    const untrackedJson = JSON.stringify(preexistingUntrackedFiles);
    const largeFilesJson = JSON.stringify(skippedLargeFiles);
    const largeDirsJson = JSON.stringify(skippedLargeDirs);

    const message = [
      `checkpoint:${id}`,
      `sessionId ${sessionId}`,
      `turn ${turnIndex}`,
      `head ${headSha}`,
      `index-tree ${indexTreeSha}`,
      `worktree-tree ${worktreeTreeSha}`,
      `created ${isoTimestamp}`,
      `untracked ${untrackedJson}`,
      `largeFiles ${largeFilesJson}`,
      `largeDirs ${largeDirsJson}`,
    ].join("\n");

    const commitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "pi-checkpoint",
      GIT_AUTHOR_EMAIL: "checkpoint@pi",
      GIT_AUTHOR_DATE: isoTimestamp,
      GIT_COMMITTER_NAME: "pi-checkpoint",
      GIT_COMMITTER_EMAIL: "checkpoint@pi",
      GIT_COMMITTER_DATE: isoTimestamp,
    };

    const commitSha = await gitArgs(["commit-tree", worktreeTreeSha], root, {
      input: message,
      env: commitEnv,
    });

    await gitArgs(["update-ref", `${REF_BASE}/${id}`, commitSha], root);

    return {
      id,
      turnIndex,
      sessionId,
      headSha,
      indexTreeSha,
      worktreeTreeSha,
      timestamp,
      preexistingUntrackedFiles,
      skippedLargeFiles: skippedLargeFiles.length > 0 ? skippedLargeFiles : undefined,
      skippedLargeDirs: skippedLargeDirs.length > 0 ? skippedLargeDirs : undefined,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function restoreCheckpoint(
  root: string,
  cp: CheckpointData
): Promise<void> {
  const objectIds = [cp.headSha, cp.indexTreeSha, cp.worktreeTreeSha];
  if (objectIds.some((sha) => !/^[0-9a-f]{40}$/i.test(sha))) {
    throw new Error("Checkpoint contains an invalid Git object id");
  }

  // 1. Restore HEAD state
  if (cp.headSha !== ZEROS) {
    await gitArgs(["reset", "--hard", cp.headSha], root);
  }

  // 2. Update index AND working tree to match saved worktree snapshot
  await gitArgs(["read-tree", "--reset", "-u", cp.worktreeTreeSha], root);

  // 3. Safely remove untracked files - only remove NEW files, not pre-existing ones
  //    Also preserve large files and directories that were skipped during snapshot
  await safeCleanUntrackedFiles(
    root,
    cp.preexistingUntrackedFiles || [],
    cp.skippedLargeFiles || [],
    cp.skippedLargeDirs || []
  );

  // 4. Restore the index (staged state) without touching files
  await gitArgs(["read-tree", "--reset", cp.indexTreeSha], root);
}

/**
 * Safely clean untracked files, preserving those that existed before the snapshot.
 * This prevents deleting files in ignored directories (like node_modules) that
 * the user had before the checkpoint was created.
 *
 * @param root - Repository root path
 * @param preexistingFiles - Files that existed when the checkpoint was created
 * @param skippedLargeFiles - Large files that were skipped during snapshot (preserved)
 * @param skippedLargeDirs - Large directories that were skipped during snapshot (preserved)
 */
async function safeCleanUntrackedFiles(
  root: string,
  preexistingFiles: string[],
  skippedLargeFiles: string[] = [],
  skippedLargeDirs: string[] = []
): Promise<void> {
  // Get current untracked files
  const currentUntracked = await getUntrackedFiles(root);

  if (currentUntracked.length === 0) return;

  // Create sets for fast lookup
  const preexistingSet = new Set(preexistingFiles);
  const skippedLargeFilesSet = new Set(skippedLargeFiles);
  const skippedLargeDirsSet = new Set(skippedLargeDirs);

  // Find files that are NEW (not in the pre-existing set) and should be removed
  // Also filter out:
  // - files in ignored directories - we never want to delete those
  // - large files that were skipped during snapshot
  // - files in large directories that were skipped during snapshot
  const filesToRemove = currentUntracked.filter((f) => {
    if (preexistingSet.has(f)) return false;
    if (shouldIgnoreForSnapshot(f)) return false;
    if (skippedLargeFilesSet.has(f)) return false;
    if (isPathWithinAnyDir(f, skippedLargeDirsSet)) return false;
    return true;
  });

  if (filesToRemove.length === 0) return;

  // Remove files in batches
  const BATCH_SIZE = 100;
  for (let i = 0; i < filesToRemove.length; i += BATCH_SIZE) {
    const batch = filesToRemove.slice(i, i + BATCH_SIZE);
    // Use git clean with specific argv paths instead of interpolated command text.
    await gitArgs(["clean", "-f", "--", ...batch], root).catch(() => {
      // A failed cleanup must not make restoring the checkpoint fail.
    });
  }

  // Do not run a second repository-wide clean pass here. Its human-readable output
  // is ambiguous for filenames containing newlines/spaces, and empty directories
  // are harmless (Git does not track them).
}

export async function loadCheckpointFromRef(
  root: string,
  refName: string,
  lowPriority = false
): Promise<CheckpointData | null> {
  try {
    if (!isSafeId(refName)) return null;
    const gitFn = lowPriority ? gitLowPriorityArgs : gitArgs;
    const commitSha = await gitFn(["rev-parse", "--verify", `${REF_BASE}/${refName}`], root);
    if (!/^[0-9a-f]{40}$/i.test(commitSha)) return null;
    const commitMsg = await gitFn(["cat-file", "commit", commitSha], root);

    const get = (key: string) =>
      commitMsg.match(new RegExp(`^${key} (.+)$`, "m"))?.[1]?.trim();

    const sessionId = get("sessionId");
    const turn = get("turn");
    const head = get("head");
    const index = get("index-tree");
    const worktree = get("worktree-tree");
    const created = get("created");
    const untrackedJson = get("untracked");
    const largeFilesJson = get("largeFiles");
    const largeDirsJson = get("largeDirs");

    if (!sessionId || !turn || !head || !index || !worktree) return null;
    if (![head, index, worktree].every((sha) => /^[0-9a-f]{40}$/i.test(sha))) return null;

    const parsePathList = (raw: string | undefined): string[] | undefined => {
      if (!raw) return undefined;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return undefined;
        const safe = parsed.filter((value): value is string => {
          if (typeof value !== "string" || !value || value.includes("\0")) return false;
          const normalized = normalizeGitPath(value);
          return normalized !== ".." && !normalized.startsWith("../") && !isAbsolute(normalized);
        });
        return safe.length > 0 ? safe : undefined;
      } catch {
        // Ignore parse errors for backwards compatibility
        return undefined;
      }
    };

    const preexistingUntrackedFiles = parsePathList(untrackedJson);
    const skippedLargeFiles = parsePathList(largeFilesJson);
    const skippedLargeDirs = parsePathList(largeDirsJson);

    return {
      id: refName,
      turnIndex: parseInt(turn, 10),
      sessionId,
      headSha: head,
      indexTreeSha: index,
      worktreeTreeSha: worktree,
      timestamp: created ? new Date(created).getTime() : 0,
      preexistingUntrackedFiles,
      skippedLargeFiles,
      skippedLargeDirs,
    };
  } catch {
    return null;
  }
}

export async function listCheckpointRefs(
  root: string,
  lowPriority = false
): Promise<string[]> {
  try {
    const prefix = `${REF_BASE}/`;
    const gitFn = lowPriority ? gitLowPriorityArgs : gitArgs;
    const stdout = await gitFn(
      ["for-each-ref", "--format=%(refname)", prefix],
      root
    );
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((ref) => ref.replace(prefix, ""));
  } catch {
    return [];
  }
}

export async function loadAllCheckpoints(
  root: string,
  sessionFilter?: string,
  lowPriority = false
): Promise<CheckpointData[]> {
  const refs = await listCheckpointRefs(root, lowPriority);

  if (lowPriority) {
    const results: CheckpointData[] = [];
    const BATCH_SIZE = 3;
    for (let i = 0; i < refs.length; i += BATCH_SIZE) {
      const batch = refs.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((ref) => loadCheckpointFromRef(root, ref, true))
      );
      results.push(
        ...batchResults.filter(
          (cp): cp is CheckpointData =>
            cp !== null && (!sessionFilter || cp.sessionId === sessionFilter)
        )
      );
      await new Promise((resolve) => setImmediate(resolve));
    }
    return results;
  }

  const results = await Promise.all(
    refs.map((ref) => loadCheckpointFromRef(root, ref))
  );
  return results.filter(
    (cp): cp is CheckpointData =>
      cp !== null && (!sessionFilter || cp.sessionId === sessionFilter)
  );
}

// ============================================================================
// Utility functions
// ============================================================================

/** Validate ID contains only safe characters (alphanumeric, dash, underscore) */
export const isSafeId = (id: string) => /^[\w-]+$/.test(id);

/** Find the closest checkpoint to a target timestamp */
export function findClosestCheckpoint(
  checkpoints: CheckpointData[],
  targetTs: number
): CheckpointData {
  return checkpoints.reduce((best, cp) => {
    const bestDiff = Math.abs(best.timestamp - targetTs);
    const cpDiff = Math.abs(cp.timestamp - targetTs);
    // Prefer checkpoint that's before or equal to target
    if (cp.timestamp <= targetTs && best.timestamp > targetTs) return cp;
    if (best.timestamp <= targetTs && cp.timestamp > targetTs) return best;
    return cpDiff < bestDiff ? cp : best;
  });
}
