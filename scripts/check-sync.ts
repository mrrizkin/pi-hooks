/**
 * Repository consistency checks.
 *
 * This repo ships as one git package (`pi install git:...`) while each
 * extension is also published as a standalone npm package. That split makes
 * a few invariants easy to break silently:
 *
 * 1. Runtime dependencies must also be declared at the root, otherwise a git
 *    install cannot resolve them.
 * 2. The `ui.ts` helper is intentionally duplicated per package (so standalone
 *    npm installs keep working), so the copies must stay byte-identical.
 * 3. Every extension must have a real test script, and the root `test` script
 *    must actually run it.
 * 4. Root `pi.extensions` entries must exist.
 *
 * Run with: pnpm check:sync
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const failures: string[] = [];
const notes: string[] = [];

function fail(message: string): void {
  failures.push(message);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

interface PackageJson {
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  pi?: { extensions?: string[] };
}

const rootPkg = readJson<PackageJson>(join(root, "package.json"));
const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
const packages = [...workspace.matchAll(/^\s*-\s*([a-z0-9_-]+)\s*$/gim)].map((match) => match[1]);

if (packages.length === 0) fail("pnpm-workspace.yaml does not list any packages");

// ---------------------------------------------------------------------------
// 1. Root dependencies mirror runtime dependencies of every package
// ---------------------------------------------------------------------------

for (const name of packages) {
  const pkgPath = join(root, name, "package.json");
  if (!existsSync(pkgPath)) {
    fail(`workspace package "${name}" has no package.json`);
    continue;
  }
  const pkg = readJson<PackageJson>(pkgPath);

  if (pkg.version !== rootPkg.version) {
    fail(`${name}/package.json version ${pkg.version} does not match root ${rootPkg.version}`);
  }

  for (const [dependency, range] of Object.entries(pkg.dependencies ?? {})) {
    const rootRange = rootPkg.dependencies?.[dependency];
    if (!rootRange) {
      fail(`${name} depends on ${dependency}@${range}, but root package.json does not declare it (git installs would fail)`);
    } else if (rootRange !== range) {
      fail(
        `${dependency} range mismatch: ${name} has ${range}, root has ${rootRange}. ` +
          "Keep them identical so installed and standalone builds use the same version.",
      );
    }
  }

  // 3. Every package has a real test script.
  const testScript = pkg.scripts?.test ?? "";
  if (!testScript) {
    fail(`${name}/package.json has no test script`);
  } else if (/^\s*echo\b/.test(testScript)) {
    fail(`${name}/package.json test script is a placeholder: "${testScript}"`);
  }

  // 3b. Root test script must run it.
  if (testScript && !new RegExp(`-C\\s+${name}\\s+(run\\s+)?test`).test(rootPkg.scripts?.test ?? "")) {
    fail(`root package.json "test" script does not run ${name}`);
  }
}

// ---------------------------------------------------------------------------
// 2. Shared ui.ts copies are identical
// ---------------------------------------------------------------------------

// ralph-loop/ui.ts is its own viewer implementation, not the shared helper.
const SHARED_UI_PACKAGES = ["checkpoint", "lsp", "permission", "repeat"];
const uiCopies = SHARED_UI_PACKAGES
  .map((name) => join(root, name, "ui.ts"))
  .filter((path) => existsSync(path));

if (uiCopies.length !== SHARED_UI_PACKAGES.length) {
  fail(`expected ${SHARED_UI_PACKAGES.length} shared ui.ts copies, found ${uiCopies.length}`);
}

if (uiCopies.length > 1) {
  const hashes = new Map<string, string[]>();
  for (const path of uiCopies) {
    const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
    const list = hashes.get(hash) ?? [];
    list.push(path.slice(root.length + 1));
    hashes.set(hash, list);
  }
  if (hashes.size > 1) {
    const summary = [...hashes.values()].map((files) => files.join(", ")).join(" | ");
    fail(`shared ui.ts copies have drifted apart: ${summary}`);
  } else {
    notes.push(`${uiCopies.length} ui.ts copies are identical`);
  }
}

// ---------------------------------------------------------------------------
// 4. Root pi.extensions entries exist
// ---------------------------------------------------------------------------

for (const extension of rootPkg.pi?.extensions ?? []) {
  const path = join(root, extension);
  if (!existsSync(path)) fail(`pi.extensions entry does not exist: ${extension}`);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

for (const note of notes) console.log(`ok: ${note}`);

if (failures.length > 0) {
  console.error("\nRepository consistency check failed:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`ok: ${packages.length} workspace packages are consistent`);
