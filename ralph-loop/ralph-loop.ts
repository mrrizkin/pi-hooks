/// <reference path="./types.d.ts" />

/**
 * Ralph Loop Tool - Run subagent tasks in a loop.
 *
 * Executes subagent tasks (single or chain) repeatedly while
 * a condition command returns "true".
 */

import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	formatSize,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	discoverRalphLoopRuns,
	getRalphLoopOverlayConfig,
	RalphLoopViewer,
	selectRalphLoopRun,
} from "./ui.js";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";

/**
 * Look up the provider for a model using `pi --list-models`.
 * Returns the first matching provider, or null if not found.
 */
function lookupProviderForModel(modelName: string): string | null {
	try {
		const result = spawnSync("pi", ["--list-models", modelName], {
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		
		if (result.status !== 0 || !result.stdout) return null;
		
		const lines = result.stdout.split("\n");
		// Skip header line, find exact match for model
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i].trim();
			if (!line) continue;
			
			// Parse columns: provider, model, context, max-out, thinking, images
			const parts = line.split(/\s+/);
			if (parts.length >= 2) {
				const provider = parts[0];
				const model = parts[1];
				// Return first provider where model matches exactly
				if (model === modelName) {
					return provider;
				}
			}
		}
		
		// If no exact match, return first result's provider (fuzzy match)
		if (lines.length > 1) {
			const firstResult = lines[1].trim().split(/\s+/);
			if (firstResult.length >= 2) {
				return firstResult[0];
			}
		}
		
		return null;
	} catch {
		return null;
	}
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "builtin" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	sessionFile?: string; // Path to subagent's session file
}

export interface SubagentDetails {
	mode: "single" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

export interface LoopIterationResult {
	index: number;
	details: SubagentDetails;
	output: string;
	isError?: boolean;
}

export interface LoopPromptItem {
	agent: string;
	task: string;
	model?: string;
	thinking?: string;
}

export interface LoopPromptInfo {
	mode: "single" | "chain";
	items: LoopPromptItem[];
}

export type HandoffMode = "none" | "summary" | "artifact";
type LoopRunStatus = "idle" | "running" | "paused" | "stopping";

export interface RalphLoopDetails {
	runId: string;
	iterations: LoopIterationResult[];
	stopReason: string;
	conditionCommand: string;
	conditionSource: "provided" | "inferred" | "default";
	maxIterations: number | null;
	sleepMs: number;
	conditionTimeoutMs: number;
	lastCondition: { stdout: string; stderr: string; exitCode: number; killed?: boolean; timedOut?: boolean };
	prompt: LoopPromptInfo;
	steering: string[];
	followUps: string[];
	steeringSent: string[];
	followUpsSent: string[];
	status: LoopRunStatus;
	stopOnCompletion: boolean;
	completionConfirmations: number;
	completionStreak: number;
	handoffMode: HandoffMode;
	artifactPaths: string[];
}

export interface LoopControlState {
	status: LoopRunStatus;
	runId: string | null;
	iterations: number;
	steering: string[];
	steeringOnce: string[];
	followUps: string[];
	steeringSent: string[];
	followUpsSent: string[];
	paused: boolean;
	abortController: AbortController | null;
	lastDetails: RalphLoopDetails | null;
}

interface ActiveRun {
	process: any;
	sendFollowUp: (message: string) => Promise<void>;
	sendSteer: (message: string) => Promise<void>;
}

type ActiveRunRegistration = (run: ActiveRun) => () => void;

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function getFinalAssistantText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			return msg.content
				.filter((part: any) => part?.type === "text" && typeof part.text === "string")
				.map((part: any) => part.text)
				.join("\n");
		}
	}
	return "";
}

export function hasCompletionMarker(text: string): boolean {
	const lastLine = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.pop();
	return lastLine === COMPLETION_MARKER;
}

export function updateCompletionStreak(
	currentStreak: number,
	completed: boolean,
	requiredConfirmations: number,
): { streak: number; shouldStop: boolean } {
	const streak = completed ? Math.min(currentStreak + 1, requiredConfirmations) : 0;
	return { streak, shouldStop: streak >= requiredConfirmations };
}

export function extractRalphHandoff(text: string): string | null {
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((line) => line.trim() === HANDOFF_START_MARKER);
	if (start < 0) return null;
	const end = lines.slice(start + 1).findIndex((line) => line.trim() === HANDOFF_END_MARKER);
	if (end < 0) return null;
	return lines.slice(start, start + end + 2).join("\n").trim();
}

export interface IterationTaskOptions {
	stopOnCompletion: boolean;
	verificationPass: number;
	handoffMode: HandoffMode;
	handoff?: string | null;
	artifactPath?: string | null;
}

export function buildIterationTask(originalTask: string, options: IterationTaskOptions): string {
	const sections: string[] = [];
	if (options.handoffMode !== "none" && (options.handoff || options.artifactPath)) {
		const handoffLines = [
			"Previous iteration context is advisory; the original task remains authoritative:",
		];
		if (options.handoffMode === "summary" && options.handoff) handoffLines.push(options.handoff);
		if (options.artifactPath) {
			handoffLines.push(`Full previous iteration artifact: ${options.artifactPath}`);
			handoffLines.push("Read the artifact only when the structured handoff is insufficient.");
		}
		sections.push(handoffLines.join("\n"));
	}
	if (options.verificationPass > 0) {
		sections.push(
			`Verification pass ${options.verificationPass}: independently re-check the original task and provide evidence. Do not emit ${COMPLETION_MARKER} merely because a previous iteration claimed completion.`,
		);
	}
	if (options.handoffMode === "summary") {
		sections.push(
			`At the end of this iteration, include a concise structured handoff between ${HANDOFF_START_MARKER} and ${HANDOFF_END_MARKER} with status, completed work, important facts/evidence, open questions, and next action.`,
		);
	}
	if (options.stopOnCompletion) {
		sections.push(
			[
				`Use ${COMPLETION_MARKER} only as a completion control signal, never as a progress or status label.`,
				`Before emitting it, re-read the original task, satisfy every requirement, verify the result with appropriate checks or tests, and resolve all known issues and open questions.`,
				`If any requirement is incomplete, verification is missing, or you are uncertain, do not emit ${COMPLETION_MARKER}; continue working and explain what remains.`,
				`Only after those checks pass, end the final assistant response with exactly ${COMPLETION_MARKER} on its own line.`,
			].join(" "),
		);
	}
	if (sections.length === 0) return originalTask;
	return `${originalTask}\n\n[Ralph loop runtime context]\n${sections.join("\n\n")}`;
}

function applyIterationContextToParams(params: any, options: IterationTaskOptions): any {
	const next = cloneLoopParams(params);
	if (typeof next.task === "string") {
		next.task = buildIterationTask(next.task, options);
	}
	if (Array.isArray(next.chain)) {
		next.chain = next.chain.map((step: any, index: number) => ({
			...step,
			task: buildIterationTask(step.task, {
				...options,
				stopOnCompletion: options.stopOnCompletion && index === next.chain.length - 1,
			}),
		}));
	}
	return next;
}

function getCompletionText(details: SubagentDetails): string {
	const lastResult = details.results[details.results.length - 1];
	return lastResult ? getFinalAssistantText(lastResult.messages) : "";
}

function formatSteeringText(messages: string[]): string | null {
	const cleaned = messages.map((msg) => msg.trim()).filter(Boolean);
	if (cleaned.length === 0) return null;
	const lines = cleaned.map((msg, index) => `${index + 1}. ${msg}`);
	return `Steering updates:\n${lines.join("\n")}`;
}

function appendSteeringToTask(task: string, steering: string | null): string {
	if (!steering) return task;
	return `${task.trim()}\n\n${steering}`;
}

function cloneLoopParams(params: any): any {
	return {
		...params,
		chain: Array.isArray(params.chain) ? params.chain.map((step: any) => ({ ...step })) : undefined,
	};
}

function applySteeringToParams(params: any, steering: string | null): any {
	const nextParams = cloneLoopParams(params);
	if (!steering) return nextParams;
	if (typeof nextParams.task === "string") {
		nextParams.task = appendSteeringToTask(nextParams.task, steering);
	}
	if (Array.isArray(nextParams.chain)) {
		nextParams.chain = nextParams.chain.map((step: any) => ({
			...step,
			task: appendSteeringToTask(step.task, steering),
		}));
	}
	return nextParams;
}

function mergeAbortSignals(primary?: AbortSignal, secondary?: AbortSignal): AbortSignal | undefined {
	if (!primary) return secondary;
	if (!secondary) return primary;
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (primary.aborted || secondary.aborted) {
		controller.abort();
	} else {
		primary.addEventListener("abort", abort, { once: true });
		secondary.addEventListener("abort", abort, { once: true });
	}
	return controller.signal;
}

