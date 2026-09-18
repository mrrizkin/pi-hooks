/** Lightweight, overlay-only UI for browsing ralph-loop history. */

import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";

export interface RalphLoopRun {
	runId: string;
	details: any;
	active: boolean;
}

export type LoopViewerAction = "up" | "down" | "pageUp" | "pageDown" | "home" | "end";
export type OutputDisplayMode = "collapsed" | "simple" | "full";

export const DEFAULT_RALPH_VIEW_WIDTH_PERCENT = 90;
export const DEFAULT_RALPH_VIEW_HEIGHT_PERCENT = 90;

export interface RalphLoopOverlayConfig {
  widthPercent: number;
  heightPercent: number;
}

export function parseOverlayPercent(value: unknown, fallback: number): number {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const text = String(value).trim().replace(/%$/, "");
  if (!text || !/^\d+(?:\.\d+)?$/.test(text)) return fallback;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) return fallback;
  return parsed;
}

export function getRalphLoopOverlayConfig(env: Record<string, unknown> = process.env): RalphLoopOverlayConfig {
  return {
    widthPercent: parseOverlayPercent(
      env.RALPH_VIEW_WIDTH_PERCENT ?? env.RALPH_VIEW_WIDTH,
      DEFAULT_RALPH_VIEW_WIDTH_PERCENT,
    ),
    heightPercent: parseOverlayPercent(
      env.RALPH_VIEW_HEIGHT_PERCENT ?? env.RALPH_VIEW_HEIGHT,
      DEFAULT_RALPH_VIEW_HEIGHT_PERCENT,
    ),
  };
}

/** Discover persisted ralph-loop results without constructing any UI components. */
export function discoverRalphLoopRuns(
	entries: any[],
	activeDetails: any | null,
	activeRunId: string | null,
): RalphLoopRun[] {
	const runs = new Map<string, RalphLoopRun>();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = entry?.type === "message" ? entry.message : undefined;
		if (message?.role !== "toolResult" || message.toolName !== "ralph_loop" || !message.details) continue;
		const runId = typeof message.details.runId === "string" && message.details.runId
			? message.details.runId
			: `legacy-${message.toolCallId || i}`;
		if (!runs.has(runId)) runs.set(runId, { runId, details: { ...message.details, runId }, active: false });
	}
	if (activeDetails) {
		const runId = activeRunId || activeDetails.runId;
		if (typeof runId === "string" && runId) {
			runs.set(runId, { runId, details: { ...activeDetails, runId }, active: Boolean(activeRunId) });
		}
	}
	const discoveredRuns = Array.from(runs.values());
	// Keep the active run as the default selection, regardless of where its
	// persisted snapshot appeared in the session history.
	return discoveredRuns.filter((run) => run.active).concat(discoveredRuns.filter((run) => !run.active));
}

export function formatRalphLoopRun(run: RalphLoopRun): string {
	const details = run.details ?? {};
	const status = run.active ? details.status || "running" : details.status || "completed";
	const iterations = Array.isArray(details.iterations) ? details.iterations.length : 0;
	return `${run.runId}${run.active ? " (active)" : ""} — ${status}, ${iterations} iteration${iterations === 1 ? "" : "s"}`;
}

/** Select a run before constructing the viewer. */
export async function selectRalphLoopRun(ctx: any, runs: RalphLoopRun[]): Promise<RalphLoopRun | null> {
	if (runs.length === 0) return null;
	const labels = runs.map(formatRalphLoopRun);
	if (typeof ctx?.ui?.select === "function") {
		const selected = await ctx.ui.select("Select a ralph-loop run", labels);
		const index = labels.indexOf(selected ?? "");
		return index >= 0 ? runs[index] : null;
	}
	if (typeof ctx?.ui?.custom !== "function") return null;
	return ctx.ui.custom((tui: any, _theme: any, _keybindings: any, done: (run: RalphLoopRun | null) => void) => {
		let selected = 0;
		const visibleCount = () => {
			const rows = Number(tui?.terminal?.rows);
			return Math.max(1, Math.min(runs.length, Number.isFinite(rows) && rows > 0 ? rows - 5 : 12));
		};
		const render = (width: number) => {
			const count = visibleCount();
			const start = Math.max(0, Math.min(selected - Math.floor(count / 2), runs.length - count));
			const end = Math.min(runs.length, start + count);
			const lines = ["Select a ralph-loop run", ""];
			if (start > 0) lines.push("↑ more above");
			for (let index = start; index < end; index++) {
				lines.push(`${index === selected ? "▸" : " "} ${labels[index]}`);
			}
			if (end < runs.length) lines.push("↓ more below");
			return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
		};
		return {
			render,
			invalidate: () => {},
			handleInput: (data: string) => {
				const count = visibleCount();
				if (matchesKey(data, "up")) selected = (selected - 1 + runs.length) % runs.length;
				else if (matchesKey(data, "down")) selected = (selected + 1) % runs.length;
				else if (matchesKey(data, "pageUp")) selected = Math.max(0, selected - count);
				else if (matchesKey(data, "pageDown")) selected = Math.min(runs.length - 1, selected + count);
				else if (matchesKey(data, "home")) selected = 0;
				else if (matchesKey(data, "end")) selected = runs.length - 1;
				else if (matchesKey(data, "enter") || data === "\n") return done(runs[selected]);
				else if (matchesKey(data, "escape") || data === "\x1b") return done(null);
				else return;
				tui?.requestRender?.();
			},
		};
	});
}

