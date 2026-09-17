import { parseRpcLine, resolveRpcExitCode } from "../ralph-loop.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const tests: Array<[string, () => void]> = [
  ["normal process exit requires agent_end", () => {
    assert(resolveRpcExitCode(0, true, false) === 0, "normal RPC completion should succeed");
    assert(resolveRpcExitCode(0, false, false) === 1, "early clean exit should be a failure");
  }],
  ["crash and abort exits are failures", () => {
    assert(resolveRpcExitCode(1, false, false) === 1, "crash should remain failed");
    assert(resolveRpcExitCode(null, false, true) === 1, "aborted process should remain failed");
  }],
  ["stdout logs do not become RPC events", () => {
    assert(parseRpcLine("child log: not JSON") === null, "non-JSON stdout must be ignored");
    assert(parseRpcLine("[child warning]") === null, "diagnostic logs must be ignored");
  }],
  ["large RPC lines remain intact", () => {
    const text = "x".repeat(1024 * 1024);
    const event = parseRpcLine(JSON.stringify({ type: "message_end", message: { content: [{ type: "text", text }] } }));
    assert(event?.message?.content?.[0]?.text.length === text.length, "large RPC output must not be truncated while parsing");
  }],
];

let failed = 0;
for (const [name, run] of tests) {
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
