/**
 * Aggressive open-adapter.
 *
 * Translates an AggressiveIntent into:
 *   - exchange order (Market, taker — speed > fee for aggressive entries)
 *   - persisted manage-job state for the per-tick stop/TP loop
 *   - daily-state side-effect (recordTradeOpened)
 *
 * Paper mode bypasses the actual order; manage-job state is still persisted so
 * the PnL simulation runs end-to-end identically to live.
 */

import type { createBybitClient } from "@ai-scalper/bybit-client";
import type { TraderConfig } from "../config";
import type { WebhookAlerter } from "../alerts/webhook";
import type { AggressiveIntent } from "./types";
import type { DailyStateStore } from "./daily-state";
import { computeQtyFromNotional, makePositionId } from "../strategies/shared/trade-job-helpers";
import { ensureCrossMargin } from "../pipeline/cross-margin";

type BybitClient = ReturnType<typeof createBybitClient>;

/** Persisted state for one open aggressive position (lives on the manage queue). */
export interface AggressiveManageJobData {
  positionId: string;
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  qty: number;
  qtyStr: string;
  qtyStep: string;
  minOrderQty: string;
  notionalUsd: number;
  leverage: number;
  openedAt: string;
  /** Price at which we close mechanically as loss. */
  stopPrice: number;
  /** Price at which we close mechanically as profit. */
  takeProfitPrice: number;
  /** Strategy that emitted the intent (audit). */
  strategy: string;
  entryReason: string;
  lastReviewAt: string;
}

export interface AggressiveQueueLike {
  add(name: string, data: AggressiveManageJobData, opts?: Record<string, unknown>): Promise<unknown>;
}

export interface AggressiveAdapterDeps {
  config: TraderConfig;
  client: BybitClient;
  alerter: WebhookAlerter;
  manageQueue: AggressiveQueueLike;
  dailyState: DailyStateStore;
  /** Repeat interval for the manage tick (ms). Smaller = faster stop response. */
  manageTickMs: number;
  /** BullMQ job name for manage ticks. */
  manageJobName: string;
  log?: (payload: Record<string, unknown>) => void;
  now?: () => number;
}

export type AggressiveOpenResult =
  | { status: "opened"; positionId: string }
  | { status: "skipped"; reason: string };

/**
 * Place an aggressive entry. Caller is responsible for the GUARD check + the
 * one-position invariant (different to the conservative single global gate —
 * an aggressive run might allow several concurrent positions later).
 */
export async function placeAggressiveEntry(
  intent: AggressiveIntent,
  symbol: string,
  instrument: { lotSizeFilter: { qtyStep: string; minOrderQty: string } },
  deps: AggressiveAdapterDeps,
): Promise<AggressiveOpenResult> {
  if (intent.kind !== "enter") return { status: "skipped", reason: `non-enter:${intent.reason}` };

  const log = deps.log ?? ((p) => console.log(JSON.stringify(p)));
  const now = (deps.now ?? Date.now)();
  const observedAt = new Date(now).toISOString();

  const qtyOut = computeQtyFromNotional({
    notionalUsd: intent.notionalUsd, leverage: intent.leverage, price: intent.refPrice,
    qtyStep: instrument.lotSizeFilter.qtyStep, minOrderQty: instrument.lotSizeFilter.minOrderQty,
  });
  if (!qtyOut) {
    log({ ts: observedAt, event: "aggressive-open-skip", reason: "qty-below-min", intent });
    return { status: "skipped", reason: "qty-below-min" };
  }

  if (!deps.config.paperTrading) {
    // Cross margin + leverage in one idempotent call. Critical at leva 10-25:
    // isolated would put the perp leg one adverse tick away from liquidation
    // even on a normal basis divergence.
    await ensureCrossMargin({ client: deps.client, category: "linear", symbol, leverage: intent.leverage, log: (p) => log({ ts: observedAt, ...p }) });
    try {
      await deps.client.createOrder({
        category: "linear", symbol,
        side: intent.side === "long" ? "Buy" : "Sell",
        qty: qtyOut.qtyStr, orderType: "Market",
      });
    } catch (err) {
      log({ ts: observedAt, event: "aggressive-open-order-failed", err: err instanceof Error ? err.message : String(err) });
      await deps.alerter.send(`aggressive open failed: ${symbol}`).catch(() => {});
      return { status: "skipped", reason: "open-order-failed" };
    }
  }

  const positionId = makePositionId({ strategy: "aggressive", now, discriminator: symbol });
  const manageData: AggressiveManageJobData = {
    positionId, symbol, side: intent.side,
    entryPrice: intent.refPrice, qty: qtyOut.qty, qtyStr: qtyOut.qtyStr,
    qtyStep: instrument.lotSizeFilter.qtyStep, minOrderQty: instrument.lotSizeFilter.minOrderQty,
    notionalUsd: intent.notionalUsd, leverage: intent.leverage,
    openedAt: observedAt,
    stopPrice: intent.stopPrice, takeProfitPrice: intent.takeProfitPrice,
    strategy: "liquidation-hunter",
    entryReason: intent.reason,
    lastReviewAt: observedAt,
  };

  await deps.manageQueue.add(deps.manageJobName, manageData, {
    jobId: positionId,
    attempts: 1,
    removeOnComplete: 50, removeOnFail: 50,
    repeat: { every: Math.max(1_000, deps.manageTickMs) },
  });
  await deps.dailyState.recordTradeOpened();

  log({
    ts: observedAt, event: "aggressive-opened",
    positionId, symbol, side: intent.side, qty: qtyOut.qty,
    entryPrice: intent.refPrice, stopPrice: intent.stopPrice, takeProfitPrice: intent.takeProfitPrice,
    leverage: intent.leverage, notionalUsd: intent.notionalUsd, reason: intent.reason,
  });
  return { status: "opened", positionId };
}