export function clampLoopViewerOffset(offset: number, totalLines: number, viewportLines: number): number {
	const maxOffset = Math.max(0, totalLines - Math.max(1, viewportLines));
	return Math.max(0, Math.min(Math.max(0, offset), maxOffset));
}

export function applyLoopViewerNavigation(
	offset: number,
	totalLines: number,
	viewportLines: number,
	action: LoopViewerAction,
): number {
	const page = Math.max(1, viewportLines);
	switch (action) {
		case "up": return clampLoopViewerOffset(offset - 1, totalLines, viewportLines);
		case "down": return clampLoopViewerOffset(offset + 1, totalLines, viewportLines);
		case "pageUp": return clampLoopViewerOffset(offset - page, totalLines, viewportLines);
		case "pageDown": return clampLoopViewerOffset(offset + page, totalLines, viewportLines);
		case "home": return 0;
		case "end": return clampLoopViewerOffset(Number.MAX_SAFE_INTEGER, totalLines, viewportLines);
	}
}

const MAX_TEXT_CHARS = 12_000;
const MAX_LINES_PER_TEXT = 240;

type ViewerBlock = StaticViewerBlock | TextViewerBlock;

interface StaticViewerBlock {
	kind: "static";
	text: string;
}

interface TextViewerBlock {
	kind: "text";
	prefix: string;
	text: string;
	lineCount: number;
	truncated: boolean;
	maxChars: number;
	maxLines: number;
	boundedText?: string;
	parts?: string[];
}

function safeText(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return "";
	try { return JSON.stringify(value); } catch { return String(value); }
}

function createTextBlock(
	prefix: string,
	value: unknown,
	limits: { maxChars: number; maxLines: number } = { maxChars: MAX_TEXT_CHARS, maxLines: MAX_LINES_PER_TEXT },
): TextViewerBlock | null {
	const text = safeText(value);
	if (!text) return null;
	const truncated = text.length > limits.maxChars;
	const scanEnd = Math.min(text.length, limits.maxChars);
	let visiblePartCount = 1;
	for (let i = 0; i < scanEnd; i++) {
		if (text.charCodeAt(i) === 10) visiblePartCount++;
	}
	const rawLineCount = visiblePartCount;
	visiblePartCount = Math.min(rawLineCount, limits.maxLines);
	const hasMarker = truncated || rawLineCount > visiblePartCount;
	return {
		kind: "text",
		prefix,
		text,
		lineCount: visiblePartCount + (hasMarker ? 1 : 0),
		truncated,
		maxChars: limits.maxChars,
		maxLines: limits.maxLines,
	};
}

function pushText(
	blocks: ViewerBlock[],
	prefix: string,
	value: unknown,
	limits?: { maxChars: number; maxLines: number },
): boolean {
	const block = createTextBlock(prefix, value, limits);
	if (!block) return false;
	blocks.push(block);
	return true;
}

function pushContent(
	blocks: ViewerBlock[],
	prefix: string,
	content: any,
	showThinking: boolean,
	limits?: { maxChars: number; maxLines: number },
): boolean {
	if (typeof content === "string") return pushText(blocks, prefix, content, limits);
	if (!Array.isArray(content) || content.length === 0) return false;
	let thinkingHidden = false;
	for (const part of content) {
		if (part?.type === "text") pushText(blocks, prefix, part.text, limits);
		else if (part?.type === "thinking") {
			if (showThinking) pushText(blocks, prefix, part.thinking, limits);
			else thinkingHidden = true;
		} else if (part?.type === "image") {
			blocks.push({ kind: "static", text: `${prefix}[image omitted]` });
		}
	}
	if (thinkingHidden) blocks.push({ kind: "static", text: `${prefix}Thinking...` });
	return thinkingHidden;
}

