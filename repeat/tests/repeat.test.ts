/**
 * Tests for the repeat extension's pure helpers.
 *
 * Run with: pnpm -C repeat test
 */

import {
  applyEditOnce,
  buildEditorInvocation,
  collectRepeatCalls,
  extractText,
  getExternalEditor,
  getRepeatLabel,
  getSearchInputCharacter,
  resolvePath,
  splitCommand,
  truncatePreview,
  type RepeatToolCall,
} from "../repeat-core.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}: expected ${e}, got ${a}`);
}

const tests: Array<{ name: string; run: () => void }> = [];
function test(name: string, run: () => void) {
  tests.push({ name, run });
}

const messageEntry = (message: any, timestamp = "2025-01-01T00:00:00.000Z") => ({
  type: "message",
  timestamp,
  message,
});

// ============================================================================
// collectRepeatCalls
// ============================================================================

test("collectRepeatCalls: keeps bash/edit/write in order and ignores other tools", () => {
  const calls = collectRepeatCalls([
    messageEntry({
      role: "assistant",
      content: [
        { type: "toolCall", name: "bash", id: "b1", arguments: { command: "ls" } },
        { type: "toolCall", name: "read", id: "r1", arguments: { path: "a.ts" } },
        { type: "toolCall", name: "write", id: "w1", arguments: { path: "a.ts", content: "x" } },
      ],
    }),
  ]);

  assertEqual(calls.map((call) => call.toolName), ["bash", "write"], "tool names");
  assertEqual(calls.map((call) => call.toolCallId), ["b1", "w1"], "tool call ids");
});

test("collectRepeatCalls: attaches matching tool results and skips non-message entries", () => {
  const calls = collectRepeatCalls([
    { type: "other" },
    messageEntry({
      role: "toolResult",
      toolCallId: "e1",
      details: { firstChangedLine: 12 },
      isError: true,
    }),
    messageEntry({
      role: "assistant",
      content: [{ type: "toolCall", name: "edit", id: "e1", arguments: { path: "a.ts" } }],
    }),
    messageEntry({
      role: "assistant",
      content: [{ type: "toolCall", name: "edit", id: "e2", arguments: { path: "b.ts" } }],
    }),
  ]);

  assertEqual(calls.length, 2, "two editable calls");
  assertEqual(calls[0].resultDetails, { firstChangedLine: 12 }, "result details attached");
  assert(calls[0].resultIsError === true, "error flag attached");
  assert(calls[1].resultDetails === undefined, "missing result stays undefined");
});

test("collectRepeatCalls: ignores assistant messages without content arrays", () => {
  const calls = collectRepeatCalls([messageEntry({ role: "assistant", content: "plain text" })]);
  assertEqual(calls, [], "no calls");
});

// ============================================================================
// applyEditOnce
// ============================================================================

test("applyEditOnce: replaces a unique occurrence", () => {
  const result = applyEditOnce("const a = 1;\n", "1", "2");
  assert("content" in result, "applies");
  if ("content" in result) assertEqual(result.content, "const a = 2;\n", "replaced");
});

test("applyEditOnce: rejects missing, duplicate, and empty old text", () => {
  assert("error" in applyEditOnce("abc", "z", "y"), "missing text is an error");
  assert("error" in applyEditOnce("aa", "a", "b"), "duplicate text is an error");
  assert("error" in applyEditOnce("abc", "", "b"), "empty text is an error");
});

// ============================================================================
// splitCommand / buildEditorInvocation
// ============================================================================

test("splitCommand: honours quotes and collapses whitespace", () => {
  assertEqual(splitCommand('code --wait'), ["code", "--wait"], "simple command");
  assertEqual(splitCommand('  "/opt/My Editor/bin/ed" --arg "a b"  '), ["/opt/My Editor/bin/ed", "--arg", "a b"], "quoted parts");
  assertEqual(splitCommand("   "), [], "blank command");
});

test("buildEditorInvocation: terminal editors get +line before the file", () => {
  assertEqual(buildEditorInvocation("nvim", "/tmp/a.ts", 7), {
    command: "nvim",
    args: ["+7", "/tmp/a.ts"],
  }, "vim-style invocation");
});

