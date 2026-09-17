/**
 * Unit tests for index.ts formatting functions
 */

import { mkdtemp, rm, writeFile, readFile } from "fs/promises";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { pathToFileURL } from "url";

// ============================================================================
// Test utilities
// ============================================================================

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];

function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message?: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(message || `Expected ${e}, got ${a}`);
}

// ============================================================================
// Import the module to test internal functions
// We need to test via the execute function since formatters are private
// Or we can extract and test the logic directly
// ============================================================================

import { uriToPath, findSymbolPosition, formatDiagnostic, filterDiagnosticsBySeverity, collectSymbols, applyWorkspaceEdit, LSPManager, LSP_SERVERS } from "../lsp-core.js";

// ============================================================================
// Protocol compatibility tests
// ============================================================================

test("protocol: Node entrypoint is importable on protocol 3.18+", async () => {
  const protocol = await import("vscode-languageserver-protocol/node");
  assert(typeof protocol.createMessageConnection === "function", "Node protocol entrypoint should export createMessageConnection");
  assert(typeof protocol.InitializeRequest?.method === "string", "Node protocol entrypoint should export InitializeRequest");
});

// ============================================================================
// uriToPath tests
// ============================================================================

test("uriToPath: converts file:// URI to path", () => {
  const result = uriToPath("file:///Users/test/file.ts");
  assertEqual(result, "/Users/test/file.ts");
});

test("uriToPath: handles encoded characters", () => {
  const result = uriToPath("file:///Users/test/my%20file.ts");
  assertEqual(result, "/Users/test/my file.ts");
});

test("uriToPath: passes through non-file URIs", () => {
  const result = uriToPath("/some/path.ts");
  assertEqual(result, "/some/path.ts");
});

test("uriToPath: handles invalid URIs gracefully", () => {
  const result = uriToPath("not-a-valid-uri");
  assertEqual(result, "not-a-valid-uri");
});

// ============================================================================
// findSymbolPosition tests
// ============================================================================

test("findSymbolPosition: finds exact match", () => {
  const symbols = [
    { name: "greet", range: { start: { line: 5, character: 10 }, end: { line: 5, character: 15 } }, selectionRange: { start: { line: 5, character: 10 }, end: { line: 5, character: 15 } }, kind: 12, children: [] },
    { name: "hello", range: { start: { line: 10, character: 0 }, end: { line: 10, character: 5 } }, selectionRange: { start: { line: 10, character: 0 }, end: { line: 10, character: 5 } }, kind: 12, children: [] },
  ];
  const pos = findSymbolPosition(symbols as any, "greet");
  assertEqual(pos, { line: 5, character: 10 });
});

test("findSymbolPosition: finds partial match", () => {
  const symbols = [
    { name: "getUserName", range: { start: { line: 3, character: 0 }, end: { line: 3, character: 11 } }, selectionRange: { start: { line: 3, character: 0 }, end: { line: 3, character: 11 } }, kind: 12, children: [] },
  ];
  const pos = findSymbolPosition(symbols as any, "user");
  assertEqual(pos, { line: 3, character: 0 });
});

test("findSymbolPosition: prefers exact over partial", () => {
  const symbols = [
    { name: "userName", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } }, selectionRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } }, kind: 12, children: [] },
    { name: "user", range: { start: { line: 5, character: 0 }, end: { line: 5, character: 4 } }, selectionRange: { start: { line: 5, character: 0 }, end: { line: 5, character: 4 } }, kind: 12, children: [] },
  ];
  const pos = findSymbolPosition(symbols as any, "user");
  assertEqual(pos, { line: 5, character: 0 });
});

test("findSymbolPosition: searches nested children", () => {
  const symbols = [
    { 
      name: "MyClass", 
      range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } }, 
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } }, 
      kind: 5,
      children: [
        { name: "myMethod", range: { start: { line: 2, character: 2 }, end: { line: 4, character: 2 } }, selectionRange: { start: { line: 2, character: 2 }, end: { line: 2, character: 10 } }, kind: 6, children: [] },
      ]
    },
  ];
  const pos = findSymbolPosition(symbols as any, "myMethod");
  assertEqual(pos, { line: 2, character: 2 });
});

test("findSymbolPosition: returns null for no match", () => {
  const symbols = [
    { name: "foo", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, kind: 12, children: [] },
  ];
  const pos = findSymbolPosition(symbols as any, "bar");
  assertEqual(pos, null);
});