function isProcessActive(proc: any): boolean {
	return Boolean(proc && proc.exitCode === null);
}

export function resolveRpcExitCode(code: number | null, sawAgentEnd: boolean, aborted: boolean): number {
	const normalized = code ?? 1;
	return !sawAgentEnd && !aborted && normalized === 0 ? 1 : normalized;
}

export function parseRpcLine(line: string): Record<string, any> | null {
	if (!line.trim()) return null;
	try {
		const parsed = JSON.parse(line);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
	} catch {
		// Child-process logs are intentionally ignored; only valid RPC objects
		// can affect the loop result.
		return null;
	}
}

function terminateSubagent(proc: any, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
	if (!isProcessActive(proc)) return;
	try {
		if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, signal);
		else proc.kill(signal);
	} catch {
		try { proc.kill(signal); } catch { /* already exited */ }
	}
}

function pauseActiveRuns(control: LoopControlState, runs: Set<ActiveRun>): boolean {
	if (control.paused) return runs.size > 0;
	let paused = false;
	for (const run of runs) {
		try {
			if (isProcessActive(run.process)) {
				const didStop = run.process.kill("SIGSTOP");
				if (didStop) paused = true;
			}
		} catch {
			// ignore
		}
	}
	if (paused) {
		control.paused = true;
		if (control.status !== "stopping") {
			control.status = "paused";
		}
	}
	return paused;
}

function clearPausedState(control: LoopControlState): void {
	if (!control.paused) return;
	control.paused = false;
	if (control.status === "paused") {
		control.status = "running";
	}
}

function resumeActiveRuns(control: LoopControlState, runs: Set<ActiveRun>): boolean {
	if (!control.paused) return runs.size > 0;
	if (runs.size === 0) {
		clearPausedState(control);
		return true;
	}
	let resumed = false;
	for (const run of runs) {
		try {
			if (isProcessActive(run.process)) {
				const didResume = run.process.kill("SIGCONT");
				if (didResume) resumed = true;
			}
		} catch {
			// ignore
		}
	}
	if (resumed) {
		clearPausedState(control);
	}
	return resumed;
}

function writePromptToTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

