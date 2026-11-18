/**
 * Pure helpers for the repeat extension.
 *
 * Kept separate from the TUI glue in `repeat.ts` so they can be unit tested
 * without a pi runtime. Nothing here touches the filesystem or spawns editors.
 */

import * as path from "node:path";
import { decodeKittyPrintable } from "@earendil-works/pi-tui";

export type RepeatToolName = "bash" | "edit" | "write";

export interface RepeatToolCall {
	toolName: RepeatToolName;
	args: Record<string, any>;
	toolCallId: string;
	timestamp: string;
	resultDetails?: any;
	resultIsError?: boolean;
}

export function extractText(content: any): string {
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

export function truncatePreview(text: string, max: number): string {
	const cleaned = text.replace(/\s+/g, " ").trim();
	if (cleaned.length <= max) return cleaned;
	return `${cleaned.slice(0, Math.max(0, max - 3))}...`;
}

export function getSearchInputCharacter(data: string): string | undefined {
	const decoded = decodeKittyPrintable(data);
	if (decoded) return decoded;
	if (data.length !== 1) return undefined;

	const code = data.charCodeAt(0);
	if (code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return undefined;
	return data;
}

export function getExternalEditor(env: NodeJS.ProcessEnv = process.env): string | null {
	const editor = env.VISUAL || env.EDITOR;
	return editor && editor.trim() ? editor.trim() : null;
}

/** Split an editor command line, honouring single and double quotes. */
export function splitCommand(command: string): string[] {
	const trimmed = command.trim();
	if (!trimmed) return [];
	const parts: string[] = [];
	let current = "";
	let quote: "\"" | "'" | null = null;

	for (let i = 0; i < trimmed.length; i++) {
		const char = trimmed[i];
		if (quote) {
			if (char === quote) {
				quote = null;
			} else {
				current += char;
			}
			continue;
		}
		if (char === "\"" || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				parts.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current) parts.push(current);
	return parts.length > 0 ? parts : command.split(" ");
}

export function buildEditorInvocation(
	editorCommand: string,
	filePath: string,
	line?: number,
): { command: string; args: string[] } {
	const parts = splitCommand(editorCommand);
	const command = parts[0] || editorCommand;
	const args = parts.slice(1);
	const base = path.basename(command).toLowerCase();
	const terminalEditors = ["vim", "nvim", "vi", "nano", "emacs", "emacsclient", "less", "more"];

	if (line && line > 0) {
		if (terminalEditors.includes(base)) {
			return { command, args: [...args, `+${line}`, filePath] };
		}
		const colonTarget = `${filePath}:${line}`;
		if (base === "open") {
			return { command, args: [...args, "--args", colonTarget] };
		}
		return { command, args: [...args, colonTarget] };
	}

	return { command, args: [...args, filePath] };
}

export function resolvePath(cwd: string, targetPath: string): string {
	if (path.isAbsolute(targetPath)) return targetPath;
	return path.join(cwd, targetPath);
}

/** Apply a single unique text replacement to in-memory content. */
export function applyEditOnce(
	content: string,
	oldText: string,
	newText: string,
): { content: string } | { error: string } {
	if (!oldText) return { error: "oldText is empty" };
	const index = content.indexOf(oldText);
	if (index === -1) return { error: "oldText not found" };
	const nextIndex = content.indexOf(oldText, index + oldText.length);
	if (nextIndex !== -1) return { error: "oldText is not unique" };
	const updated = content.slice(0, index) + newText + content.slice(index + oldText.length);
	return { content: updated };
}

/**
 * Collect repeatable tool calls from session branch entries, in conversation
 * order. Tool results are attached by `toolCallId` when present.
 */
export function collectRepeatCalls(entries: any[]): RepeatToolCall[] {
	const toolResults = new Map<string, { details?: any; isError?: boolean }>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role === "toolResult" && message.toolCallId) {
			toolResults.set(message.toolCallId, { details: message.details, isError: message.isError });
		}
	}

	const calls: RepeatToolCall[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role !== "assistant") continue;
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part?.type !== "toolCall") continue;
			const name = part.name as RepeatToolName;
			if (name !== "bash" && name !== "edit" && name !== "write") continue;
			const result = toolResults.get(part.id);
			calls.push({
				toolName: name,
				args: part.arguments ?? {},
				toolCallId: part.id,
				timestamp: entry.timestamp,
				resultDetails: result?.details,
				resultIsError: result?.isError,
			});
		}
	}

	return calls;
}

export function getRepeatLabel(entry: RepeatToolCall): { label: string; description?: string } {
	if (entry.toolName === "bash") {
		const command = String(entry.args?.command ?? "");
		return {
			label: `bash: ${truncatePreview(command || "(empty)", 60)}`,
			description: entry.args?.timeout ? `timeout: ${entry.args.timeout}s` : undefined,
		};
	}
	if (entry.toolName === "edit") {
		const targetPath = String(entry.args?.path ?? "");
		const details = entry.resultDetails as { firstChangedLine?: number } | undefined;
		const line = details?.firstChangedLine ? `line ${details.firstChangedLine}` : "line ?";
		const preview = truncatePreview(String(entry.args?.oldText ?? ""), 40);
		return {
			label: `edit: ${targetPath || "(unknown)"}`,
			description: preview ? `${line} • ${preview}` : line,
		};
	}
	const targetPath = String(entry.args?.path ?? "");
	const bytes = typeof entry.args?.content === "string" ? entry.args.content.length : 0;
	return {
		label: `write: ${targetPath || "(unknown)"}`,
		description: `${bytes} bytes`,
	};
}