test("findSymbolPosition: case insensitive", () => {
  const symbols = [
    { name: "MyFunction", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } }, kind: 12, children: [] },
  ];
  const pos = findSymbolPosition(symbols as any, "myfunction");
  assertEqual(pos, { line: 0, character: 0 });
});

// ============================================================================
// formatDiagnostic tests
// ============================================================================

test("formatDiagnostic: formats error", () => {
  const diag = {
    range: { start: { line: 5, character: 10 }, end: { line: 5, character: 15 } },
    message: "Type 'number' is not assignable to type 'string'",
    severity: 1,
  };
  const result = formatDiagnostic(diag as any);
  assertEqual(result, "ERROR [6:11] Type 'number' is not assignable to type 'string'");
});

test("formatDiagnostic: formats warning", () => {
  const diag = {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
    message: "Unused variable",
    severity: 2,
  };
  const result = formatDiagnostic(diag as any);
  assertEqual(result, "WARN [1:1] Unused variable");
});

test("formatDiagnostic: formats info", () => {
  const diag = {
    range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } },
    message: "Consider using const",
    severity: 3,
  };
  const result = formatDiagnostic(diag as any);
  assertEqual(result, "INFO [3:5] Consider using const");
});

test("formatDiagnostic: formats hint", () => {
  const diag = {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    message: "Prefer arrow function",
    severity: 4,
  };
  const result = formatDiagnostic(diag as any);
  assertEqual(result, "HINT [1:1] Prefer arrow function");
});

// ============================================================================
// filterDiagnosticsBySeverity tests
// ============================================================================

test("filterDiagnosticsBySeverity: all returns everything", () => {
  const diags = [
    { severity: 1, message: "error", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
    { severity: 2, message: "warning", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
    { severity: 3, message: "info", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
    { severity: 4, message: "hint", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
  ];
  const result = filterDiagnosticsBySeverity(diags as any, "all");
  assertEqual(result.length, 4);
});

test("filterDiagnosticsBySeverity: error returns only errors", () => {
  const diags = [
    { severity: 1, message: "error", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
    { severity: 2, message: "warning", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
  ];
  const result = filterDiagnosticsBySeverity(diags as any, "error");
  assertEqual(result.length, 1);
  assertEqual(result[0].message, "error");
});

test("filterDiagnosticsBySeverity: warning returns errors and warnings", () => {
  const diags = [
    { severity: 1, message: "error", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
    { severity: 2, message: "warning", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
    { severity: 3, message: "info", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
  ];
  const result = filterDiagnosticsBySeverity(diags as any, "warning");
  assertEqual(result.length, 2);
});

test("filterDiagnosticsBySeverity: info returns errors, warnings, and info", () => {
  const diags = [
    { severity: 1, message: "error", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
    { severity: 2, message: "warning", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
    { severity: 3, message: "info", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
    { severity: 4, message: "hint", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
  ];
  const result = filterDiagnosticsBySeverity(diags as any, "info");
  assertEqual(result.length, 3);
});

// ============================================================================
// collectSymbols tests
// ============================================================================

test("collectSymbols: uses selectionRange start for reported position", () => {
  // selectionRange.start (character 5) differs from range.start (character 0)
  const symbols = [
    { name: "foo", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } }, selectionRange: { start: { line: 0, character: 5 }, end: { line: 0, character: 8 } }, children: [] },
  ];
  const lines = collectSymbols(symbols as any);
  assertEqual(lines[0], "foo (1:6)");
});

test("collectSymbols: falls back to range when selectionRange is absent", () => {
  const symbols = [
    { name: "foo", kind: 12, range: { start: { line: 0, character: 3 }, end: { line: 0, character: 6 } }, children: [] },
  ];
  const lines = collectSymbols(symbols as any);
  assertEqual(lines[0], "foo (1:4)");
});

test("collectSymbols: converts 0-indexed positions to 1-indexed", () => {
  const symbols = [
    { name: "foo", kind: 12, range: { start: { line: 4, character: 0 }, end: { line: 4, character: 3 } }, selectionRange: { start: { line: 4, character: 0 }, end: { line: 4, character: 3 } }, children: [] },
  ];
  const lines = collectSymbols(symbols as any);
  assertEqual(lines[0], "foo (5:1)");
});

test("collectSymbols: formats multiple symbols in order", () => {
  const symbols = [
    { name: "bar", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, children: [] },
    { name: "baz", kind: 12, range: { start: { line: 5, character: 0 }, end: { line: 5, character: 3 } }, selectionRange: { start: { line: 5, character: 0 }, end: { line: 5, character: 3 } }, children: [] },
  ];
  const lines = collectSymbols(symbols as any);
  assertEqual(lines.length, 2);
  assertEqual(lines[0], "bar (1:1)");
  assertEqual(lines[1], "baz (6:1)");
});

test("collectSymbols: filters by query (case-insensitive)", () => {
  const symbols = [
    { name: "foo", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, children: [] },
    { name: "fooBar", kind: 12, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } }, selectionRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } }, children: [] },
    { name: "baz", kind: 12, range: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } }, selectionRange: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } }, children: [] },
  ];
  const lines = collectSymbols(symbols as any, 0, [], "FOO");
  assertEqual(lines.length, 2);
  assertEqual(lines[0], "foo (1:1)");
  assertEqual(lines[1], "fooBar (2:1)");
});

test("collectSymbols: recurses into children with indentation", () => {
  const symbols = [
    {
      name: "MyStruct", kind: 23,
      range: { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } },
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
      children: [
        { name: "field", kind: 8, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } }, selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } }, children: [] },
      ],
    },
  ];
  const lines = collectSymbols(symbols as any);
  assertEqual(lines.length, 2);
  assertEqual(lines[0], "MyStruct (1:1)");
  assertEqual(lines[1], "  field (2:3)");
});