type OnUpdateCallback = (partial: AgentToolResult) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	modelOverride?: string,
	thinkingLevel?: string,
	taskIndex?: number,
	registerActiveRun?: ActiveRunRegistration,
	initialFollowUps?: string[],
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: ${agentName}`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	// Use model override if provided, otherwise fall back to agent's model
	const effectiveModel = modelOverride || agent.model;

	// Create session file for this subagent invocation
	const subagentSessionDir = path.join(os.homedir(), ".pi", "agent", "sessions", "subagents");
	if (!fs.existsSync(subagentSessionDir)) {
		fs.mkdirSync(subagentSessionDir, { recursive: true });
	}
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	// Use UUID for guaranteed uniqueness
	const uuid = crypto.randomUUID().substring(0, 8);
	const indexSuffix = taskIndex !== undefined ? `_idx${taskIndex}` : "";
	const stepSuffix = step !== undefined ? `_step${step}` : "";
	const sessionFile = path.join(subagentSessionDir, `${timestamp}_${safeName}${stepSuffix}${indexSuffix}_${uuid}.jsonl`);

	const args: string[] = ["--mode", "rpc", "--session", sessionFile];

	// Parse provider:model format and pass both --provider and --model flags
	// This is needed because pi's --model flag alone doesn't override defaultProvider from settings.json
	if (effectiveModel) {
		if (effectiveModel.includes(":")) {
			const colonIndex = effectiveModel.indexOf(":");
			const provider = effectiveModel.slice(0, colonIndex);
			const model = effectiveModel.slice(colonIndex + 1);
			args.push("--provider", provider, "--model", model);
		} else {
			// Look up the provider for this model
			const provider = lookupProviderForModel(effectiveModel);
			if (provider) {
				args.push("--provider", provider, "--model", effectiveModel);
			} else {
				args.push("--model", effectiveModel);
			}
		}
	}
	if (thinkingLevel) args.push("--thinking", thinkingLevel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	// Add custom tools from agent configuration (e.g., question tool for planners)
	if (agent.customTools && agent.customTools.length > 0) {
		const optionalToolsDir = path.join(os.homedir(), ".pi", "agent", "tools-optional");
		for (const toolRef of agent.customTools) {
			// Support both tool names (looked up in tools-optional) and full paths
			let toolPath = toolRef;
			if (!path.isAbsolute(toolRef) && !toolRef.startsWith("~")) {
				toolPath = path.join(optionalToolsDir, toolRef, "index.ts");
			} else if (toolRef.startsWith("~")) {
				toolPath = path.join(os.homedir(), toolRef.slice(1));
			}
			if (fs.existsSync(toolPath)) {
				args.push("--extension", toolPath);
			}
		}
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: effectiveModel,
		step,
		sessionFile,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const env = agent.permissionLevel
				? { ...process.env, PI_PERMISSION_LEVEL: agent.permissionLevel }
				: process.env;
			const proc = spawn("pi", args, { cwd: cwd ?? defaultCwd, shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], env });
			let buffer = "";
			let resolved = false;
			let processClosed = false;
			let sawAgentEnd = false;
			let abortHandler: (() => void) | null = null;
			let unregisterActive: (() => void) | null = null;
			let requestId = 0;
			const pending = new Map<string, { resolve: (response: any) => void; reject: (error: Error) => void }>();
			let stdinClosed = false;

			const rejectPending = (error: Error) => {
				for (const pendingReq of pending.values()) {
					try {
						pendingReq.reject(error);
					} catch {
						// ignore
					}
				}
				pending.clear();
			};

			const markStdinClosed = (error: Error) => {
				if (stdinClosed) return;
				stdinClosed = true;
				rejectPending(error);
			};

			proc.stdin?.on("error", (error) => {
				markStdinClosed(error instanceof Error ? error : new Error("stdin error"));
			});
			proc.stdin?.on("close", () => {
				markStdinClosed(new Error("stdin closed"));
			});

			const resolveOnce = (code: number) => {
				if (resolved) return;
				resolved = true;
				if (unregisterActive) unregisterActive();
				if (abortHandler && signal) signal.removeEventListener("abort", abortHandler);
				resolve(code);
			};

			const sendCommand = (command: any) =>
				new Promise<any>((resolveCommand, rejectCommand) => {
					if (processClosed || stdinClosed || proc.exitCode !== null || proc.stdin?.destroyed) {
						rejectCommand(new Error("RPC process is not available"));
						return;
					}
					const id = `req_${++requestId}`;
					const payload = { ...command, id };
					const timeout = setTimeout(() => {
						if (pending.has(id)) {
							pending.delete(id);
							rejectCommand(new Error(`Timeout waiting for ${command.type}`));
						}
					}, 30000);

					pending.set(id, {
						resolve: (response) => {
							clearTimeout(timeout);
							resolveCommand(response);
						},
						reject: (error) => {
							clearTimeout(timeout);
							rejectCommand(error);
						},
					});

					try {
						proc.stdin?.write(`${JSON.stringify(payload)}\n`);
					} catch (error: any) {
						pending.delete(id);
						const err = error instanceof Error ? error : new Error(String(error));
						markStdinClosed(err);
						rejectCommand(err);
					}
				});

			const sendFollowUp = (message: string) => sendCommand({ type: "follow_up", message });
			const sendSteer = (message: string) => sendCommand({ type: "steer", message });
			unregisterActive = registerActiveRun
				? registerActiveRun({ process: proc, sendFollowUp, sendSteer })
				: null;

			const handleResponse = (event: any) => {
				const id = event?.id as string | undefined;
				if (!id) return false;
				const pendingReq = pending.get(id);
				if (!pendingReq) return false;
				pending.delete(id);
				if (event.success === false) {
					pendingReq.reject(new Error(event.error || "RPC command failed"));
				} else {
					pendingReq.resolve(event);
				}
				return true;
			};

			let finalizing = false;
			const finalizeRun = async () => {
				if (resolved || finalizing) return;
				finalizing = true;
				try {
					const response = await sendCommand({ type: "get_state" });
					const state = response?.data;
					if (state?.pendingMessageCount > 0 || state?.isStreaming) {
						finalizing = false;
						return;
					}
				} catch {
					// ignore
				}
				if (resolved) return;
				resolveOnce(0);
				terminateSubagent(proc, "SIGTERM");
				setTimeout(() => {
					if (isProcessActive(proc)) terminateSubagent(proc, "SIGKILL");
				}, 2000).unref?.();
			};

			const upsertToolResult = (
				toolCallId: string,
				toolName: string,
				result: any,
				isError: boolean,
				isPartial: boolean,
			) => {
				const existingIndex = currentResult.messages.findIndex(
					(msg: any) => msg.role === "toolResult" && msg.toolCallId === toolCallId,
				);
				const existing = existingIndex >= 0 ? (currentResult.messages[existingIndex] as any) : null;
				const toolMessage = {
					role: "toolResult",
					toolCallId,
					toolName: toolName || existing?.toolName || "",
					content: result?.content || [],
					details: result?.details,
					isError,
					isPartial,
					timestamp: Date.now(),
				};
				if (existingIndex >= 0) {
					currentResult.messages[existingIndex] = { ...existing, ...toolMessage } as Message;
				} else {
					currentResult.messages.push(toolMessage as Message);
				}
				emitUpdate();
			};

			const processEvent = (event: any) => {
				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
					return;
				}

				if (event.type === "tool_execution_start" && event.toolCallId) {
					upsertToolResult(event.toolCallId, event.toolName || "", { content: [], details: undefined }, false, true);
					return;
				}

				if (event.type === "tool_execution_update" && event.toolCallId) {
					const partial = event.partialResult ?? { content: [], details: undefined };
					upsertToolResult(event.toolCallId, event.toolName || "", partial, false, true);
					return;
				}

				if (event.type === "tool_execution_end" && event.toolCallId) {
					const result = event.result ?? { content: [], details: undefined };
					upsertToolResult(event.toolCallId, event.toolName || "", result, Boolean(event.isError), false);
					return;
				}

				if (event.type === "agent_end") {
					sawAgentEnd = true;
					if (Array.isArray(event.messages)) {
						currentResult.messages = event.messages as Message[];
					}
					emitUpdate();
					void finalizeRun();
				}
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				const event = parseRpcLine(line);
				if (!event) return;

				if (event.type === "response" && handleResponse(event)) {
					return;
				}

				processEvent(event);
			};

			proc.stdout.on("data", (data) => {
				if (processClosed) return;
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				const next = currentResult.stderr + data.toString();
				currentResult.stderr = next.length > 1_000_000 ? next.slice(-1_000_000) : next;
			});

			proc.on("close", (code) => {
				processClosed = true;
				if (buffer.trim()) processLine(buffer);
				markStdinClosed(new Error("process closed"));
				const exitCode = resolveRpcExitCode(code, sawAgentEnd, wasAborted);
				if (!sawAgentEnd && !resolved && exitCode !== 0 && !wasAborted) {
					currentResult.errorMessage = "Subagent exited before agent_end (RPC stream ended unexpectedly)";
				}
				resolveOnce(exitCode);
			});

			proc.on("error", (error) => {
				processClosed = true;
				markStdinClosed(error instanceof Error ? error : new Error("process error"));
				currentResult.errorMessage = error instanceof Error ? error.message : "Subagent process error";
				resolveOnce(1);
			});

			if (signal) {
				abortHandler = () => {
					wasAborted = true;
					sendCommand({ type: "abort" }).catch(() => undefined);
					terminateSubagent(proc, "SIGTERM");
					setTimeout(() => {
						if (isProcessActive(proc)) terminateSubagent(proc, "SIGKILL");
					}, 5000).unref?.();
				};
				if (signal.aborted) abortHandler();
				else signal.addEventListener("abort", abortHandler, { once: true });
			}

			sendCommand({ type: "prompt", message: `Task: ${task}` })
				.then(() => {
					const followUps = (initialFollowUps ?? []).filter((msg) => msg.trim().length > 0);
					if (followUps.length === 0) return;
					const queueFollowUps = async () => {
						for (const message of followUps) {
							try {
								await sendCommand({ type: "follow_up", message });
							} catch (error: any) {
								const errorMessage = error?.message ? `\n${error.message}` : `\n${String(error)}`;
								currentResult.stderr += errorMessage;
							}
						}
					};
					void queueFollowUps();
				})
				.catch((error) => {
					currentResult.stderr += error?.message ? `\n${error.message}` : String(error);
					resolveOnce(1);
					terminateSubagent(proc, "SIGTERM");
				});
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const ThinkingLevel = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, {
	description: "Thinking/reasoning level for the model",
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Standalone task for this chain step, with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: Type.Optional(Type.String({ description: "Override the agent's model (e.g., 'claude-opus-4-5', 'gpt-5.2-codex')" })),
	thinking: Type.Optional(ThinkingLevel),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

export const DEFAULT_LOOP_MAX_ITERATIONS = 10;
export const MAX_LOOP_ITERATIONS = 100;
export const DEFAULT_CONDITION_TIMEOUT_MS = 30_000;
export const MAX_CONDITION_TIMEOUT_MS = 300_000;
export const DEFAULT_LOOP_SLEEP_MS = 1000;
// Completion markers are opt-in: a subagent can claim completion before the task is actually done.
// maxIterations remains the reliable default termination bound.
export const DEFAULT_STOP_ON_COMPLETION = false;
export const DEFAULT_COMPLETION_CONFIRMATIONS = 3;
export const MAX_COMPLETION_CONFIRMATIONS = 10;
export const COMPLETION_MARKER = "RALPH_DONE";
export const HANDOFF_START_MARKER = "RALPH_HANDOFF";
export const HANDOFF_END_MARKER = "RALPH_HANDOFF_END";
export const DEFAULT_HANDOFF_MODE: HandoffMode = "summary";

const HandoffModeSchema = StringEnum(["none", "summary", "artifact"] as const, {
	description: 'How previous iteration context is handed off. Default: "summary".',
	default: "summary",
});

const LoopParams = Type.Object({
	conditionCommand: Type.Optional(
		Type.String({
			description:
				"Bash command used for looping; continue while stdout is 'true' (case-insensitive). If omitted, inferred from task or defaults to 'echo true'.",
		}),
	),
	maxIterations: Type.Optional(
		Type.Number({ description: `Max iterations (default ${DEFAULT_LOOP_MAX_ITERATIONS}, maximum ${MAX_LOOP_ITERATIONS}).` }),
	),
	sleepMs: Type.Optional(Type.Number({ description: `Sleep between iterations in ms (default ${DEFAULT_LOOP_SLEEP_MS}).` })),
	conditionTimeoutMs: Type.Optional(
		Type.Number({
			description: `Maximum time for each condition command in ms (default ${DEFAULT_CONDITION_TIMEOUT_MS}, maximum ${MAX_CONDITION_TIMEOUT_MS}).`,
		}),
	),
	stopOnCompletion: Type.Optional(
		Type.Boolean({
			description: `Stop after consecutive ${COMPLETION_MARKER} confirmations. Default: ${DEFAULT_STOP_ON_COMPLETION}.`,
			default: DEFAULT_STOP_ON_COMPLETION,
		}),
	),
	completionConfirmations: Type.Optional(
		Type.Number({ description: `Consecutive completion confirmations required (default ${DEFAULT_COMPLETION_CONFIRMATIONS}, maximum ${MAX_COMPLETION_CONFIRMATIONS}).` }),
	),
	handoffMode: Type.Optional(HandoffModeSchema),
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Standalone objective with acceptance criteria; it is sent again on every iteration (for single mode)" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	model: Type.Optional(Type.String({ description: "Override the agent's model for single mode (e.g., 'claude-opus-4-5', 'gpt-5.2-codex')" })),
	thinking: Type.Optional(ThinkingLevel),
});

interface LoopExecutionResult {
	output: string;
	details: SubagentDetails;
	isError?: boolean;
}

async function executeSubagentOnce(
	params: any,
	ctx: any,
	signal?: AbortSignal,
	onUpdate?: OnUpdateCallback,
	registerActiveRun?: ActiveRunRegistration,
	initialFollowUps?: string[],
): Promise<LoopExecutionResult> {
	const agentScope: AgentScope = params.agentScope ?? "user";
	const discovery = discoverAgents(ctx.cwd, agentScope);
	const agents = discovery.agents;
	const confirmProjectAgents = params.confirmProjectAgents ?? true;

	const makeDetails =
		(mode: "single" | "chain") =>
		(results: SingleResult[]): SubagentDetails => ({
			mode,
			agentScope,
			projectAgentsDir: discovery.projectAgentsDir,
			results,
		});

	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.agent && params.task);

	if (hasTasks) {
		return {
			output: "Parallel mode is not supported. Use chain instead.",
			details: makeDetails("single")([]),
			isError: true,
		};
	}

	const modeCount = Number(hasChain) + Number(hasSingle);

	if (modeCount !== 1) {
		const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
		return {
			output: `Invalid parameters. Provide exactly one mode (single or chain).\nAvailable agents: ${available}`,
			details: makeDetails("single")([]),
			isError: true,
		};
	}

	if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
		const requestedAgentNames = new Set<string>();
		if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
		if (params.agent) requestedAgentNames.add(params.agent);

		const projectAgentsRequested = Array.from(requestedAgentNames)
			.map((name) => agents.find((a) => a.name === name))
			.filter((a: AgentConfig | undefined): a is AgentConfig => a?.source === "project");

		if (projectAgentsRequested.length > 0) {
			const names = projectAgentsRequested.map((a) => a.name).join(", ");
			const dir = discovery.projectAgentsDir ?? "(unknown)";
			const ok = await ctx.ui.confirm(
				"Run project-local agents?",
				`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
			);
			if (!ok)
				return {
					output: "Canceled: project-local agents not approved.",
					details: makeDetails(hasChain ? "chain" : "single")([]),
					isError: true,
				};
		}
	}

	if (params.chain && params.chain.length > 0) {
		const results: SingleResult[] = [];
		let previousOutput = "";

		for (let i = 0; i < params.chain.length; i++) {
			const step = params.chain[i];
			const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

			const chainUpdate: OnUpdateCallback | undefined = onUpdate
				? (partial) => {
					const currentResult = partial.details?.results[0];
					if (currentResult) {
						const allResults = [...results, currentResult];
						onUpdate({
							content: partial.content,
							details: makeDetails("chain")(allResults),
						});
					}
				}
				: undefined;

			const result = await runSingleAgent(
				ctx.cwd,
				agents,
				step.agent,
				taskWithContext,
				step.cwd,
				i + 1,
				signal,
				chainUpdate,
				makeDetails("chain"),
				step.model,
				step.thinking ?? params.thinking,
				undefined,
				registerActiveRun,
				initialFollowUps,
			);
			results.push(result);

			const isError =
				result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
			if (isError) {
				const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
				return {
					output: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`,
					details: makeDetails("chain")(results),
					isError: true,
				};
			}
			previousOutput = getFinalOutput(result.messages);
		}

		const stepOutputs = results.map((r, idx) => {
			const output = getFinalOutput(r.messages);
			const status = r.exitCode === 0 ? "✓" : "✗";
			return `Step ${idx + 1} [${r.agent}] ${status}:\n${output || "(no output)"}`;
		});

		const finalResult = `Chain completed (${results.length} steps)\n\n${"=".repeat(80)}\n\n${stepOutputs.join(
			`\n\n${"=".repeat(80)}\n\n`,
		)}\n\n${"=".repeat(80)}\n\nFinal output:\n${previousOutput}`;

		return {
			output: finalResult,
			details: makeDetails("chain")(results),
		};
	}

	if (params.agent && params.task) {
		const result = await runSingleAgent(
			ctx.cwd,
			agents,
			params.agent,
			params.task,
			params.cwd,
			undefined,
			signal,
			onUpdate,
			makeDetails("single"),
			params.model,
			params.thinking,
			undefined,
			registerActiveRun,
			initialFollowUps,
		);
		const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
		if (isError) {
			const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
			return {
				output: `Agent ${result.stopReason || "failed"}: ${errorMsg}`,
				details: makeDetails("single")([result]),
				isError: true,
			};
		}
		return {
			output: getFinalOutput(result.messages) || "(no output)",
			details: makeDetails("single")([result]),
		};
	}

	const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
	return {
		output: `Invalid parameters. Available agents: ${available}`,
		details: makeDetails("single")([]),
		isError: true,
	};
}

export function parseLoopNumber(
	value: unknown,
	fallback: number,
	allowZero = false,
	maximum = Number.MAX_SAFE_INTEGER,
): number | null {
	if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return fallback;

	let parsed: number;
	if (typeof value === "number") {
		parsed = value;
	} else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		parsed = Number(value.trim());
	} else {
		return null;
	}

	if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) return null;
	if (!allowZero && parsed === 0) return null;
	return parsed;
}

async function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (delayMs <= 0) return;
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, delayMs);
		if (signal) {
			const cancel = () => {
				clearTimeout(timer);
				resolve();
			};
			if (signal.aborted) cancel();
			else signal.addEventListener("abort", cancel, { once: true });
		}
	});
}

export async function checkLoopCondition(
	pi: ExtensionAPI,
	command: string,
	cwd: string,
	signal?: AbortSignal,
	conditionTimeoutMs = DEFAULT_CONDITION_TIMEOUT_MS,
): Promise<{
	shouldContinue: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
	killed: boolean;
	timedOut: boolean;
}> {
	const result = await pi.exec("bash", ["-lc", command], { cwd, signal, timeout: conditionTimeoutMs });
	const stdout = (result.stdout || "").trim();
	const killed = Boolean(result.killed);
	const timedOut = killed && !signal?.aborted;
	const exitCode = result.code ?? (killed ? 1 : 0);
	const shouldContinue = !timedOut && exitCode === 0 && stdout.toLowerCase() === "true";
	return {
		shouldContinue,
		stdout,
		stderr: result.stderr || "",
		exitCode,
		killed,
		timedOut,
	};
}

async function confirmProjectAgentsOnce(params: any, ctx: any): Promise<boolean> {
	const agentScope: AgentScope = params.agentScope ?? "user";
	if (agentScope === "user" || !ctx.hasUI) return true;

	const discovery = discoverAgents(ctx.cwd, agentScope);
	const agents = discovery.agents;
	const requestedAgentNames = new Set<string>();
	if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
	if (params.agent) requestedAgentNames.add(params.agent);

	const projectAgentsRequested = Array.from(requestedAgentNames)
		.map((name) => agents.find((a) => a.name === name))
		.filter((a: AgentConfig | undefined): a is AgentConfig => a?.source === "project");

	if (projectAgentsRequested.length === 0) return true;

	const names = projectAgentsRequested.map((a) => a.name).join(", ");
	const dir = discovery.projectAgentsDir ?? "(unknown)";
	return ctx.ui.confirm(
		"Run project-local agents?",
		`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
	);
}

function extractTextFromContent(content: any): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part) => part && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

function writeLargeOutputToTempFile(prefix: string, output: string): string | null {
	try {
		const id = crypto.randomBytes(8).toString("hex");
		const filePath = path.join(os.tmpdir(), `pi-${prefix}-${id}.log`);
		fs.writeFileSync(filePath, output, { encoding: "utf-8", mode: 0o600 });
		return filePath;
	} catch {
		return null;
	}
}

function createIterationArtifactDirectory(runId: string): string | null {
	try {
		return fs.mkdtempSync(path.join(os.tmpdir(), `pi-ralph-loop-${runId}-`));
	} catch {
		return null;
	}
}

export function writeIterationArtifact(
	directory: string | null,
	iterationIndex: number,
	details: SubagentDetails,
	output: string,
): string | null {
	if (!directory) return null;
	try {
		const filePath = path.join(directory, `iteration-${iterationIndex}.md`);
		let serializedDetails = "(structured details could not be serialized)";
		try {
			serializedDetails = JSON.stringify(details, null, 2);
		} catch {
			// Preserve the textual output even if a provider-specific detail is not serializable.
		}
		const content = [
			`# Ralph loop iteration ${iterationIndex}`,
			"",
			"## Final output",
			"",
			output || "(no output)",
			"",
			"## Structured details",
			"",
			"```json",
			serializedDetails,
			"```",
			"",
		].join("\n");
		fs.writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o600 });
		return filePath;
	} catch {
		return null;
	}
}

