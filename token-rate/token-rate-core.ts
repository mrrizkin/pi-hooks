/**
 * Pure token-rate accounting for the token-rate extension.
 *
 * "Streaming" time is measured from turn start until either the first tool
 * call or the end of the turn, whichever happens first. That keeps tool
 * execution time out of the tokens-per-second average.
 */

export interface TokenRateSnapshot {
  totalOutputTokens: number;
  totalSeconds: number;
  /** Average output tokens per second, or null when there is no data yet. */
  tps: number | null;
}

export function computeTps(tokens: number, seconds: number): number | null {
  if (!Number.isFinite(tokens) || !Number.isFinite(seconds)) return null;
  if (tokens <= 0 || seconds <= 0) return null;
  const tps = tokens / seconds;
  return Number.isFinite(tps) ? tps : null;
}

/** Format a TPS value for the footer, e.g. `12.3 tok/s` or `--`. */
export function formatTokenRate(tps: number | null): string {
  const value = tps === null ? null : Number.isFinite(tps) ? tps : null;
  return value === null ? "--" : `${value.toFixed(1)} tok/s`;
}

export class TokenRateTracker {
  private totalOutputTokens = 0;
  private totalSeconds = 0;
  private turnStartMs: number | null = null;
  private turnStreamEndMs: number | null = null;

  reset(): void {
    this.totalOutputTokens = 0;
    this.totalSeconds = 0;
    this.turnStartMs = null;
    this.turnStreamEndMs = null;
  }

  startTurn(timestamp: number = Date.now()): void {
    this.turnStartMs = timestamp;
    this.turnStreamEndMs = null;
  }

  /** Mark the end of streaming (e.g. at the first tool call of a turn). */
  markStreamEnd(timestamp: number = Date.now()): void {
    if (this.turnStartMs !== null && this.turnStreamEndMs === null) {
      this.turnStreamEndMs = timestamp;
    }
  }

  /**
   * Finish the current turn and fold its output into the running average.
   * Turns without positive output are ignored (matching the extension's
   * previous behaviour of skipping them entirely).
   */
  endTurn(outputTokens: number, timestamp: number = Date.now()): TokenRateSnapshot {
    const endMs = this.turnStreamEndMs ?? timestamp;
    const startMs = this.turnStartMs ?? endMs;
    const elapsedSeconds = Math.max(0.001, (endMs - startMs) / 1000);
    const tokens = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;

    if (tokens > 0) {
      this.totalOutputTokens += tokens;
      this.totalSeconds += elapsedSeconds;
    }

    this.turnStartMs = null;
    this.turnStreamEndMs = null;
    return this.snapshot();
  }

  snapshot(): TokenRateSnapshot {
    return {
      totalOutputTokens: this.totalOutputTokens,
      totalSeconds: this.totalSeconds,
      tps: computeTps(this.totalOutputTokens, this.totalSeconds),
    };
  }
}
