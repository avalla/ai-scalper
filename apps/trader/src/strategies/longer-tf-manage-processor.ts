/**
 * longer-tf MANAGE processor (Phase 2 BullMQ migration).
 *
 * Per-tick flow:
 *   1. Reconcile against Bybit (live only).
 *   2. Fetch ticker for current price.
 *   3. Static SL/TP from jobData → close reduce-only, COMPLETE on hit.
 *   4. Otherwise update lastReviewAt, CONTINUE.
 */

import type { createBybitClient } from "@ai-scalper/bybit-client";
import type { LongerTfManageJobData } from "@ai-scalper/queueing";
import type { TraderConfig } from "../config";
import type { WebhookAlerter } from "../alerts/webhook";
import type { StrategySharedState } from "./shared/bullmq-shared-state";
import { appendDecisionHistory } from "./shared/trade-job-helpers";
import type { ClosedPositionLedgerEntry } from "../trading/position-ledger";

type BybitClient = ReturnType<typeof createBybitClient>;

export interface LongerTfManageProcessorLedger {
  appendClosedPosition(entry: ClosedPositionLedgerEntry): Promise<void>;
}

export interface LongerTfManageProcessorDeps {
  config: TraderConfig;
  client: BybitClient;
  alerter: WebhookAlerter;
  sharedState: StrategySharedState;
  positionLedger: LongerTfManageProcessorLedger;
  log?: (payload: Record<string, unknown>) => void;
  now?: () => number;
}

export type LongerTfManageTickResult =
  | { status: "complete"; reason: string }
  | { status: "continue"; updatedData: LongerTfManageJobData };

export async function processLongerTfManageTick(
  jobData: LongerTfManageJobData,
  deps: LongerTfManageProcessorDeps,
): Promise<LongerTfManageTickResult> {
  const { config, client, alerter, sharedState, positionLedger } = deps;
  const log = deps.log ?? ((p) => console.log(JSON.stringify(p)));
  const now = (deps.now ?? Date.now)();
  const observedAt = new Date(now).toISOString();

  // (1) Reconcile.
  if (!config.paperTrading) {
    try {
      const live = await client.getPosition({ category: "linear", symbol: jobData.symbol });
      const liveSize = live ? Number(live.size) : 0;
      if (jobData.qty > 0 && (!live || !Number.isFinite(liveSize) || liveSize < jobData.qty * 0.01)) {
        await positionLedger.appendClosedPosition(buildLedger(jobData, jobData.entryPrice, 0, 0, 0, "external-close-detected"));
        await alerter.send(`longer-tf: external close ${jobData.symbol}`).catch(() => {});
        return { status: "complete", reason: "external-close" };
      }
    } catch (err) {
      log({
        ts: observedAt, event: "longer-tf-reconcile-failed",
        positionId: jobData.positionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // (2) ticker.
  let currentPrice = jobData.entryPrice;
  try {
    const t = await client.getTicker({ category: "linear", symbol: jobData.symbol });
    const p = Number(t.lastPrice);
    if (Number.isFinite(p) && p > 0) currentPrice = p;
  } catch (err) {
    log({
      ts: observedAt, event: "longer-tf-ticker-unavailable",
      symbol: jobData.symbol,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "continue", updatedData: { ...jobData, lastReviewAt: observedAt } };
  }

  // (3) SL/TP check.
  const slHit = jobData.side === "long"
    ? currentPrice <= jobData.stopLossPrice
    : currentPrice >= jobData.stopLossPrice;
  const tpHit = jobData.side === "long"
    ? currentPrice >= jobData.takeProfitPrice
    : currentPrice <= jobData.takeProfitPrice;

  if (slHit || tpHit) {
    const reason = slHit ? "stop-loss" : "take-profit";
    if (!config.paperTrading) {
      try {
        await client.createOrder({
          category: "linear", symbol: jobData.symbol,
          side: jobData.side === "long" ? "Sell" : "Buy",
          qty: String(jobData.qty), orderType: "Market",
          reduceOnly: true,
        });
      } catch (err) {
        log({
          ts: observedAt, event: "longer-tf-close-failed",
          symbol: jobData.symbol,
          error: err instanceof Error ? err.message : String(err),
        });
        await alerter.send(`longer-tf close failed: ${jobData.symbol}`).catch(() => {});
        return {
          status: "continue",
          updatedData: {
            ...jobData,
            lastReviewAt: observedAt,
            decisionsHistory: appendDecisionHistory(jobData.decisionsHistory, {
              at: observedAt, action: "close-attempt-failed", reasoning: reason,
            }),
          },
        };
      }
    }
    const sign = jobData.side === "long" ? 1 : -1;
    const grossPnl = sign * (currentPrice - jobData.entryPrice) * jobData.qty;
    const closeNotional = jobData.qty * currentPrice;
    const feeUsd = closeNotional * (config.feeRoundTripBps / 10_000);
    const netPnl = grossPnl - feeUsd;

    await positionLedger.appendClosedPosition(buildLedger(jobData, currentPrice, netPnl, grossPnl, feeUsd, reason));
    await sharedState.setLastTradeAt(now);

    log({
      ts: observedAt, event: "longer-tf-close",
      positionId: jobData.positionId, symbol: jobData.symbol,
      currentPrice, grossPnl, feeUsd, netPnl, reason,
    });
    return { status: "complete", reason };
  }

  return {
    status: "continue",
    updatedData: {
      ...jobData,
      lastReviewAt: observedAt,
      decisionsHistory: appendDecisionHistory(jobData.decisionsHistory, {
        at: observedAt, action: "hold", reasoning: `price=${currentPrice}`,
      }),
    },
  };
}

function buildLedger(
  jobData: LongerTfManageJobData,
  exitPrice: number,
  netPnl: number,
  grossPnl: number,
  feeUsd: number,
  reason: string,
): ClosedPositionLedgerEntry {
  return {
    closedAt: new Date().toISOString(),
    cumulativeRealizedPnlUsd: 0,
    entryPrice: jobData.entryPrice,
    exitPrice,
    exitReason: reason,
    leverage: jobData.leverage,
    notionalUsd: jobData.qty * exitPrice,
    openedAt: jobData.openedAt,
    quantity: jobData.qty,
    realizedPnlUsd: netPnl,
    grossPnlUsd: grossPnl,
    feeUsd,
    championIdAtEntry: null,
    strategyType: "longer-tf",
    side: jobData.side,
    stopLossPrice: jobData.stopLossPrice,
    symbol: jobData.symbol,
    takeProfitPrice: jobData.takeProfitPrice,
  };
}

export const __INTERNAL = { buildLedger };