function formatTailTruncationNotice(truncation: any, fullOutputPath: string | null, fullOutput: string): string {
	if (!truncation?.truncated) return "";
	const startLine = truncation.totalLines - truncation.outputLines + 1;
	const endLine = truncation.totalLines;
	const fullOutputLabel = fullOutputPath ? `Full output: ${fullOutputPath}` : "Full output: (failed to save)";

	if (truncation.lastLinePartial) {
		const lastLine = fullOutput.split("\n").pop() || "";
		let lastLineBytes = 0;
		try {
			lastLineBytes = new TextEncoder().encode(lastLine).length;
		} catch {
			lastLineBytes = lastLine.length;
		}
		const lastLineSize = formatSize(lastLineBytes);
		return `[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). ${fullOutputLabel}]`;
	}
	if (truncation.truncatedBy === "lines") {
		return `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. ${fullOutputLabel}]`;
	}
	return `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(truncation.maxBytes)} limit). ${fullOutputLabel}]`;
}

function formatLastOutputForSummary(lastOutput: string, compact = false): { text: string; fullOutputPath: string | null } {
	// Keep the interactive tool result compact in the main chat. The complete
	// output is still retained in the run details (and optionally written to a
	// temp file). Non-UI modes retain the previous output limits.
	const truncation = compact ? truncateTail(lastOutput, { maxLines: 20, maxBytes: 4_000 }) : truncateTail(lastOutput);
	let outputText = truncation.content || "(no output)";
	if (!truncation.truncated) return { text: outputText, fullOutputPath: null };

	const fullOutputPath = writeLargeOutputToTempFile("ralph-loop", lastOutput);
	const notice = formatTailTruncationNotice(truncation, fullOutputPath, lastOutput);
	if (notice) outputText += `\n\n${notice}`;
	return { text: outputText, fullOutputPath };
}

