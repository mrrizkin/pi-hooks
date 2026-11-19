/**
 * Token Rate Status Extension
 *
 * Shows the average output tokens per second in the footer status line.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TokenRateTracker, formatTokenRate } from "./token-rate-core.js";

type StatusContext = {
  hasUI: boolean;
  ui: { theme: { fg(color: string, text: string): string }; setStatus: (key: string, text?: string) => void };
};

export default function (pi: ExtensionAPI) {
  const statusKey = "token-rate";
  const tracker = new TokenRateTracker();

  const updateStatus = (ctx: StatusContext) => {
    if (!ctx.hasUI) return;
    const theme = ctx.ui.theme;
    const { tps } = tracker.snapshot();
    if (tps === null) {
      ctx.ui.setStatus(statusKey, theme.fg("dim", "TPS: --"));
      return;
    }
    ctx.ui.setStatus(statusKey, theme.fg("dim", "TPS: ") + theme.fg("accent", formatTokenRate(tps)));
  };

  const reset = (ctx: StatusContext) => {
    tracker.reset();
    updateStatus(ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    reset(ctx);
  });

  (pi as any).on("session_switch", async (_event: any, ctx: StatusContext) => {
    reset(ctx);
  });

  pi.on("turn_start", async (event, ctx) => {
    tracker.startTurn(event.timestamp ?? Date.now());
    updateStatus(ctx);
  });

  pi.on("tool_call", async (_event, _ctx) => {
    tracker.markStreamEnd(Date.now());
  });

  pi.on("turn_end", async (event, ctx) => {
    const message = event.message as AssistantMessage | undefined;
    if (!message || message.role !== "assistant") {
      tracker.endTurn(0, (event as any).timestamp ?? Date.now());
      updateStatus(ctx);
      return;
    }

    tracker.endTurn(message.usage?.output ?? 0, (event as any).timestamp ?? Date.now());
    updateStatus(ctx);
  });
}
