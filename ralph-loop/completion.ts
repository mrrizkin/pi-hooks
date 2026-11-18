/**
 * Completion signalling and iteration-context helpers for the ralph loop.
 *
 * Pure functions: no pi runtime, process, or filesystem access.
 */

import {
	COMPLETION_MARKER,
	HANDOFF_END_MARKER,
	HANDOFF_START_MARKER,
} from "./loop-constants.js";

export type HandoffMode = "none" | "summary" | "artifact";

export const DEFAULT_HANDOFF_MODE: HandoffMode = "summary";

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

function getHandoffField(handoff: string, field: string): string | null {
	const match = handoff.match(new RegExp(`^\\s*${field}\\s*:\\s*(.+)$`, "im"));
	return match?.[1]?.trim() || null;
}

function isEmptyHandoffValue(value: string): boolean {
	return /^(?:none|no(?:ne)?|nil|n\/?a|not applicable|nothing|no further action|no outstanding(?: questions?)?|no open questions?|[-—])[\s.!]*$/i.test(value.trim());
}

export function isCompletionClaimValid(text: string, handoffMode: HandoffMode): boolean {
	if (!hasCompletionMarker(text)) return false;
	if (handoffMode !== "summary") return true;

	const handoff = extractRalphHandoff(text);
	if (!handoff) return false;

	const status = getHandoffField(handoff, "Status");
	if (!status) return false;
	if (/\b(in[_ -]?progress|incomplete|unfinished|partial|blocked|pending|not\s+(?:yet\s+)?(?:complete|done|finished)|belum\s+(?:selesai|tuntas|lengkap))\b/i.test(status)) {
		return false;
	}
	if (!/\b(?:complete|completed|done|finished|verified|resolved)\b/i.test(status)) return false;

	for (const field of ["Open questions?", "Next action"]) {
		const value = getHandoffField(handoff, field);
		if (value !== null && !isEmptyHandoffValue(value)) return false;
	}
	return true;
}

export interface IterationTaskOptions {
	stopOnCompletion: boolean;
	verificationPass: number;
	handoffMode: HandoffMode;
	handoff?: string | null;
	artifactPath?: string | null;
}

export function buildIterationTask(originalTask: string, options: IterationTaskOptions): string {
	const sections: string[] = [
		"You are already running as a Ralph loop subagent. Do not invoke ralph_loop, ask another agent to invoke it, or create a nested loop; work directly on the delegated task.",
	];
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
				`When a structured ${HANDOFF_START_MARKER} is present, its status must explicitly indicate complete or verified, and its open questions and next action must be none before this marker is valid.`,
				`Only after those checks pass, end the final assistant response with exactly ${COMPLETION_MARKER} on its own line.`,
			].join(" "),
		);
	}
	if (sections.length === 0) return originalTask;
	return `${originalTask}\n\n[Ralph loop runtime context]\n${sections.join("\n\n")}`;
}
