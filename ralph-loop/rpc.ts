/**
 * Child-process and JSON-RPC helpers for ralph loop subagents.
 */

export function isProcessActive(proc: any): boolean {
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

export function terminateSubagent(proc: any, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
	if (!isProcessActive(proc)) return;
	try {
		if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, signal);
		else proc.kill(signal);
	} catch {
		try { proc.kill(signal); } catch { /* already exited */ }
	}
}