function formatArgs(args: unknown): string {
	const seen = new Set<object>();
	const format = (value: unknown, depth: number): string => {
		if (depth > 3) return "…";
		if (value === null || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
		if (typeof value === "string") {
			const bounded = value.length > 160 ? `${value.slice(0, 157)}...` : value;
			return JSON.stringify(bounded);
		}
		if (typeof value !== "object") return JSON.stringify(String(value));
		if (seen.has(value)) return "[Circular]";
		seen.add(value);
		try {
			if (Array.isArray(value)) {
				const items = value.slice(0, 20).map((item) => format(item, depth + 1));
				if (value.length > 20) items.push("…");
				return `[${items.join(", ")}]`;
			}
			const keys = Object.keys(value);
			const items = keys.slice(0, 20).map((key) => `${JSON.stringify(key)}: ${format((value as Record<string, unknown>)[key], depth + 1)}`);
			if (keys.length > 20) items.push("…");
			return `{${items.join(", ")}}`;
		} finally {
			seen.delete(value);
		}
	};
	try {
		const text = format(args ?? {}, 0);
		return text.length > 500 ? `${text.slice(0, 497)}...` : text;
	} catch {
		return "{}";
	}
}

/**
 * A virtual line source. It indexes bounded blocks, but only materializes the
 * requested viewport lines. This keeps large histories cheap while preserving
 * the original message data in the selected run details.
 */
export class RalphLoopViewerLineSource {
	private readonly offsets: number[] = [];
	readonly totalLines: number;

	constructor(private readonly blocks: ViewerBlock[]) {
		let offset = 0;
		for (const block of blocks) {
			this.offsets.push(offset);
			offset += block.kind === "static" ? 1 : block.lineCount;
		}
		this.totalLines = offset;
	}

	private blockLineCount(block: ViewerBlock): number {
		return block.kind === "static" ? 1 : block.lineCount;
	}

	private lineFromBlock(block: ViewerBlock, index: number): string {
		if (block.kind === "static") return block.text;
		if (!block.parts) {
			block.boundedText = block.truncated ? block.text.slice(0, block.maxChars) : block.text;
			block.parts = block.boundedText.split("\n").slice(0, block.maxLines);
		}
		if (index < block.parts.length) return `${block.prefix}${block.parts[index]}`;
		return `${block.prefix}[… output shortened in viewer; original result is retained …]`;
	}

	getLines(start: number, end: number): string[] {
		if (start >= end || this.blocks.length === 0) return [];
		const first = Math.max(0, start);
		const last = Math.min(this.totalLines, end);
		if (first >= last) return [];
		let blockIndex = 0;
		while (blockIndex + 1 < this.offsets.length && this.offsets[blockIndex + 1] <= first) blockIndex++;
		const lines: string[] = [];
		for (; blockIndex < this.blocks.length && lines.length < last - first; blockIndex++) {
			const block = this.blocks[blockIndex];
			const blockStart = this.offsets[blockIndex];
			const blockEnd = blockStart + this.blockLineCount(block);
			const from = Math.max(first, blockStart);
			const to = Math.min(last, blockEnd);
			for (let line = from; line < to; line++) lines.push(this.lineFromBlock(block, line - blockStart));
		}
		return lines;
	}
}

function addLine(blocks: ViewerBlock[], text: string): void {
	blocks.push({ kind: "static", text });
}

/** Build a bounded, lazy line source without constructing rich TUI components. */
export function buildLoopViewerLineSource(
	details: any,
	showThinking = false,
	outputMode: OutputDisplayMode = "full",
): RalphLoopViewerLineSource {
	const blocks: ViewerBlock[] = [];
	addLine(blocks, `Status: ${details?.status || "unknown"}`);
	addLine(blocks, `Stop: ${details?.stopReason || "(running)"}`);
	addLine(blocks, `Condition: ${details?.conditionCommand || "(none)"}`);
	if (details?.conditionTimeoutMs) addLine(blocks, `Condition timeout: ${details.conditionTimeoutMs}ms`);
	const iterations = Array.isArray(details?.iterations) ? details.iterations : [];
	addLine(blocks, `Iterations: ${iterations.length}`);
	const completion = details?.stopOnCompletion
		? `${details.completionStreak ?? 0}/${details.completionConfirmations ?? 3}`
		: "disabled";
	addLine(blocks, `Completion confirmations: ${completion}`);
	if (details?.handoffMode && details.handoffMode !== "none") addLine(blocks, `Handoff: ${details.handoffMode}`);
	if (Array.isArray(details?.artifactPaths)) {
		for (const artifactPath of details.artifactPaths) addLine(blocks, `Artifact: ${artifactPath}`);
	}

	if (iterations.length === 0) addLine(blocks, "(no iterations yet)");
	for (const iteration of iterations) {
		addLine(blocks, `Iteration ${iteration.index} (${iteration.details?.mode || "single"})`);
		const results = Array.isArray(iteration?.details?.results) ? iteration.details.results : [];
		for (const result of results) {
			const status = result.exitCode === 0 ? "✓" : "✗";
			addLine(blocks, `${status} ${result.agent || "(unknown agent)"} (${result.agentSource || "unknown"})`);
			if (result.task) pushText(blocks, "  Task: ", result.task);
			if (result.errorMessage) pushText(blocks, "  Error: ", result.errorMessage);
			const messages = Array.isArray(result?.messages) ? result.messages : [];
			for (const message of messages) {
				if (message?.role === "user") {
					pushContent(blocks, "  User: ", message.content, showThinking);
					continue;
				}
				if (message?.role === "assistant") {
					let thinkingHidden = false;
					for (const part of message.content || []) {
						if (part?.type === "thinking") {
							if (showThinking) pushText(blocks, "  Thinking: ", part.thinking);
							else thinkingHidden = true;
						} else if (part?.type === "text") {
							pushText(blocks, "  Assistant: ", part.text);
						} else if (part?.type === "toolCall") {
							addLine(blocks, `  Tool call: ${part.name || "(unknown)"} ${formatArgs(part.arguments)}`);
						}
					}
					if (thinkingHidden) addLine(blocks, "  Thinking...");
					continue;
				}
				if (message?.role === "toolResult") {
					addLine(blocks, `  Tool result: ${message.toolName || "(unknown)"}${message.isError ? " [error]" : ""}`);
					if (outputMode !== "simple") {
						const limits = outputMode === "collapsed" ? { maxChars: 2_000, maxLines: 20 } : undefined;
						pushContent(blocks, "    ", message.content, showThinking, limits);
					}
				}
			}
			if (messages.length === 0) addLine(blocks, "  (no messages)");
		}
	}

	if (details?.steering?.length || details?.followUps?.length || details?.steeringSent?.length || details?.followUpsSent?.length) {
		addLine(blocks, "Queued messages");
		for (const [label, values] of [
			["Steering queued", details.steering],
			["Follow-ups queued", details.followUps],
			["Steering sent", details.steeringSent],
			["Follow-ups sent", details.followUpsSent],
		] as const) {
			if (values?.length) pushText(blocks, `  ${label}: `, values.join(" | "));
		}
	}
	return new RalphLoopViewerLineSource(blocks);
}

/** Compatibility/test helper that materializes the source on request. */
export function buildLoopViewerLines(
	details: any,
	showThinking = false,
	outputMode: OutputDisplayMode = "full",
): string[] {
	const source = buildLoopViewerLineSource(details, showThinking, outputMode);
	return source.getLines(0, source.totalLines);
}

function color(theme: any, name: string, text: string): string {
	return typeof theme?.fg === "function" ? theme.fg(name, text) : text;
}

/**
 * Resolve the same built-in tool definitions used by pi's interactive mode.
 *
 * Newer pi releases no longer make ToolExecutionComponent discover built-in
 * renderers implicitly, so passing an explicit definition is required for the
 * native call/result renderers (and their collapsed previews) to run.
 */
export function getNativeToolDefinition(toolName: string, cwd: string): any | undefined {
	try {
		switch (toolName) {
			case "bash": return createBashToolDefinition(cwd);
			case "edit": return createEditToolDefinition(cwd);
			case "find": return createFindToolDefinition(cwd);
			case "grep": return createGrepToolDefinition(cwd);
			case "ls": return createLsToolDefinition(cwd);
			case "read": return createReadToolDefinition(cwd);
			case "write": return createWriteToolDefinition(cwd);
			default: return undefined;
		}
	} catch {
		return undefined;
	}
}

function renderNativeComponent(component: any, width: number): string[] {
	try {
		return component.render(width);
	} catch {
		return [];
	}
}

function appendNativeComponent(lines: string[], component: any, width: number): boolean {
	const rendered = renderNativeComponent(component, width);
	if (rendered.length === 0) return false;
	// Native Pi components already own their internal spacing. Do not append an
	// additional separator between adjacent sections.
	lines.push(...rendered);
	return true;
}

/**
 * Put viewer controls on the left and scroll position on the right.
 * Both sides may wrap, but remain in the same compact footer area.
 */
export function buildViewerFooterRows(left: string, right: string, width: number): string[] {
	const availableWidth = Math.max(1, Math.floor(width));
	if (availableWidth <= 2) return wrapTextWithAnsi(`${left} ${right}`, availableWidth);

	const gap = 1;
	const measuredRight = Math.max(1, visibleWidth(right));
	const rightWidth = Math.min(measuredRight, Math.max(1, Math.floor((availableWidth - gap) * 0.45)));
	const leftWidth = Math.max(1, availableWidth - gap - rightWidth);
	const leftLines = wrapTextWithAnsi(left, leftWidth);
	const rightLines = wrapTextWithAnsi(right, rightWidth);
	const rowCount = Math.max(leftLines.length, rightLines.length, 1);
	const rows: string[] = [];

	for (let index = 0; index < rowCount; index++) {
		const leftLine = leftLines[index] ?? "";
		const rightLine = rightLines[index] ?? "";
		const leftPadding = " ".repeat(Math.max(0, leftWidth - visibleWidth(leftLine)));
		const rightPadding = " ".repeat(Math.max(0, rightWidth - visibleWidth(rightLine)));
		rows.push(`${leftLine}${leftPadding}${" ".repeat(gap)}${rightPadding}${rightLine}`);
	}
	return rows;
}

/** Flatten a native component into one bounded visual line for simple mode. */
export function compactRenderedLines(lines: string[], width: number): string {
	const compact = lines
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter(Boolean)
		.join(" ");
	return truncateToWidth(compact, Math.max(1, width));
}

function appendSimpleNativeComponent(lines: string[], component: any, width: number): boolean {
	const rendered = renderNativeComponent(component, width);
	if (rendered.length === 0) return false;
	const compact = compactRenderedLines(rendered, Math.max(1, width - 2));
	if (!compact) return false;
	lines.push(compact);
	return true;
}

function messageText(message: any): string {
	return Array.isArray(message?.content)
		? message.content
				.filter((part: any) => part?.type === "text" && typeof part.text === "string")
				.map((part: any) => part.text)
				.join("\n")
				.trim()
		: safeText(message?.content).trim();
}

export function renderNativeIteration(
	iteration: any,
	width: number,
	showThinking: boolean,
	outputMode: OutputDisplayMode,
	tui: any,
	cwd: string,
	theme: any,
): string[] {
	const lines: string[] = [];
	const details = iteration?.details;
	const results = Array.isArray(details?.results) ? details.results : [];
	lines.push(color(theme, "accent", `Iteration ${iteration?.index ?? "?"} (${details?.mode || "single"})`));

	for (const result of results) {
		const statusIcon = result?.exitCode === 0 ? "✓" : "✗";
		lines.push(`${statusIcon} ${result?.agent || "(unknown agent)"} (${result?.agentSource || "unknown"})`);
		if (result?.task) lines.push(`Task: ${result.task}`);
		if (result?.errorMessage) lines.push(`Error: ${result.errorMessage}`);

		const toolResults = new Map<string, any>();
		const toolCalls = new Set<string>();
		for (const message of Array.isArray(result?.messages) ? result.messages : []) {
			if (message?.role === "assistant") {
				for (const part of message.content || []) {
					if (part?.type === "toolCall" && part.id) toolCalls.add(part.id);
				}
			} else if (message?.role === "toolResult" && message.toolCallId) {
				toolResults.set(message.toolCallId, message);
			}
		}

		for (const message of Array.isArray(result?.messages) ? result.messages : []) {
			if (message?.role === "user") {
				const text = messageText(message);
				if (text) {
					try {
						if (!appendNativeComponent(lines, new UserMessageComponent(text), width)) throw new Error("user renderer unavailable");
					} catch {
						lines.push(`User: ${text}`);
					}
				}
				continue;
			}
			if (message?.role === "assistant") {
				try {
					if (!appendNativeComponent(lines, new AssistantMessageComponent(message, !showThinking, getMarkdownTheme()), width)) {
						throw new Error("assistant renderer unavailable");
					}
				} catch {
					let thinkingHidden = false;
					for (const part of message.content || []) {
						if (part?.type === "text" && typeof part.text === "string") lines.push(`Assistant: ${part.text}`);
						if (part?.type === "thinking" && !showThinking) thinkingHidden = true;
						if (part?.type === "thinking" && showThinking && typeof part.thinking === "string") lines.push(`Thinking: ${part.thinking}`);
					}
					if (thinkingHidden) lines.push("Thinking...");
				}
				for (const part of message.content || []) {
					if (part?.type !== "toolCall") continue;
					const toolResult = toolResults.get(part.id);
					try {
						const tool = new ToolExecutionComponent(
							part.name || toolResult?.toolName || "",
							part.id || "",
							part.arguments ?? {},
							{ showImages: false },
							getNativeToolDefinition(part.name || toolResult?.toolName || "", cwd),
							tui ?? { requestRender: () => {} },
							cwd,
						);
						if (outputMode === "simple") {
							if (!appendSimpleNativeComponent(lines, tool, width)) throw new Error("tool renderer unavailable");
						} else {
							tool.updateResult(
								toolResult ?? { content: [], details: undefined, isError: false },
								!toolResult || Boolean(toolResult.isPartial),
							);
							tool.setExpanded(outputMode === "full");
							if (!appendNativeComponent(lines, tool, width)) throw new Error("tool renderer unavailable");
						}
					} catch {
						lines.push(`Tool: ${part.name || "(unknown)"} ${formatArgs(part.arguments)}`);
					}
				}
				continue;
			}
			if (message?.role === "toolResult" && (!message.toolCallId || !toolCalls.has(message.toolCallId))) {
				try {
					const tool = new ToolExecutionComponent(
						message.toolName || "",
						message.toolCallId || "",
						{},
						{ showImages: false },
						getNativeToolDefinition(message.toolName || "", cwd),
						tui ?? { requestRender: () => {} },
						cwd,
					);
					if (outputMode === "simple") {
						if (!appendSimpleNativeComponent(lines, tool, width)) throw new Error("tool renderer unavailable");
					} else {
						tool.updateResult(message, Boolean(message.isPartial));
						tool.setExpanded(outputMode === "full");
						if (!appendNativeComponent(lines, tool, width)) throw new Error("tool renderer unavailable");
					}
				} catch {
					lines.push(`Tool result: ${message.toolName || "(unknown)"}`);
				}
			}
		}
		if (Array.isArray(result?.messages) && result.messages.length === 0) lines.push("(no messages)");
	}
	return lines;
}

export class RalphLoopViewer implements Component {
	private offset = 0;
	private followTail = true;
	private hasRendered = false;
	private lastTotalLines = 0;
	private showThinking = false;
	private outputMode: OutputDisplayMode = "collapsed";
	private cachedDetails: any = undefined;
	private cachedWidth = 0;
	private cachedNativeLines: string[] | undefined;
	private cachedShowThinking = false;
	private cachedOutputMode: OutputDisplayMode = "collapsed";
	private readonly iterationLineCache = new WeakMap<object, Map<string, string[]>>();

	constructor(
		private readonly run: RalphLoopRun,
		private readonly getDetails: () => any,
		private readonly tui: any,
		private readonly theme: any,
		private readonly done: (result: null) => void,
		private readonly cwd = process.cwd(),
		private readonly heightPercent = DEFAULT_RALPH_VIEW_HEIGHT_PERCENT,
	) {}

	private overlayRows(): number {
		const rows = Number(this.tui?.terminal?.rows);
		const terminalRows = Number.isFinite(rows) && rows > 0 ? rows : 24;
		return Math.max(1, Math.floor((terminalRows * this.heightPercent) / 100));
	}

	private viewportLines(_width = this.cachedWidth || Number(this.tui?.terminal?.columns) || 80): number {
		// The exact footer height is resolved during render because it may wrap.
		// Reserve a conservative amount here for auto-scroll calculations.
		return Math.max(1, this.overlayRows() - 6);
	}

	private maxOffset(totalLines: number, width = this.cachedWidth || Number(this.tui?.terminal?.columns) || 80): number {
		return Math.max(0, totalLines - this.viewportLines(width));
	}

	private renderIteration(iteration: any, width: number): string[] {
		if (!iteration || typeof iteration !== "object") return [];
		const key = `${width}:${this.showThinking ? "thinking" : "hidden"}:${this.outputMode}`;
		let cached = this.iterationLineCache.get(iteration);
		if (!cached) {
			cached = new Map();
			this.iterationLineCache.set(iteration, cached);
		}
		const existing = cached.get(key);
		if (existing) return existing;
		const lines = renderNativeIteration(iteration, width, this.showThinking, this.outputMode, this.tui, this.cwd, this.theme);
		cached.set(key, lines);
		return lines;
	}

	private renderedLines(details: any, width: number): string[] {
		if (
			details === this.cachedDetails &&
			width === this.cachedWidth &&
			this.showThinking === this.cachedShowThinking &&
			this.outputMode === this.cachedOutputMode &&
			this.cachedNativeLines
		) {
			return this.cachedNativeLines;
		}

		const previousTotal = this.lastTotalLines;
		const lines: string[] = [];
		const addMeta = (text: string, colorName = "muted") => lines.push(color(this.theme, colorName, text));
		addMeta(`Status: ${details?.status || "unknown"}`, "dim");
		addMeta(`Stop: ${details?.stopReason || "(running)"}`, "dim");
		addMeta(`Condition: ${details?.conditionCommand || "(none)"}`, "dim");
		if (details?.conditionTimeoutMs) addMeta(`Condition timeout: ${details.conditionTimeoutMs}ms`, "dim");
		const iterations = Array.isArray(details?.iterations) ? details.iterations : [];
		addMeta(`Iterations: ${iterations.length}`, "dim");
		if (details?.stopOnCompletion) {
			addMeta(
				`Completion confirmations: ${details.completionStreak ?? 0}/${details.completionConfirmations ?? 3}`,
				"dim",
			);
		}
		if (details?.handoffMode && details.handoffMode !== "none") addMeta(`Handoff: ${details.handoffMode}`, "dim");
		if (Array.isArray(details?.artifactPaths)) {
			for (const artifactPath of details.artifactPaths) addMeta(`Artifact: ${artifactPath}`, "dim");
		}
		if (iterations.length === 0) addMeta("(no iterations yet)");
		for (const iteration of iterations) lines.push(...this.renderIteration(iteration, width));
		if (details?.steering?.length || details?.followUps?.length || details?.steeringSent?.length || details?.followUpsSent?.length) {
			addMeta("Queued messages", "accent");
			for (const [label, values] of [
				["Steering queued", details.steering],
				["Follow-ups queued", details.followUps],
				["Steering sent", details.steeringSent],
				["Follow-ups sent", details.followUpsSent],
			] as const) {
				if (values?.length) addMeta(`  ${label}: ${values.join(" | ")}`);
			}
		}

		this.cachedDetails = details;
		this.cachedWidth = width;
		this.cachedShowThinking = this.showThinking;
		this.cachedOutputMode = this.outputMode;
		this.cachedNativeLines = lines;
		this.lastTotalLines = lines.length;
		const maxOffset = this.maxOffset(lines.length, width);
		if (!this.hasRendered || this.followTail) {
			this.offset = maxOffset;
		} else if (lines.length !== previousTotal) {
			this.offset = clampLoopViewerOffset(this.offset, lines.length, this.viewportLines(width));
		} else {
			this.offset = clampLoopViewerOffset(this.offset, lines.length, this.viewportLines(width));
		}
		return lines;
	}

	private frameLine(line: string, innerWidth: number): string {
		// Do not add a second ellipsis at the frame edge. Native tool renderers
		// remain responsible for their own truncation indicators.
		const text = truncateToWidth(line, innerWidth, "");
		const padding = Math.max(0, innerWidth - visibleWidth(text));
		return `${color(this.theme, "border", "│")}${text}${" ".repeat(padding)}${color(this.theme, "border", "│")}`;
	}

	invalidate(): void {
		this.cachedDetails = undefined;
		this.cachedNativeLines = undefined;
	}

	dispose(): void {
		this.cachedNativeLines = undefined;
		this.cachedDetails = undefined;
	}

	render(width: number): string[] {
		const details = this.getDetails() || this.run.details;
		const lines = this.renderedLines(details, width);
		const innerWidth = Math.max(1, width - 2);
		const header = truncateToWidth(
			color(this.theme, "accent", `Ralph Loop ${this.run.runId} · ${details?.status || "unknown"} · ${this.outputMode}`),
			innerWidth,
			"",
		);
		const controls = color(
			this.theme,
			"dim",
			`↑↓ PgUp/Dn Home/End · Ctrl+O ${this.outputMode} · Ctrl+T ${this.showThinking ? "visible" : "hidden"} · auto:${this.followTail ? "on" : "paused"} · Esc`,
		);
		const overlayRows = this.overlayRows();
		const maxBodyRows = Math.max(1, overlayRows - 2);
		const maxFooterRows = Math.max(1, maxBodyRows - 1);
		let viewport = this.viewportLines(width);
		let offset = clampLoopViewerOffset(this.offset, lines.length, viewport);
		let end = Math.min(lines.length, offset + viewport);
		let position = lines.length === 0 ? "0/0" : `${offset + 1}-${end}/${lines.length}`;
		let above = offset > 0 ? "↑ more above" : "";
		let below = end < lines.length ? "↓ more below" : "";
		let scrollInfo = color(
			this.theme,
			"muted",
			`${position}${above || below ? ` · ${[above, below].filter(Boolean).join(" · ")}` : ""}`,
		);
		let footer = buildViewerFooterRows(controls, scrollInfo, innerWidth).slice(0, maxFooterRows);
		const availableContentRows = Math.max(0, maxBodyRows - 1 - footer.length);
		if (availableContentRows !== viewport) {
			viewport = availableContentRows;
			offset = this.followTail
				? Math.max(0, lines.length - viewport)
				: clampLoopViewerOffset(offset, lines.length, viewport);
			this.offset = offset;
			end = Math.min(lines.length, offset + viewport);
			position = lines.length === 0 ? "0/0" : `${offset + 1}-${end}/${lines.length}`;
			above = offset > 0 ? "↑ more above" : "";
			below = end < lines.length ? "↓ more below" : "";
			scrollInfo = color(
				this.theme,
				"muted",
				`${position}${above || below ? ` · ${[above, below].filter(Boolean).join(" · ")}` : ""}`,
			);
			footer = buildViewerFooterRows(controls, scrollInfo, innerWidth).slice(0, maxFooterRows);
		} else {
			this.offset = offset;
		}
		const body = [header, ...lines.slice(offset, end), ...footer];
		const top = color(this.theme, "borderAccent", `╭${"─".repeat(innerWidth)}╮`);
		const bottom = color(this.theme, "borderAccent", `╰${"─".repeat(innerWidth)}╯`);
		this.hasRendered = true;
		return [top, ...body.map((line) => this.frameLine(line, innerWidth)), bottom];
	}

	handleInput(data: string): void {
		const details = this.getDetails() || this.run.details;
		const inputWidth = this.cachedWidth || Number(this.tui?.terminal?.columns) || 80;
		const lines = this.renderedLines(details, inputWidth);
		const viewport = this.viewportLines(inputWidth);
		let action: LoopViewerAction | undefined;
		if (matchesKey(data, "up")) action = "up";
		else if (matchesKey(data, "down")) action = "down";
		else if (matchesKey(data, "pageUp")) action = "pageUp";
		else if (matchesKey(data, "pageDown")) action = "pageDown";
		else if (matchesKey(data, "home")) action = "home";
		else if (matchesKey(data, "end")) action = "end";
		else if (matchesKey(data, "ctrl+o") || data === "\x0f") {
			this.outputMode = this.outputMode === "collapsed"
				? "simple"
				: this.outputMode === "simple"
					? "full"
					: "collapsed";
			this.cachedDetails = undefined;
			this.cachedNativeLines = undefined;
			this.tui?.requestRender?.();
			return;
		} else if (matchesKey(data, "ctrl+t") || data === "\x14") {
			this.showThinking = !this.showThinking;
			this.cachedDetails = undefined;
			this.cachedNativeLines = undefined;
			this.tui?.requestRender?.();
			return;
		} else if (matchesKey(data, "escape") || data === "\x1b") {
			this.done(null);
			return;
		}
		if (!action) return;
		const previousOffset = this.offset;
		this.offset = applyLoopViewerNavigation(this.offset, lines.length, viewport, action);
		const maxOffset = this.maxOffset(lines.length, inputWidth);
		if (action === "end" || this.offset >= maxOffset) this.followTail = true;
		else if (this.offset < previousOffset || action === "home" || action === "pageUp" || action === "up") this.followTail = false;
		this.tui?.requestRender?.();
	}
}
