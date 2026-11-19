/**
 * Copy the canonical `shared/ui.ts` into every package that ships it.
 *
 * The copies are committed (not generated at install time) so each extension
 * can still be published to npm as a standalone package without importing
 * outside its own directory.
 *
 * Run with: pnpm sync:ui
 */

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const source = join(root, "shared", "ui.ts");
const targets = ["checkpoint", "lsp", "permission", "repeat"];

if (!existsSync(source)) {
  console.error(`missing canonical source: ${source}`);
  process.exit(1);
}

const content = readFileSync(source);

for (const pkg of targets) {
  const destination = join(root, pkg, "ui.ts");
  copyFileSync(source, destination);
  const copied = readFileSync(destination);
  if (!copied.equals(content)) {
    console.error(`failed to copy ${source} -> ${destination}`);
    process.exit(1);
  }
  console.log(`synced ${pkg}/ui.ts`);
}