function getLastUserText(ctx: any): string | null {
	const entries = ctx.sessionManager?.getEntries?.() ?? [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "message") continue;
		const msg = entry.message;
		if (msg?.role !== "user") continue;
		const text = extractTextFromContent(msg.content);
		if (text.trim()) return text.trim();
	}
	return null;
}

function pickDefaultAgent(agents: AgentConfig[]): string | null {
	if (agents.length === 0) return null;
	const worker = agents.find((a) => a.name === "worker");
	return worker?.name ?? agents[0].name;
}

function inferConditionCommandFromText(text: string | undefined): string | null {
	if (!text) return null;
	const lines = text.split("\n");
	for (const line of lines) {
		const match = line.match(/^(?:\s*)(?:condition|exit condition|loop condition)\s*:\s*(.+)$/i);
		if (match) return match[1].trim();
	}
	const backtick = text.match(/\b(?:until|while)\s+`([^`]+)`/i);
	if (backtick) return backtick[1].trim();
	const inline = text.match(/\b(?:until|while)\s+([^\n.]+)$/i);
	if (inline) return inline[1].replace(/[.?!]$/, "").trim();
	return null;
}

function buildLoopPromptInfo(params: any): LoopPromptInfo {
	if (Array.isArray(params.chain) && params.chain.length > 0) {
		return {
			mode: "chain",
			items: params.chain.map((step: any) => ({
				agent: step.agent,
				task: step.task,
				model: step.model,
				thinking: step.thinking,
			})),
		};
	}
	return {
		mode: "single",
		items: [
			{
				agent: params.agent || "(auto)",
				task: params.task || "",
				model: params.model,
				thinking: params.thinking,
			},
		],
	};
}

function formatLoopPromptItem(item: LoopPromptItem, maxTaskLength: number): string {
	const overrides: string[] = [];
	if (item.model) overrides.push(item.model);
	if (item.thinking) overrides.push(`thinking:${item.thinking}`);
	const overrideText = overrides.length > 0 ? ` (${overrides.join(", ")})` : "";
	const task = item.task || "";
	const preview = task.length > maxTaskLength ? `${task.slice(0, maxTaskLength)}...` : task;
	return `${item.agent}${overrideText}${preview ? ` ${preview}` : ""}`;
}

export default function (pi: ExtensionAPI) {
	const loopControl: LoopControlState = {
		status: "idle",
		runId: null,
		iterations: 0,
		steering: [],
		steeringOnce: [],
		followUps: [],
		steeringSent: [],
		followUpsSent: [],
		paused: false,
		abortController: null,
		lastDetails: null,
	};

	const activeRuns = new Set<ActiveRun>();
	const viewerRefreshers = new Set<() => void>();
	const registerActiveRun: ActiveRunRegistration = (run) => {
		activeRuns.add(run);
		return () => activeRuns.delete(run);
	};

	const sendFollowUpToActive = async (message: string) => {
		const runs = Array.from(activeRuns);
		if (runs.length === 0) return false;
		let delivered = false;
		await Promise.all(
			runs.map(async (run) => {
				try {
					await run.sendFollowUp(message);
					delivered = true;
				} catch {
					// ignore
				}
			}),
		);
		return delivered;
	};

	const sendSteerToActive = async (message: string) => {
		const runs = Array.from(activeRuns);
		if (runs.length === 0) return false;
		let delivered = false;
		await Promise.all(
			runs.map(async (run) => {
				try {
					await run.sendSteer(message);
					delivered = true;
				} catch {
					// ignore
				}
			}),
		);
		return delivered;
	};

	const getLoopStatusLine = () => {
		if (loopControl.status === "idle") return undefined;
		const details = loopControl.lastDetails;
		const iterations = details?.iterations.length ?? loopControl.iterations;
		const maxIterations = details?.maxIterations;
		const maxLabel =
			typeof maxIterations === "number" && maxIterations !== Number.MAX_SAFE_INTEGER ? `/${maxIterations}` : "";
		return `ralph-loop ${loopControl.status}: ${iterations}${maxLabel}`;
	};

	const ensureActiveLoop = (ctx: any) => {
		if (loopControl.status === "idle") {
			ctx.ui.notify("No active ralph_loop run.", "warning");
			return false;
		}
		return true;
	};

	pi.registerCommand("ralph-steer", {
		description: "Queue a steering message for the active ralph_loop run",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Interactive mode required.", "error");
				return;
			}
			if (!ensureActiveLoop(ctx)) return;

			let message = args.trim();
			let once = false;
			if (message.startsWith("--once ")) {
				once = true;
				message = message.slice("--once ".length).trim();
			}
			if (!message) {
				const input = await ctx.ui.input("Steer ralph_loop:", "Add guidance for next iterations");
				if (!input) return;
				message = input.trim();
			}
			if (!message) return;

			const sentToActive = await sendSteerToActive(message);
			if (sentToActive) {
				loopControl.steeringSent.push(message);
			} else {
				if (once) {
					loopControl.steeringOnce.push(message);
				} else {
					loopControl.steering.push(message);
				}
			}

			if (sentToActive) {
				ctx.ui.notify("Queued for current iteration.", "info");
			} else {
				ctx.ui.notify(once ? "One-off steering queued for next iteration." : "Steering queued for next iteration.", "info");
			}
			ctx.ui.setStatus("ralph-loop", getLoopStatusLine());
		},
	});

	pi.registerCommand("ralph-follow", {
		description: "Queue a follow-up message for the active ralph_loop run",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Interactive mode required.", "error");
				return;
			}
			if (!ensureActiveLoop(ctx)) return;

			let message = args.trim();
			if (!message) {
				const input = await ctx.ui.input("Follow up ralph_loop:", "Queue a follow-up message");
				if (!input) return;
				message = input.trim();
			}
			if (!message) return;

			const sentToActive = await sendFollowUpToActive(message);
			if (sentToActive) {
				loopControl.followUpsSent.push(message);
				ctx.ui.notify("Queued for current iteration.", "info");
			} else {
				loopControl.followUps.push(message);
				ctx.ui.notify("Follow-up queued for next iteration.", "info");
			}
			ctx.ui.setStatus("ralph-loop", getLoopStatusLine());
		},
	});

	pi.registerCommand("ralph-clear", {
		description: "Clear queued steering for ralph_loop",
		handler: async (_args, ctx) => {
			loopControl.steering = [];
			loopControl.steeringOnce = [];
			ctx.ui.notify("Cleared steering queue.", "info");
			ctx.ui.setStatus("ralph-loop", getLoopStatusLine());
		},
	});

	pi.registerCommand("ralph-pause", {
		description: "Pause the currently running ralph_loop iteration",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Interactive mode required.", "error");
				return;
			}
			if (!ensureActiveLoop(ctx)) return;
			if (loopControl.paused) {
				ctx.ui.notify("ralph_loop is already paused.", "info");
				return;
			}
			const paused = pauseActiveRuns(loopControl, activeRuns);
			if (!paused) {
				ctx.ui.notify("No running iteration to pause.", "warning");
				return;
			}
			ctx.ui.notify("Paused current iteration.", "info");
			ctx.ui.setStatus("ralph-loop", getLoopStatusLine());
		},
	});

	pi.registerCommand("ralph-resume", {
		description: "Resume a paused ralph_loop",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Interactive mode required.", "error");
				return;
			}
			if (!ensureActiveLoop(ctx)) return;
			if (!loopControl.paused) {
				ctx.ui.notify("ralph_loop is not paused.", "info");
				return;
			}
			const hadRuns = activeRuns.size > 0;
			const resumed = resumeActiveRuns(loopControl, activeRuns);
			if (!resumed) {
				ctx.ui.notify("No paused iteration to resume.", "warning");
				return;
			}
			ctx.ui.notify(hadRuns ? "Resumed current iteration." : "Cleared paused state.", "info");
			ctx.ui.setStatus("ralph-loop", getLoopStatusLine());
		},
	});

	pi.registerCommand("ralph-stop", {
		description: "Stop the active ralph_loop run",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Interactive mode required.", "error");
				return;
			}
			if (!ensureActiveLoop(ctx)) return;
			loopControl.status = "stopping";
			loopControl.abortController?.abort();
			resumeActiveRuns(loopControl, activeRuns);
			ctx.ui.notify("Stop requested for ralph_loop.", "warning");
			ctx.ui.setStatus("ralph-loop", getLoopStatusLine());
		},
	});

	pi.registerCommand("ralph-status", {
		description: "Show ralph_loop status",
		handler: async (_args, ctx) => {
			const details = loopControl.lastDetails;
			if (loopControl.status === "idle" && !details) {
				ctx.ui.notify("No ralph_loop activity yet.", "info");
				return;
			}
			const iterations = details?.iterations.length ?? loopControl.iterations;
			const maxIterations = details?.maxIterations;
			const maxLabel =
				typeof maxIterations === "number" && maxIterations !== Number.MAX_SAFE_INTEGER ? `/${maxIterations}` : "";
			const steeringCount = loopControl.steering.length + loopControl.steeringOnce.length;
			const followUpCount = loopControl.followUps.length;
			const parts = [`Status: ${loopControl.status}`];
			if (loopControl.runId) parts.push(`Run: ${loopControl.runId}`);
			parts.push(`Iterations: ${iterations}${maxLabel}`);
			if (loopControl.status === "idle" && details?.stopReason) parts.push(`Last stop: ${details.stopReason}`);
			if (details?.stopOnCompletion) {
				parts.push(`Completion: ${details.completionStreak}/${details.completionConfirmations}`);
			}
			if (details?.handoffMode && details.handoffMode !== "none") parts.push(`Handoff: ${details.handoffMode}`);
			if (steeringCount > 0) parts.push(`Steering queued: ${steeringCount}`);
			if (followUpCount > 0) parts.push(`Follow-ups queued: ${followUpCount}`);
			ctx.ui.notify(parts.join(" | "), "info");
		},
	});

	pi.registerCommand("ralph-view", {
		description: "Select and view ralph_loop history",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI || typeof ctx.ui?.custom !== "function") {
				ctx.ui?.notify?.("Interactive overlay UI is required for /ralph-view.", "info");
				return;
			}

			const entries = ctx.sessionManager?.getEntries?.() ?? [];
			const activeDetails = loopControl.lastDetails;
			const activeRunId = loopControl.status === "idle" ? null : loopControl.runId;
			const runs = discoverRalphLoopRuns(entries, activeDetails, activeRunId);
			if (runs.length === 0) {
				ctx.ui.notify("No ralph_loop runs available to view.", "info");
				return;
			}

			// This is intentionally a separate interaction. Do not open the
			// viewer implicitly for the latest run.
			const selected = await selectRalphLoopRun(ctx, runs);
			if (!selected) return;

			const overlayConfig = getRalphLoopOverlayConfig();
			let overlayTui: any;
			let viewer: RalphLoopViewer | undefined;
			// Keep the last active snapshot with the selected run. The active run
			// can finish while the overlay is open, and loopControl is reused by a
			// later invocation.
			let selectedDetails = selected.details;
			let refreshScheduled = false;
			const getDetails = () =>
				selected.active && loopControl.runId === selected.runId
					? loopControl.lastDetails || selectedDetails
					: selectedDetails;
			const refresh = () => {
				// Completed runs are immutable snapshots. Ignore updates from a
				// later run, and avoid waking a viewer for an unrelated run.
				if (!selected.active || loopControl.runId !== selected.runId || !loopControl.lastDetails) return;
				selectedDetails = loopControl.lastDetails;
				// RPC events can arrive in bursts. Invalidate immediately so a
				// synchronous render sees fresh data, but schedule at most one TUI
				// render request per turn of the event loop.
				viewer?.invalidate();
				if (refreshScheduled) return;
				refreshScheduled = true;
				queueMicrotask(() => {
					refreshScheduled = false;
					if (viewer) overlayTui?.requestRender?.();
				});
			};
			viewerRefreshers.add(refresh);
			try {
				await ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: (result: null) => void) => {
					overlayTui = tui;
					viewer = new RalphLoopViewer(
						selected,
						getDetails,
						tui,
						theme,
						done,
						ctx.cwd,
						overlayConfig.heightPercent,
					);
					return viewer;
				}, {
					overlay: true,
					overlayOptions: {
						width: `${overlayConfig.widthPercent}%`,
						maxHeight: `${overlayConfig.heightPercent}%`,
						anchor: "center",
						margin: 1,
					},
				});
			} finally {
				viewerRefreshers.delete(refresh);
				viewer?.dispose?.();
				viewer = undefined;
				overlayTui = undefined;
			}
		},
	});

	pi.registerTool({
		name: "ralph_loop",
		label: "Ralph Loop",
		description: [
			"Run subagent tasks in a loop while a condition command exits successfully and prints 'true' to continue.",
			"Supports single and chain modes.",
			"Use it for iterative work that benefits from repeated fresh subagent passes; use a normal subagent for one-shot work.",
			"Build task prompts as standalone objectives with acceptance criteria and workspace context; do not use a prompt that only says 'continue'.",
			"For implementation or review work, ask each iteration to inspect the current state, make concrete progress, run appropriate checks, and report remaining work.",
			"Supports model/thinking overrides like subagent.",
			"Defaults to agent 'worker' and the latest user message when agent/task are omitted.",
			`Defaults to ${DEFAULT_LOOP_MAX_ITERATIONS} iterations, with a maximum of ${MAX_LOOP_ITERATIONS} and a ${DEFAULT_CONDITION_TIMEOUT_MS}ms condition timeout.`,
			"Set maxIterations to the desired hard cap; leave stopOnCompletion false for fixed/reliable iteration counts.",
			`Completion stopping is opt-in via stopOnCompletion; enable it only when early completion is useful and the task has clear, verifiable acceptance criteria. ${COMPLETION_MARKER} is a subagent claim, not independent proof; when enabled, it requires ${DEFAULT_COMPLETION_CONFIRMATIONS} consecutive signals from the final assistant output.`,
			`Handoff defaults to ${DEFAULT_HANDOFF_MODE}; the original task is preserved and previous iteration context is appended.`,
			"If conditionCommand is omitted, it is inferred from the task text or defaults to 'echo true'.",
		].join(" "),
		parameters: LoopParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const emptyPrompt: LoopPromptInfo = { mode: "single", items: [] };
			const invocationRunId = crypto.randomUUID().slice(0, 8);

			const buildDetails = (overrides: Partial<RalphLoopDetails>): RalphLoopDetails => ({
				runId: invocationRunId,
				iterations: [],
				stopReason: "invalid-params",
				conditionCommand: "",
				conditionSource: "default",
				maxIterations: DEFAULT_LOOP_MAX_ITERATIONS,
				sleepMs: DEFAULT_LOOP_SLEEP_MS,
				conditionTimeoutMs: DEFAULT_CONDITION_TIMEOUT_MS,
				lastCondition: { stdout: "", stderr: "", exitCode: 0 },
				prompt: emptyPrompt,
				steering: [...loopControl.steering, ...loopControl.steeringOnce],
				followUps: [...loopControl.followUps],
				steeringSent: [...loopControl.steeringSent],
				followUpsSent: [...loopControl.followUpsSent],
				status: loopControl.status,
				stopOnCompletion: DEFAULT_STOP_ON_COMPLETION,
				completionConfirmations: DEFAULT_COMPLETION_CONFIRMATIONS,
				completionStreak: 0,
				handoffMode: DEFAULT_HANDOFF_MODE,
				artifactPaths: [],
				...overrides,
			});

			if (signal?.aborted) {
				return {
					content: [{ type: "text", text: "ralph_loop aborted." }],
					details: buildDetails({ stopReason: "aborted" }),
					isError: true,
				};
			}

			if (agents.length === 0) {
				return {
					content: [{ type: "text", text: "No agents available for the selected scope." }],
					details: buildDetails({ stopReason: "no-agents" }),
					isError: true,
				};
			}

			const loopParams: any = { ...params, agentScope };
			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent || params.task);

			if (hasTasks) {
				return {
					content: [{ type: "text", text: "Parallel mode is not supported. Use chain instead." }],
					details: buildDetails({ stopReason: "invalid-params" }),
					isError: true,
				};
			}

			const modeCount = Number(hasChain) + Number(hasSingle);

			if (modeCount > 1) {
				return {
					content: [{ type: "text", text: "Provide exactly one mode (single or chain)." }],
					details: buildDetails({ stopReason: "invalid-params" }),
					isError: true,
				};
			}

			if (!hasChain && !hasSingle) {
				const inferredTask = getLastUserText(ctx);
				const defaultAgent = pickDefaultAgent(agents);
				if (!inferredTask || !defaultAgent) {
					return {
						content: [
							{
								type: "text",
								text: "Unable to infer task or agent. Provide agent/task or chain.",
							},
						],
						details: buildDetails({ stopReason: "missing-task" }),
						isError: true,
					};
				}
				loopParams.agent = defaultAgent;
				loopParams.task = inferredTask;
			}

			if (hasSingle) {
				if (!loopParams.agent) {
					const defaultAgent = pickDefaultAgent(agents);
					if (!defaultAgent) {
						return {
							content: [{ type: "text", text: "No agents available for the selected scope." }],
							details: buildDetails({ stopReason: "no-agents" }),
							isError: true,
						};
					}
					loopParams.agent = defaultAgent;
				}
				if (!loopParams.task) {
					const inferredTask = getLastUserText(ctx);
					if (!inferredTask) {
						return {
							content: [{ type: "text", text: "Unable to infer task. Provide a task." }],
							details: buildDetails({ stopReason: "missing-task" }),
							isError: true,
						};
					}
					loopParams.task = inferredTask;
				}
			}

			const sessionThinking = pi.getThinkingLevel();
			if (loopParams.thinking === undefined) {
				loopParams.thinking = sessionThinking;
			}
			if (Array.isArray(loopParams.chain)) {
				loopParams.chain = loopParams.chain.map((step: any) => ({
					...step,
					thinking: step.thinking ?? loopParams.thinking,
				}));
			}

			const promptInfo = buildLoopPromptInfo(loopParams);

			const conditionCandidate =
				typeof params.conditionCommand === "string" && params.conditionCommand.trim()
					? params.conditionCommand.trim()
					: null;

			let conditionSource: "provided" | "inferred" | "default" = "default";
			let conditionCommand = conditionCandidate || "";
			if (conditionCandidate) {
				conditionSource = "provided";
			} else {
				let textForInference: string | undefined;
				if (typeof loopParams.task === "string") textForInference = loopParams.task;
				else if (Array.isArray(loopParams.chain) && loopParams.chain.length > 0) textForInference = loopParams.chain[0].task;
				const inferred = inferConditionCommandFromText(textForInference);
				if (inferred) {
					conditionCommand = inferred;
					conditionSource = "inferred";
				} else {
					conditionCommand = "echo true";
					conditionSource = "default";
				}
			}

			const maxIterations = parseLoopNumber(
				params.maxIterations,
				DEFAULT_LOOP_MAX_ITERATIONS,
				false,
				MAX_LOOP_ITERATIONS,
			);
			if (maxIterations === null) {
				return {
					content: [{
						type: "text",
						text: `maxIterations must be a positive safe integer no greater than ${MAX_LOOP_ITERATIONS}.`,
					}],
					details: buildDetails({
						stopReason: "invalid-params",
						conditionCommand,
						conditionSource,
						prompt: promptInfo,
					}),
					isError: true,
				};
			}

			const sleepMs = parseLoopNumber(params.sleepMs, DEFAULT_LOOP_SLEEP_MS, true);
			if (sleepMs === null) {
				return {
					content: [{ type: "text", text: "sleepMs must be a non-negative safe integer." }],
					details: buildDetails({
						stopReason: "invalid-params",
						conditionCommand,
						conditionSource,
						maxIterations,
						prompt: promptInfo,
					}),
					isError: true,
				};
			}

			const conditionTimeoutMs = parseLoopNumber(
				params.conditionTimeoutMs,
				DEFAULT_CONDITION_TIMEOUT_MS,
				false,
				MAX_CONDITION_TIMEOUT_MS,
			);
			if (conditionTimeoutMs === null) {
				return {
					content: [{
						type: "text",
						text: `conditionTimeoutMs must be a positive safe integer no greater than ${MAX_CONDITION_TIMEOUT_MS}.`,
					}],
					details: buildDetails({
						stopReason: "invalid-params",
						conditionCommand,
						conditionSource,
						maxIterations,
						sleepMs,
						prompt: promptInfo,
					}),
					isError: true,
				};
			}

			const stopOnCompletion = params.stopOnCompletion ?? DEFAULT_STOP_ON_COMPLETION;
			if (typeof stopOnCompletion !== "boolean") {
				return {
					content: [{ type: "text", text: "stopOnCompletion must be a boolean." }],
					details: buildDetails({ stopReason: "invalid-params", conditionCommand, conditionSource, maxIterations, sleepMs, conditionTimeoutMs, prompt: promptInfo }),
					isError: true,
				};
			}

			const completionConfirmations = parseLoopNumber(
				params.completionConfirmations,
				DEFAULT_COMPLETION_CONFIRMATIONS,
				false,
				MAX_COMPLETION_CONFIRMATIONS,
			);
			if (completionConfirmations === null) {
				return {
					content: [{ type: "text", text: `completionConfirmations must be a positive safe integer no greater than ${MAX_COMPLETION_CONFIRMATIONS}.` }],
					details: buildDetails({ stopReason: "invalid-params", conditionCommand, conditionSource, maxIterations, sleepMs, conditionTimeoutMs, prompt: promptInfo }),
					isError: true,
				};
			}

			const handoffMode: HandoffMode = params.handoffMode ?? DEFAULT_HANDOFF_MODE;
			if (handoffMode !== "none" && handoffMode !== "summary" && handoffMode !== "artifact") {
				return {
					content: [{ type: "text", text: "handoffMode must be one of: none, summary, artifact." }],
					details: buildDetails({ stopReason: "invalid-params", conditionCommand, conditionSource, maxIterations, sleepMs, conditionTimeoutMs, prompt: promptInfo }),
					isError: true,
				};
			}

			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			const approved = confirmProjectAgents ? await confirmProjectAgentsOnce(loopParams, ctx) : true;
			if (!approved) {
				return {
					content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
					details: buildDetails({
						stopReason: "canceled",
						conditionCommand,
						conditionSource,
						maxIterations,
						sleepMs,
						conditionTimeoutMs,
						prompt: promptInfo,
					}),
					isError: true,
				};
			}
			loopParams.confirmProjectAgents = false;

			const runAbortController = new AbortController();
			const mergedSignal = mergeAbortSignals(signal, runAbortController.signal);
			const baseLoopParams = cloneLoopParams(loopParams);

			loopControl.status = "running";
			loopControl.runId = invocationRunId;
			loopControl.iterations = 0;
			loopControl.steering = [];
			loopControl.steeringOnce = [];
			loopControl.followUps = [];
			loopControl.steeringSent = [];
			loopControl.followUpsSent = [];
			loopControl.paused = false;
			loopControl.abortController = runAbortController;
			loopControl.lastDetails = null;

			if (ctx.hasUI) {
				ctx.ui.setStatus("ralph-loop", getLoopStatusLine());
			}

			const iterations: LoopIterationResult[] = [];
			let stopReason = "running";
			let errorMessage = "";
			let lastCondition: RalphLoopDetails["lastCondition"] = {
				stdout: "",
				stderr: "",
				exitCode: 0,
				killed: false,
				timedOut: false,
			};
			const artifactDirectory = handoffMode === "none" ? null : createIterationArtifactDirectory(invocationRunId);
			const artifactPaths: string[] = [];
			let previousHandoff: string | null = null;
			let previousArtifactPath: string | null = null;
			let completionStreak = 0;

			const buildLoopDetails = (currentIterations: LoopIterationResult[]): RalphLoopDetails => {
				const details: RalphLoopDetails = {
					runId: invocationRunId,
					iterations: [...currentIterations],
					stopReason,
					conditionCommand,
					conditionSource,
					maxIterations,
					sleepMs,
					conditionTimeoutMs,
					lastCondition,
					prompt: promptInfo,
					steering: [...loopControl.steering, ...loopControl.steeringOnce],
					followUps: [...loopControl.followUps],
					steeringSent: [...loopControl.steeringSent],
					followUpsSent: [...loopControl.followUpsSent],
					status: loopControl.status,
					stopOnCompletion,
					completionConfirmations,
					completionStreak,
					handoffMode,
					artifactPaths: [...artifactPaths],
				};
				loopControl.iterations = currentIterations.length;
				loopControl.lastDetails = details;
				for (const refresh of viewerRefreshers) refresh();
				return details;
			};

			// Publish an empty active snapshot so /ralph-view can select a run
			// while the first condition check or iteration is still in flight.
			buildLoopDetails(iterations);

			const emitUpdate = () => {
				const details = buildLoopDetails(iterations);
				if (ctx.hasUI) {
					ctx.ui.setStatus("ralph-loop", getLoopStatusLine());
				}
				if (!onUpdate) return;
				onUpdate({
					content: [
						{
							type: "text",
							text: `ralph-loop: ${iterations.length}/${maxIterations} iterations complete`,
						},
					],
					details,
				});
			};

			for (let i = 0; i < maxIterations; i++) {
				if (mergedSignal?.aborted) {
					stopReason = "aborted";
					break;
				}

				if (mergedSignal?.aborted) {
					stopReason = "aborted";
					break;
				}

				const condition = await checkLoopCondition(pi, conditionCommand, ctx.cwd, mergedSignal, conditionTimeoutMs);
				lastCondition = {
					stdout: condition.stdout,
					stderr: condition.stderr,
					exitCode: condition.exitCode,
					killed: condition.killed,
					timedOut: condition.timedOut,
				};
				if (mergedSignal?.aborted) {
					stopReason = "aborted";
					break;
				}
				if (condition.timedOut) {
					stopReason = "condition-timeout";
					break;
				}
				if (condition.exitCode !== 0) {
					stopReason = "condition-error";
					break;
				}
				if (!condition.shouldContinue) {
					stopReason = "condition-false";
					break;
				}

				const iterationIndex = i + 1;
				const iterationUpdate: OnUpdateCallback | undefined = onUpdate
					? (partial) => {
						if (!partial.details) return;
						const partialOutput = extractTextFromContent(partial.content);
						const streamingIterations = [
							...iterations,
							{
								index: iterationIndex,
								details: partial.details,
								output: partialOutput || "(running...)",
								isError: partial.isError,
							},
						];
						const details = buildLoopDetails(streamingIterations);
						if (ctx.hasUI) {
							ctx.ui.setStatus("ralph-loop", getLoopStatusLine());
						}
						onUpdate({
							content: partial.content ?? [
								{ type: "text", text: `ralph-loop iteration ${iterationIndex} running...` },
							],
							details,
						});
					}
					: undefined;

				let runResult: LoopExecutionResult | null = null;
				const steeringOnceCount = loopControl.steeringOnce.length;
				const steeringText = formatSteeringText([...loopControl.steering, ...loopControl.steeringOnce]);
				const iterationParams = applyIterationContextToParams(
					applySteeringToParams(baseLoopParams, steeringText),
					{
						stopOnCompletion,
						verificationPass: completionStreak,
						handoffMode,
						handoff: previousHandoff,
						artifactPath: previousArtifactPath,
					},
				);
				const queuedFollowUps = loopControl.followUps;
				if (queuedFollowUps.length > 0) {
					loopControl.followUps = [];
					loopControl.followUpsSent.push(...queuedFollowUps);
				}
				try {
					runResult = await executeSubagentOnce(
						iterationParams,
						ctx,
						mergedSignal,
						iterationUpdate,
						registerActiveRun,
						queuedFollowUps,
					);
				} catch (error: any) {
					stopReason = mergedSignal?.aborted ? "aborted" : "error";
					errorMessage = error?.message || String(error);
					break;
				}
				loopControl.steeringOnce = loopControl.steeringOnce.slice(steeringOnceCount);
				loopControl.steeringSent = [];
				loopControl.followUpsSent = [];
				if (loopControl.paused && activeRuns.size === 0) {
					clearPausedState(loopControl);
				}

				const artifactPath = writeIterationArtifact(artifactDirectory, iterationIndex, runResult.details, runResult.output);
				if (artifactPath) {
					artifactPaths.push(artifactPath);
					previousArtifactPath = artifactPath;
				}
				previousHandoff = handoffMode === "summary" ? extractRalphHandoff(getCompletionText(runResult.details)) : null;
				const completion = !runResult.isError && stopOnCompletion && hasCompletionMarker(getCompletionText(runResult.details));
				const streak = updateCompletionStreak(completionStreak, completion, completionConfirmations);
				completionStreak = streak.streak;

				iterations.push({
					index: iterationIndex,
					details: runResult.details,
					output: runResult.output,
					isError: runResult.isError,
				});
				emitUpdate();

				if (runResult.isError) {
					stopReason = "error";
					errorMessage = runResult.output;
					break;
				}

				if (stopOnCompletion && completionStreak >= completionConfirmations) {
					stopReason = "agent-complete";
					break;
				}

				if (sleepMs > 0 && i < maxIterations - 1) {
					await sleep(sleepMs, mergedSignal);
				}
			}

			if (stopReason === "running") {
				stopReason = "max-iterations";
			}

			const lastOutput = iterations.length > 0 ? iterations[iterations.length - 1].output : "";
			const summaryLines = [
				`ralph-loop finished after ${iterations.length} iteration${iterations.length === 1 ? "" : "s"}.`,
				`Stop reason: ${stopReason}.`,
				`Condition: ${conditionCommand} (${conditionSource}).`,
				`Condition timeout: ${conditionTimeoutMs}ms.`,
				`Max iterations: ${maxIterations}.`,
				`Sleep: ${sleepMs}ms.`,
				`Completion: ${stopOnCompletion ? `${completionStreak}/${completionConfirmations} confirmations` : "disabled"}.`,
				`Handoff: ${handoffMode}.`,
			];
			if (artifactPaths.length > 0) summaryLines.push(`Iteration artifacts: ${artifactPaths.join(", ")}`);

			if (lastCondition.stdout) summaryLines.push(`Condition stdout: ${lastCondition.stdout}`);
			if (lastCondition.stderr) summaryLines.push(`Condition stderr: ${lastCondition.stderr}`);
			if (lastCondition.exitCode !== 0) summaryLines.push(`Condition exit code: ${lastCondition.exitCode}`);
			if (errorMessage && errorMessage !== lastOutput) summaryLines.push(`Error: ${errorMessage}`);
			let lastOutputFullPath: string | null = null;
			if (lastOutput) {
				const formatted = formatLastOutputForSummary(lastOutput, Boolean(ctx.hasUI));
				lastOutputFullPath = formatted.fullOutputPath;
				summaryLines.push(`Last output:\n${formatted.text}`);
			}

			loopControl.status = "idle";
			loopControl.abortController = null;
			loopControl.paused = false;
			loopControl.steering = [];
			loopControl.steeringOnce = [];
			loopControl.followUps = [];
			loopControl.steeringSent = [];
			loopControl.followUpsSent = [];
			if (ctx.hasUI) {
				ctx.ui.setStatus("ralph-loop", undefined);
			}

			const finalDetails = buildLoopDetails(iterations);
			if (lastOutputFullPath) {
				(finalDetails as any).lastOutputPath = lastOutputFullPath;
			}
			const summaryText = summaryLines.join("\n\n");
			const isError = ["error", "aborted", "condition-error", "condition-timeout"].includes(stopReason);
			return {
				content: [{ type: "text", text: summaryText }],
				details: finalDetails,
				isError,
			};
		},

		renderCall(args, theme) {
			const scope: AgentScope = args.agentScope ?? "user";
			const hasChain = Array.isArray(args.chain) && args.chain.length > 0;
			const hasSingle = Boolean(args.agent || args.task);
			const mode = hasChain ? `chain (${args.chain.length} steps)` : hasSingle ? `single ${args.agent || "(auto)"}` : "auto";
			const condition = args.conditionCommand ? `cond: ${args.conditionCommand}` : "cond: (auto)";
			const maxIterations = args.maxIterations ?? DEFAULT_LOOP_MAX_ITERATIONS;
			const sleepMs = args.sleepMs ?? DEFAULT_LOOP_SLEEP_MS;
			const conditionTimeoutMs = args.conditionTimeoutMs ?? DEFAULT_CONDITION_TIMEOUT_MS;
			const stopOnCompletion = args.stopOnCompletion ?? DEFAULT_STOP_ON_COMPLETION;
			const completionConfirmations = args.completionConfirmations ?? DEFAULT_COMPLETION_CONFIRMATIONS;
			const handoffMode = args.handoffMode ?? DEFAULT_HANDOFF_MODE;
			const promptInfo = buildLoopPromptInfo(args);
			let text =
				theme.fg("toolTitle", theme.bold("ralph_loop ")) +
				theme.fg("accent", mode) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", condition)}`;
			if (promptInfo.items.length > 0) {
				const preview = formatLoopPromptItem(promptInfo.items[0], 40);
				const more = promptInfo.items.length > 1 ? ` +${promptInfo.items.length - 1} more` : "";
				text += `\n  ${theme.fg("dim", `prompt: ${preview}${more}`)}`;
			}
			text += `\n  ${theme.fg("dim", `max:${maxIterations} sleep:${sleepMs}ms condition-timeout:${conditionTimeoutMs}ms`)}`;
			text += `\n  ${theme.fg("dim", `completion:${stopOnCompletion ? `${completionConfirmations}x required` : "off"} handoff:${handoffMode}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as RalphLoopDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const iterations = details.iterations || [];
			const status = details.status || "completed";
			const isError = ["error", "aborted", "condition-error", "condition-timeout"].includes(details.stopReason);
			const isActive = status === "running" || status === "paused" || status === "stopping";
			const icon = isError
				? theme.fg("error", "✗")
				: isActive
					? theme.fg("accent", "•")
					: theme.fg("success", "✓");
			const maxIterations = typeof details.maxIterations === "number"
				? `/${details.maxIterations}`
				: "";
			const runId = details.runId || "(legacy run)";
			const lines = [
				`${icon} ${theme.fg("toolTitle", theme.bold("ralph_loop "))}${theme.fg("accent", `${status}: ${iterations.length}${maxIterations} iteration${iterations.length === 1 ? "" : "s"}`)}`,
				`${theme.fg("dim", `Run: ${runId} · Stop: ${details.stopReason}`)}`,
				`${theme.fg("muted", "Use /ralph-view to inspect the full history.")}`,
			];
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
