/** Lightweight, overlay-only UI for browsing ralph-loop history. */

import { matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";

export interface RalphLoopRun {
	runId: string;
	details: any;
	active: boolean;
}

export type LoopViewerAction = "up" | "down" | "pageUp" | "pageDown" | "home" | "end";

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
	return Array.from(runs.values());
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
	boundedText?: string;
	parts?: string[];
}

function safeText(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return "";
	try { return JSON.stringify(value); } catch { return String(value); }
}

function createTextBlock(prefix: string, value: unknown): TextViewerBlock | null {
	const text = safeText(value);
	if (!text) return null;
	const truncated = text.length > MAX_TEXT_CHARS;
	const scanEnd = Math.min(text.length, MAX_TEXT_CHARS);
	let visiblePartCount = 1;
	for (let i = 0; i < scanEnd; i++) {
		if (text.charCodeAt(i) === 10) visiblePartCount++;
	}
	const rawLineCount = visiblePartCount;
	visiblePartCount = Math.min(rawLineCount, MAX_LINES_PER_TEXT);
	const hasMarker = truncated || rawLineCount > visiblePartCount;
	return {
		kind: "text",
		prefix,
		text,
		lineCount: visiblePartCount + (hasMarker ? 1 : 0),
		truncated,
	};
}

function pushText(blocks: ViewerBlock[], prefix: string, value: unknown): boolean {
	const block = createTextBlock(prefix, value);
	if (!block) return false;
	blocks.push(block);
	return true;
}

function pushContent(blocks: ViewerBlock[], prefix: string, content: any, showThinking: boolean): boolean {
	if (typeof content === "string") return pushText(blocks, prefix, content);
	if (!Array.isArray(content) || content.length === 0) return false;
	let thinkingHidden = false;
	for (const part of content) {
		if (part?.type === "text") pushText(blocks, prefix, part.text);
		else if (part?.type === "thinking") {
			if (showThinking) pushText(blocks, prefix, part.thinking);
			else thinkingHidden = true;
		} else if (part?.type === "image") {
			blocks.push({ kind: "static", text: `${prefix}[image omitted]` });
		}
	}
	if (thinkingHidden) blocks.push({ kind: "static", text: `${prefix}[Thinking hidden — Ctrl+T to show]` });
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
			block.boundedText = block.truncated ? block.text.slice(0, MAX_TEXT_CHARS) : block.text;
			block.parts = block.boundedText.split("\n").slice(0, MAX_LINES_PER_TEXT);
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
export function buildLoopViewerLineSource(details: any, showThinking = false): RalphLoopViewerLineSource {
	const blocks: ViewerBlock[] = [];
	addLine(blocks, `Status: ${details?.status || "unknown"}`);
	addLine(blocks, `Stop: ${details?.stopReason || "(running)"}`);
	addLine(blocks, `Condition: ${details?.conditionCommand || "(none)"}`);
	if (details?.conditionTimeoutMs) addLine(blocks, `Condition timeout: ${details.conditionTimeoutMs}ms`);
	const iterations = Array.isArray(details?.iterations) ? details.iterations : [];
	addLine(blocks, `Iterations: ${iterations.length}`);

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
					if (thinkingHidden) addLine(blocks, "  [Thinking hidden — Ctrl+T to show]");
					continue;
				}
				if (message?.role === "toolResult") {
					addLine(blocks, `  Tool result: ${message.toolName || "(unknown)"}${message.isError ? " [error]" : ""}`);
					pushContent(blocks, "    ", message.content, showThinking);
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
export function buildLoopViewerLines(details: any, showThinking = false): string[] {
	const source = buildLoopViewerLineSource(details, showThinking);
	return source.getLines(0, source.totalLines);
}

function color(theme: any, name: string, text: string): string {
	return typeof theme?.fg === "function" ? theme.fg(name, text) : text;
}

export class RalphLoopViewer implements Component {
	private offset = 0;
	private showThinking = false;
	private cachedDetails: any = undefined;
	private cachedSource: RalphLoopViewerLineSource | undefined;

	constructor(
		private readonly run: RalphLoopRun,
		private readonly getDetails: () => any,
		private readonly tui: any,
		private readonly theme: any,
		private readonly done: (result: null) => void,
	) {}

	private viewportLines(): number {
		const rows = Number(this.tui?.terminal?.rows);
		return Math.max(1, Math.min(24, Number.isFinite(rows) && rows > 0 ? rows - 5 : 19));
	}

	private source(): RalphLoopViewerLineSource {
		const details = this.getDetails() || this.run.details;
		if (details !== this.cachedDetails || !this.cachedSource) {
			this.cachedDetails = details;
			this.cachedSource = buildLoopViewerLineSource(details, this.showThinking);
			this.offset = clampLoopViewerOffset(this.offset, this.cachedSource.totalLines, this.viewportLines());
		}
		return this.cachedSource;
	}

	invalidate(): void {
		this.cachedDetails = undefined;
		this.cachedSource = undefined;
	}

	dispose(): void {
		this.cachedSource = undefined;
	}

	render(width: number): string[] {
		const source = this.source();
		const viewport = this.viewportLines();
		this.offset = clampLoopViewerOffset(this.offset, source.totalLines, viewport);
		const end = Math.min(source.totalLines, this.offset + viewport);
		const position = source.totalLines === 0 ? "0/0" : `${this.offset + 1}-${end}/${source.totalLines}`;
		const details = this.getDetails() || this.run.details;
		const contentWidth = Math.max(1, width - 2);
		const header = truncateToWidth(color(this.theme, "accent", `Ralph Loop ${this.run.runId} · ${details?.status || "unknown"}`), contentWidth);
		const controls = truncateToWidth(color(this.theme, "dim", `↑↓/PgUp PgDn · Home/End · Ctrl+T thinking:${this.showThinking ? "on" : "off"} · Esc close`), contentWidth);
		const body = source.getLines(this.offset, end).map((line) => truncateToWidth(line, contentWidth));
		const above = this.offset > 0 ? "↑ more above" : "";
		const below = end < source.totalLines ? "↓ more below" : "";
		const footer = truncateToWidth(color(this.theme, "muted", `${position}${above || below ? ` · ${[above, below].filter(Boolean).join(" · ")}` : ""}`), contentWidth);
		return [header, controls, ...body, footer];
	}

	handleInput(data: string): void {
		const source = this.source();
		const viewport = this.viewportLines();
		let action: LoopViewerAction | undefined;
		if (matchesKey(data, "up")) action = "up";
		else if (matchesKey(data, "down")) action = "down";
		else if (matchesKey(data, "pageUp")) action = "pageUp";
		else if (matchesKey(data, "pageDown")) action = "pageDown";
		else if (matchesKey(data, "home")) action = "home";
		else if (matchesKey(data, "end")) action = "end";
		else if (matchesKey(data, "ctrl+t") || data === "\x14") {
			this.showThinking = !this.showThinking;
			this.cachedSource = undefined;
			const nextSource = this.source();
			this.offset = clampLoopViewerOffset(this.offset, nextSource.totalLines, viewport);
			this.tui?.requestRender?.();
			return;
		} else if (matchesKey(data, "escape") || data === "\x1b") {
			this.done(null);
			return;
		}
		if (action) {
			this.offset = applyLoopViewerNavigation(this.offset, source.totalLines, viewport, action);
			this.tui?.requestRender?.();
		}
	}
}
