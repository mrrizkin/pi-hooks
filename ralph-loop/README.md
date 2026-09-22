# Ralph Loop Extension

Looped subagent execution via the `ralph_loop` tool.

## Installation (ralph-loop only)

```bash
pi install npm:ralph-loop-pi
pi config
```

Enable only `ralph-loop` in `pi config`. Dependencies are installed automatically during `pi install`.

## Features

- Runs single or chain subagent tasks while a condition exits successfully and prints `true`
- Takes a prompt and optional exit condition
- Uses a finite default of 10 iterations (maximum 100) and a 30-second condition timeout
- Can supply max iterations, condition timeout, and minimum delay between each
- Can optionally stop early after consecutive `RALPH_DONE` completion confirmations
- Prevents Ralph subagents from creating nested Ralph loops
- Can carry a structured handoff between iterations while preserving the original task
- Optionally supply model and thinking
- Interactive steering + control commands when running in UI mode

## Interactive Controls

While `ralph_loop` is running in interactive mode:

- `/ralph-steer <message>` to append steering instructions (`--once` for one-off)
- `/ralph-follow <message>` to queue a follow-up message
- `/ralph-clear` to clear queued steering messages
- `/ralph-pause` / `/ralph-resume` to pause/resume the currently running iteration
- `/ralph-stop` to abort the loop
- `/ralph-status` to show loop status
- `/ralph-view` to select a run and open its scrollable history viewer

The viewer is an overlay and does not add the full history to the main chat. Select a run first, then use `Up`/`Down`, `PageUp`/`PageDown`, `Home`/`End`, and `Esc` to navigate and close it. It opens at the bottom and follows new output while the selected run is active; scrolling upward pauses auto-scroll and `End` resumes it. Output starts in `collapsed` mode; press `Ctrl+O` to cycle `collapsed`, `simple`, and `full`. These modes only affect tool output: `full` uses the normal native renderer, `collapsed` is its truncated state, and `simple` shows the tool call and filename/arguments without tool output. Assistant text is always shown. Thinking is hidden by default; press `Ctrl+T` inside the viewer to toggle its display without changing the model's thinking setting. Hidden thinking is replaced by `Thinking...`; visible thinking shows all thinking content.

The overlay defaults to 90% width and 90% height. Override these values with percentages using `RALPH_VIEW_WIDTH_PERCENT` and `RALPH_VIEW_HEIGHT_PERCENT` (for example, `RALPH_VIEW_WIDTH_PERCENT=80 RALPH_VIEW_HEIGHT_PERCENT=70 pi -ne -e .`). Values outside 0–100 are ignored and fall back to the defaults.

The main ralph-loop result stays compact; detailed assistant, thinking, and tool output is available in the viewer. Steering and follow-up messages are sent to the current iteration when possible, otherwise queued for the next iteration; queued/sent messages show in the UI.

Example prompt: "Use ralph loop to check the current time five times, sleeping 1s between iterations."

For exploratory or iterative work, completion confirmation and handoff can be configured explicitly:

```text
Run ralph_loop with task "Explore this project and summarize its architecture", maxIterations 10, stopOnCompletion true, completionConfirmations 3, handoffMode "summary".
```

The original task is retained on every iteration. Summary handoffs are advisory; complete prior output is retained in per-iteration artifacts when handoff is enabled.

When calling `ralph_loop`, use a standalone task with the desired outcome, acceptance criteria, and relevant workspace context. For implementation or review work, tell each iteration to inspect the current state, make concrete progress, run checks, and report remaining work. Use `maxIterations` as the hard cap; leave `stopOnCompletion` disabled for fixed iteration counts. Enable it only when early stopping is useful and completion can be objectively verified—`RALPH_DONE` is only the subagent's claim, not independent proof.

## Examples

- Use chain ralph loop to implement a quick fix, then write a brief self-review of the patch.
- Use chain ralph loop to summarize `README.md`, then `CONTRIBUTING.md`.

## Notes

- `conditionCommand` must exit successfully and print exactly `true` to continue; any other output stops the loop.
- `maxIterations` defaults to `10` when omitted and cannot exceed `100`.
- `conditionTimeoutMs` defaults to `30000` and cannot exceed `300000`; a timeout or failed condition stops the loop.
- `stopOnCompletion` defaults to `false`; this prevents an unverified `RALPH_DONE` claim from shortening the requested iteration count. Set it to `true` to enable early stopping after three consecutive final assistant responses ending in `RALPH_DONE`.
- `completionConfirmations` can change the required consecutive confirmation count (maximum `10`). A non-confirming iteration resets the streak. In `summary` handoff mode, `RALPH_DONE` is accepted only when the handoff says the work is complete/verified with no open questions or next action.
- `handoffMode` defaults to `summary`; use `none` to disable handoff or `artifact` to pass only the full-output artifact path. Full iteration artifacts are never character-truncated.
- The original task is sent on every iteration. Previous handoff context is appended and never replaces it.
- Includes a built-in `worker` fallback; user/project agents override it if present.
- Defaults to agent `worker` and the latest user prompt when `agent`/`task` are omitted.