test("buildEditorInvocation: gui editors get file:line, open gets --args", () => {
  assertEqual(buildEditorInvocation("code --wait", "/tmp/a.ts", 7), {
    command: "code",
    args: ["--wait", "/tmp/a.ts:7"],
  }, "colon target for GUI editor");
  assertEqual(buildEditorInvocation("open", "/tmp/a.ts", 3), {
    command: "open",
    args: ["--args", "/tmp/a.ts:3"],
  }, "open uses --args");
  assertEqual(buildEditorInvocation("code", "/tmp/a.ts"), {
    command: "code",
    args: ["/tmp/a.ts"],
  }, "no line means plain file argument");
});

// ============================================================================
// environment and path helpers
// ============================================================================

test("getExternalEditor: prefers VISUAL, falls back to EDITOR, trims and ignores blanks", () => {
  assertEqual(getExternalEditor({ VISUAL: " vim ", EDITOR: "nano" } as NodeJS.ProcessEnv), "vim", "VISUAL wins");
  assertEqual(getExternalEditor({ EDITOR: " nano " } as NodeJS.ProcessEnv), "nano", "falls back to EDITOR");
  assertEqual(getExternalEditor({ VISUAL: "  ", EDITOR: "" } as NodeJS.ProcessEnv), null, "blank values are ignored");
});

test("resolvePath: keeps absolute paths and joins relative ones", () => {
  assertEqual(resolvePath("/proj", "/etc/hosts"), "/etc/hosts", "absolute path");
  assertEqual(resolvePath("/proj", "src/a.ts"), "/proj/src/a.ts", "relative path");
});

// ============================================================================
// presentation helpers
// ============================================================================

test("truncatePreview: collapses whitespace and truncates with ellipsis", () => {
  assertEqual(truncatePreview("  a \n b  ", 20), "a b", "whitespace collapsed");
  assertEqual(truncatePreview("abcdef", 4), "a...", "truncated with three dots");
  assertEqual(truncatePreview("abc", 3), "abc", "exact fit is unchanged");
});

test("extractText: handles strings, content parts, and missing content", () => {
  assertEqual(extractText("hello"), "hello", "raw string");
  assertEqual(extractText([{ text: "a" }, { text: "b" }]), "a\nb", "content parts joined");
  assertEqual(extractText(undefined), "", "missing content");
});

test("getSearchInputCharacter: accepts printable characters and rejects control input", () => {
  assertEqual(getSearchInputCharacter("a"), "a", "plain character");
  assertEqual(getSearchInputCharacter("\x1b"), undefined, "escape rejected");
  assertEqual(getSearchInputCharacter("\x7f"), undefined, "delete rejected");
  assertEqual(getSearchInputCharacter("ab"), undefined, "multi-character input rejected");
});

test("getRepeatLabel: summarises bash, edit, and write calls", () => {
  const bash = getRepeatLabel({
    toolName: "bash",
    toolCallId: "1",
    timestamp: "",
    args: { command: "npm test", timeout: 30 },
  });
  assertEqual(bash, { label: "bash: npm test", description: "timeout: 30s" }, "bash label");

  const edit = getRepeatLabel({
    toolName: "edit",
    toolCallId: "2",
    timestamp: "",
    args: { path: "src/a.ts", oldText: "const a = 1" },
    resultDetails: { firstChangedLine: 9 },
  });
  assertEqual(edit.label, "edit: src/a.ts", "edit label");
  assert(edit.description?.startsWith("line 9 • const a = 1") === true, "edit line and preview");

  const write = getRepeatLabel({
    toolName: "write",
    toolCallId: "3",
    timestamp: "",
    args: { path: "src/b.ts", content: "hello" },
  });
  assertEqual(write, { label: "write: src/b.ts", description: "5 bytes" }, "write label");
});

test("getRepeatLabel: handles empty tool calls", () => {
  const bash = getRepeatLabel({ toolName: "bash", toolCallId: "1", timestamp: "", args: {} });
  assertEqual(bash.label, "bash: (empty)", "empty bash command");

  const edit: RepeatToolCall = { toolName: "edit", toolCallId: "2", timestamp: "", args: {} };
  assertEqual(getRepeatLabel(edit).label, "edit: (unknown)", "missing edit path");
});

let failed = 0;
for (const { name, run } of tests) {
  try {
    run();
    console.log(`  ${name}... ✓`);
  } catch (error) {
    failed++;
    console.log(`  ${name}... ✗ ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(`${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
