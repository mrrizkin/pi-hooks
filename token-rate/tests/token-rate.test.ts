/**
 * Tests for token-rate accounting.
 *
 * Run with: pnpm -C token-rate test
 */

import { TokenRateTracker, computeTps, formatTokenRate } from "../token-rate-core.js";

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const tests: Array<{ name: string; run: () => void }> = [];
function test(name: string, run: () => void) {
  tests.push({ name, run });
}

// ============================================================================
// computeTps / formatTokenRate
// ============================================================================

test("computeTps: returns null without usable data", () => {
  assertEqual(computeTps(0, 10), null, "no tokens");
  assertEqual(computeTps(10, 0), null, "no time");
  assertEqual(computeTps(-5, 10), null, "negative tokens");
  assertEqual(computeTps(Number.NaN, 10), null, "NaN tokens");
});

test("computeTps: divides tokens by seconds", () => {
  assertEqual(computeTps(100, 2), 50, "100 tokens over 2s");
  assertEqual(computeTps(3, 1.5), 2, "fractional seconds");
});

test("formatTokenRate: formats one decimal place and falls back to --", () => {
  assertEqual(formatTokenRate(null), "--", "no data");
  assertEqual(formatTokenRate(Number.POSITIVE_INFINITY), "--", "infinite value");
  assertEqual(formatTokenRate(12.345), "12.3 tok/s", "rounds to one decimal");
  assertEqual(formatTokenRate(0), "0.0 tok/s", "zero is formatted");
});

// ============================================================================
// TokenRateTracker
// ============================================================================

test("tracker: starts empty and resets totals", () => {
  const tracker = new TokenRateTracker();
  assertEqual(tracker.snapshot().tps, null, "initial snapshot has no TPS");
  tracker.startTurn(1_000);
  tracker.endTurn(50, 2_000);
  assertEqual(tracker.snapshot().totalOutputTokens, 50, "tokens recorded");
  tracker.reset();
  assertEqual(tracker.snapshot().tps, null, "reset clears TPS");
  assertEqual(tracker.snapshot().totalSeconds, 0, "reset clears seconds");
});

test("tracker: measures a full turn from start to end", () => {
  const tracker = new TokenRateTracker();
  tracker.startTurn(1_000);
  const snapshot = tracker.endTurn(100, 3_000);
  assertEqual(snapshot.totalSeconds, 2, "two seconds elapsed");
  assertEqual(snapshot.tps, 50, "100 tokens / 2s");
});

test("tracker: accumulates turns weighted by time", () => {
  const tracker = new TokenRateTracker();
  tracker.startTurn(0);
  tracker.endTurn(100, 1_000); // 100 tok/s
  tracker.startTurn(10_000);
  tracker.endTurn(10, 11_000); // 10 tok/s
  const snapshot = tracker.snapshot();
  assertEqual(snapshot.totalOutputTokens, 110, "tokens accumulated");
  assertEqual(snapshot.totalSeconds, 2, "seconds accumulated");
  assertEqual(snapshot.tps, 55, "time-weighted average");
});

test("tracker: stream end (first tool call) excludes tool time", () => {
  const tracker = new TokenRateTracker();
  tracker.startTurn(0);
  tracker.markStreamEnd(1_000); // streaming finished after 1s
  const snapshot = tracker.endTurn(40, 9_000); // turn ended 8s later
  assertEqual(snapshot.totalSeconds, 1, "tool time excluded");
  assertEqual(snapshot.tps, 40, "40 tokens in 1s of streaming");
});

test("tracker: stream end is recorded once per turn", () => {
  const tracker = new TokenRateTracker();
  tracker.startTurn(0);
  tracker.markStreamEnd(1_000);
  tracker.markStreamEnd(5_000);
  const snapshot = tracker.endTurn(10, 9_000);
  assertEqual(snapshot.totalSeconds, 1, "first tool call wins");
});

test("tracker: stream end without an active turn is ignored", () => {
  const tracker = new TokenRateTracker();
  tracker.markStreamEnd(1_000);
  const snapshot = tracker.endTurn(10, 2_000);
  assertEqual(snapshot.totalSeconds, 0.001, "fallback to the minimum duration");
  assertEqual(snapshot.tps, 10_000, "10 tokens in 1ms");
});

test("tracker: turns without output do not affect the average", () => {
  const tracker = new TokenRateTracker();
  tracker.startTurn(0);
  tracker.endTurn(100, 1_000);
  tracker.startTurn(2_000);
  const snapshot = tracker.endTurn(0, 5_000);
  assertEqual(snapshot.totalOutputTokens, 100, "zero-output turn ignored");
  assertEqual(snapshot.totalSeconds, 1, "zero-output time ignored");
  assertEqual(snapshot.tps, 100, "average unchanged");
});

test("tracker: invalid token counts are ignored", () => {
  const tracker = new TokenRateTracker();
  tracker.startTurn(0);
  const snapshot = tracker.endTurn(Number.NaN, 1_000);
  assertEqual(snapshot.totalOutputTokens, 0, "NaN tokens ignored");
  assertEqual(snapshot.tps, null, "no TPS from invalid input");
});

test("tracker: end timestamp before start is clamped to the minimum duration", () => {
  const tracker = new TokenRateTracker();
  tracker.startTurn(5_000);
  const snapshot = tracker.endTurn(1, 1_000);
  assertEqual(snapshot.totalSeconds, 0.001, "negative duration clamped");
  assertEqual(snapshot.tps, 1_000, "1 token / 1ms");
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
