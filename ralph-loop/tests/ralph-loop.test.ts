import registerRalphLoop, { parseRpcLine, resolveRpcExitCode } from "../ralph-loop.js";
import {
  applyLoopViewerNavigation,
  buildLoopViewerLineSource,
  buildLoopViewerLines,
  discoverRalphLoopRuns,
  RalphLoopViewer,
} from "../ui.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const tests: Array<[string, () => void | Promise<void>]> = [
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
  ["run discovery deduplicates persisted and active snapshots", () => {
    const details = { runId: "run-a", status: "idle", stopReason: "max-iterations", iterations: [] };
    const runs = discoverRalphLoopRuns([
      { type: "message", message: { role: "toolResult", toolName: "ralph_loop", toolCallId: "one", details } },
      { type: "message", message: { role: "toolResult", toolName: "ralph_loop", toolCallId: "two", details: { ...details } } },
    ], { ...details, status: "running" }, "run-a");
    assert(runs.length === 1, "same run id should appear once");
    assert(runs[0].active && runs[0].details.status === "running", "active snapshot should win");
  }],
  ["viewer hides thinking and remains viewport bounded", () => {
    const details = {
      runId: "run-view",
      status: "idle",
      stopReason: "done",
      iterations: [{ index: 1, details: { mode: "single", results: [{
        agent: "worker", agentSource: "builtin", exitCode: 0, task: "task",
        messages: [{ role: "assistant", content: [
          { type: "thinking", thinking: "secret reasoning" },
          { type: "text", text: "visible answer" },
        ] }],
      }] }, output: "visible answer" }],
    };
    const lines = buildLoopViewerLines(details);
    assert(!lines.some((line) => line.includes("secret reasoning")), "thinking should be hidden by default");
    assert(lines.some((line) => line.includes("Thinking hidden")), "hidden thinking should be indicated");
    const tui = { terminal: { rows: 20 }, requestRender: () => {} };
    const viewer = new RalphLoopViewer({ runId: "run-view", details, active: false }, () => details, tui, {}, () => {});
    const narrowRender = viewer.render(20);
    assert(narrowRender.length <= 20, "viewer output should fit its bounded viewport");
    const visibleWidth = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").length;
    assert(narrowRender.every((line) => visibleWidth(line) <= 18), "viewer lines should remain within narrow overlay width");
    viewer.handleInput("\x14");
    assert(viewer.render(80).some((line) => line.includes("secret reasoning")), "Ctrl+T should reveal thinking");
    tui.terminal.rows = 8;
    assert(viewer.render(30).length <= 8, "viewer should recalculate its bounded viewport after resize");

    const largeDetails = {
      ...details,
      iterations: [{ ...details.iterations[0], details: { ...details.iterations[0].details, results: [{
        ...details.iterations[0].details.results[0],
        messages: [{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "x".repeat(100_000) }] }],
      }] } }],
    };
    const source = buildLoopViewerLineSource(largeDetails);
    const firstLines = source.getLines(0, 6);
    const allLines = buildLoopViewerLines(largeDetails);
    assert(firstLines.length <= 6, "line source should materialize only the requested viewport");
    assert(allLines.some((line) => line.includes("output shortened in viewer")), "large output should be bounded");
  }],
  ["viewer navigation clamps at both ends", () => {
    assert(applyLoopViewerNavigation(0, 100, 10, "up") === 0, "up should clamp at zero");
    assert(applyLoopViewerNavigation(0, 100, 10, "pageDown") === 10, "page down should move one page");
    assert(applyLoopViewerNavigation(100, 100, 10, "down") === 90, "down should clamp at the last page");
    assert(applyLoopViewerNavigation(0, 100, 10, "end") === 90, "end should go to the last page");
  }],
  ["ralph-view selects before opening the viewer", async () => {
    const commands = new Map<string, any>();
    const customCalls: any[] = [];
    let notifyCalls = 0;
    let registeredTool: any;
    const keybindings = { matches: () => false };
    const tui = { terminal: { rows: 24 }, requestRender: () => {} };
    const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
    const pi = {
      registerCommand: (name: string, options: any) => commands.set(name, options),
      registerTool: (tool: any) => { registeredTool = tool; },
      getThinkingLevel: () => "off",
    };
    registerRalphLoop(pi as any);
    const compact = registeredTool.renderResult({
      content: [{ type: "text", text: "secret full history" }],
      details: { runId: "run-inline", status: "idle", stopReason: "done", iterations: [] },
    }, { expanded: true }, theme);
    const compactText = compact.render(200).join("\\n");
    assert(compactText.includes("run-inline"), "inline summary should identify the run");
    assert(!compactText.includes("secret full history"), "inline summary must not render full result content");
    const ctx = {
      hasUI: true,
      cwd: process.cwd(),
      sessionManager: { getEntries: () => [{
        type: "message",
        message: { role: "toolResult", toolName: "ralph_loop", toolCallId: "call-1", details: {
          runId: "run-select", status: "idle", stopReason: "done", iterations: [],
        } },
      }] },
      ui: {
        notify: () => { notifyCalls++; },
        custom: (factory: any, options?: any) => new Promise((resolve) => {
          const component = factory(tui, theme, keybindings, (value: any) => resolve(value));
          customCalls.push({ component, options });
          setTimeout(() => component.handleInput?.(customCalls.length === 1 ? "\n" : "\x1b"), 0);
        }),
      },
    };
    await commands.get("ralph-view").handler("", {
      ...ctx,
      sessionManager: { getEntries: () => [] },
    });
    assert(customCalls.length === 0 && notifyCalls === 1, "empty run discovery should notify without opening UI");
    await commands.get("ralph-view").handler("", ctx);
    assert(customCalls.length === 2, "selection and viewer should be separate UI steps");
    assert(customCalls[0].component.render(80)[0].includes("Select"), "first step should be the run selector");
    assert(customCalls[1].options?.overlay === true, "second step should open an overlay viewer");
  }],
];

let failed = 0;
for (const [name, run] of tests) {
  try {
    await run();
    console.log(`  ${name}... ✓`);
  } catch (error) {
    failed++;
    console.log(`  ${name}... ✗ ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(`${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