test("collectSymbols: returns empty array for no symbols", () => {
  const lines = collectSymbols([] as any);
  assertEqual(lines.length, 0);
});

// ============================================================================
// WorkspaceEdit and lifecycle tests
// ============================================================================

test("LSPManager: failed starts report backoff and retry state", async () => {
  const dir = await mkdtemp(`${tmpdir()}/lsp-health-`);
  const config = {
    id: "test-failing-server",
    extensions: [".fake"],
    findRoot: () => dir,
    spawn: async () => undefined,
  } as any;
  LSP_SERVERS.push(config);
  try {
    const file = `${dir}/example.fake`;
    await writeFile(file, "test");
    const manager = new LSPManager(dir);
    try {
      assertEqual((await manager.getClientsForFile(file)).length, 0);
      const health = manager.getHealth().find((item) => item.server === config.id);
      assertEqual(health?.status, "backoff");
      assert((health?.attempts ?? 0) === 1, "failed start should record one attempt");
    } finally {
      await manager.shutdown();
    }
  } finally {
    LSP_SERVERS.splice(LSP_SERVERS.indexOf(config), 1);
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyWorkspaceEdit: applies multi-file edits", async () => {
  const dir = await mkdtemp(`${tmpdir()}/lsp-edit-`);
  try {
    const first = `${dir}/first.ts`;
    const second = `${dir}/second.ts`;
    await writeFile(first, "const old = 1;\n");
    await writeFile(second, "export const old = 2;\n");
    const count = applyWorkspaceEdit({
      changes: {
        [pathToFileURL(first).href]: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: "new" }],
        [pathToFileURL(second).href]: [{ range: { start: { line: 0, character: 13 }, end: { line: 0, character: 16 } }, newText: "new" }],
      },
    } as any, dir);
    assertEqual(count, 2);
    assertEqual(await readFile(first, "utf8"), "const new = 1;\n");
    assertEqual(await readFile(second, "utf8"), "export const new = 2;\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyWorkspaceEdit: rolls back when a file write fails", async () => {
  const dir = await mkdtemp(`${tmpdir()}/lsp-edit-fail-`);
  try {
    const first = `${dir}/first.ts`;
    const second = `${dir}/second.ts`;
    const originalFirst = "const old = 1;";
    const originalSecond = "const old = 2;";
    await writeFile(first, originalFirst);
    await writeFile(second, originalSecond);
    let writes = 0;
    let failed = false;
    try {
      applyWorkspaceEdit({
        changes: {
          [pathToFileURL(first).href]: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: "new" }],
          [pathToFileURL(second).href]: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: "new" }],
        },
      } as any, dir, { writeFile: (filePath, content) => {
        writes++;
        if (writes === 2) throw new Error("simulated write failure");
        writeFileSync(filePath, content, "utf8");
      } });
    } catch (error) {
      failed = String(error).includes("Failed to apply WorkspaceEdit");
    }
    assert(failed, "Expected an actionable WorkspaceEdit failure");
    assertEqual(await readFile(first, "utf8"), originalFirst);
    assertEqual(await readFile(second, "utf8"), originalSecond);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Run tests
// ============================================================================

async function runTests(): Promise<void> {
  console.log("Running index.ts unit tests...\n");

  let passed = 0;
  let failed = 0;

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ${name}... ✓`);
      passed++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`  ${name}... ✗`);
      console.log(`    Error: ${msg}\n`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
