/**
 * Shared limits and completion markers for the ralph loop.
 */

export const DEFAULT_LOOP_MAX_ITERATIONS = 10;
export const MAX_LOOP_ITERATIONS = 100;
export const DEFAULT_CONDITION_TIMEOUT_MS = 30_000;
export const MAX_CONDITION_TIMEOUT_MS = 300_000;
export const DEFAULT_LOOP_SLEEP_MS = 1000;
export const RALPH_LOOP_DEPTH_ENV = "PI_RALPH_LOOP_DEPTH";
// Completion markers are opt-in: a subagent can claim completion before the task is actually done.
// maxIterations remains the reliable default termination bound.
export const DEFAULT_STOP_ON_COMPLETION = false;
export const DEFAULT_COMPLETION_CONFIRMATIONS = 3;
export const MAX_COMPLETION_CONFIRMATIONS = 10;
export const COMPLETION_MARKER = "RALPH_DONE";
export const HANDOFF_START_MARKER = "RALPH_HANDOFF";
export const HANDOFF_END_MARKER = "RALPH_HANDOFF_END";
