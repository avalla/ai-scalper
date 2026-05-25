/**
 * liquidation-cascade MANAGE processor (Phase 2 BullMQ migration).
 *
 * Per tick:
 *   1. Reconcile against Bybit (live only) — if the live position has
 *      vanished, append external-close ledger entry and complete the job.
 *   2. Fetch current ticker price.
 *   3. Compute exit reason:
 *        - time-based: (now - openedAt) > maxHoldSec * 1000 → "liquidation-max-hold"
 *        - else getExitReason(signal=flat) → "take-profit" | "stop-loss"
 *      No exit reason → emit "hold" decision, continue.
 *   4. On exit: place reduce-only close (paper bypass), append ledger entry,
 *      setLastTradeAt, COMPLETE JOB.
 */

import type { createBybitClient } from "@ai-scalper/bybit-client";
import type { TickerSource } from "@ai-scalper/bybit-client/ticker-source";
import type { LiquidationCascadeManageJobData } from "@ai-scalper/queueing";
import { getExitReason } from "@ai-scalper/trading-core";
import type { OpenPosition, TraderState } from "@ai-scalper/trading-core";
import type { TraderConfig } from "../config";
import type { WebhookAlerter } from "../alerts/webhook";
import type { StrategySharedState } from "./shared/bullmq-shared-state";
import { appendDecisionHistory } from "./shared/trade-job-helpers";
import type { ClosedPositionLedgerEntry } from "../trading/position-ledger";

type BybitClient = ReturnType<typeof createBybitClient>;

export interface LiquidationCascadeManageProcessorLedger {
  appendClosedPosition(entry: ClosedPositionLedgerEntry): Promise<void>;
}

export interface LiquidationCascadeManageProcessorDeps {
  config: TraderConfig;
  client: BybitClient;
  tickerSource: TickerSource;
  alerter: WebhookAlerter;
  sharedState: StrategySharedState;
  positionLedger: LiquidationCascadeManageProcessorLedger;
  log?: (payload: Record<string, unknown>) => void;
  now?: () => number;
}

export type LiquidationCascadeManageTickResult =
  | { status: "complete"; reason: string }
  | { status: "continue"; updatedData: LiquidationCascadeManageJobData };

export async function processLiquidationCascadeManageTick(
  jobData: LiquidationCascadeManageJobData,
  deps: LiquidationCascadeManageProcessorDeps,
): Promise<LiquidationCascadeManageTickResult> {
  const { config, client, tickerSource, alerter, sharedState, positionLedger } = deps;
  const log = deps.log ?? ((p) => console.log(JSON.stringify(p)));
  const now = (deps.now ?? Date.now)();
  const observedAt = new Date(now).toISOString();

  // (1) Reconcile against Bybit (live only)
  if (!config.paperTrading) {
    try {
      const live = await client.getPosition({ category: config.category, symbol: jobData.symbol });
      const liveSize = live ? Number(live.size) : 0;
      if (jobData.qty > 0 && (!live || !Number.isFinite(liveSize) || liveSize < jobData.qty * 0.01)) {
        log({
          ts: observedAt,
          event: "liquidation-cascade-external-close",
          positionId: jobData.positionId,
          symbol: jobData.symbol,
          recordedQty: jobData.qty,
          liveSize,
        });
        await positionLedger.appendClosedPosition(buildLedgerEntry({
          jobData,
          currentPrice: jobData.entryPrice,
          netPnl: 0,
          grossPnl: 0,
          feeUsd: 0,
          exitReason: "external-close-detected",
          now,
        }));
        await alerter.send(`liquidation-cascade: external close detected for ${jobData.symbol}`).catch(() => {});
        await sharedState.setLastTradeAt(now);
        return { status: "complete", reason: "external-close" };
      }
    } catch (err) {
      log({
        ts: observedAt,
        event: "liquidation-cascade-reconcile-failed",
        positionId: jobData.positionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // (2) ticker
  let currentPrice = jobData.entryPrice;
  try {
    const t = await tickerSource.getTicker(jobData.symbol, { category: config.category });
    const p = Number(t.lastPrice);
    if (Number.isFinite(p) && p > 0) currentPrice = p;
  } catch (err) {
    log({
      ts: observedAt,
      event: "liquidation-cascade-ticker-unavailable",
      symbol: jobData.symbol,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      status: "continue",
      updatedData: { ...jobData, lastReviewAt: observedAt },
    };
  }

  // (3) compute exit reason
  const heldMs = now - Date.parse(jobData.openedAt);
  let exitReason: string | null = null;
  if (heldMs > jobData.maxHoldSec * 1000) {
    exitReason = "liquidation-max-hold";
  } else {
    const syntheticPosition: OpenPosition = {
      side: jobData.side,
      quantity: jobData.qty,
      notionalUsd: jobData.notionalUsd,
      entryPrice: jobData.entryPrice,
      leverage: jobData.leverage,
      openedAt: Date.parse(jobData.openedAt),
      stopLossPrice: jobData.stopLossPrice,
      takeProfitPrice: jobData.takeProfitPrice,
    };
    const syntheticState: TraderState = {
      lastTradeAt: null,
      realizedPnlUsd: 0,
      position: syntheticPosition,
      dayStartedAt: null,
    };
    const reason = getExitReason({ marketPrice: currentPrice, signal: "flat", state: syntheticState });
    if (reason === "take-profit" || reason === "stop-loss") {
      exitReason = reason;
    }
  }

  if (!exitReason) {
    return {
      status: "continue",
      updatedData: {
        ...jobData,
        lastReviewAt: observedAt,
        decisionsHistory: appendDecisionHistory(jobData.decisionsHistory, {
          at: observedAt,
          action: "hold",
          reasoning: "no-exit-condition",
        }),
      },
    };
  }

  // (4) exit — close reduce-only
  const closeSide: "Buy" | "Sell" = jobData.side === "long" ? "Sell" : "Buy";
  if (!config.paperTrading) {
    try {
      await client.createOrder({
        category: config.category,
        symbol: jobData.symbol,
        side: closeSide,
        qty: String(jobData.qty),
        orderType: "Market",
        reduceOnly: true,
      });
    } catch (err) {
      log({
        ts: observedAt,
        event: "liquidation-cascade-close-failed",
        symbol: jobData.symbol,
        error: err instanceof Error ? err.message : String(err),
      });
      await alerter.send(`liquidation-cascade close failed: ${jobData.symbol}`).catch(() => {});
      return {
        status: "continue",
        updatedData: { ...jobData, lastReviewAt: observedAt },
      };
    }
  }

  const sliceSign = jobData.side === "long" ? 1 : -1;
  const grossPnl = sliceSign * (currentPrice - jobData.entryPrice) * jobData.qty;
  const feeUsd = jobData.notionalUsd * (config.feeRoundTripBps / 10_000);
  const netPnl = grossPnl - feeUsd;

  await positionLedger.appendClosedPosition(buildLedgerEntry({
    jobData,
    currentPrice,
    grossPnl,
    feeUsd,
    netPnl,
    exitReason,
    now,
  }));
  await sharedState.setLastTradeAt(now);

  log({
    ts: observedAt,
    event: "liquidation-cascade-close",
    positionId: jobData.positionId,
    symbol: jobData.symbol,
    side: jobData.side,
    exitReason,
    entryPrice: jobData.entryPrice,
    exitPrice: currentPrice,
    quantity: jobData.qty,
    realizedPnlUsd: netPnl,
    grossPnlUsd: grossPnl,
    feeUsd,
  });

  return { status: "complete", reason: exitReason };
}

function buildLedgerEntry(params: {
  jobData: LiquidationCascadeManageJobData;
  currentPrice: number;
  grossPnl: number;
  feeUsd: number;
  netPnl: number;
  exitReason: string;
  now: number;
}): ClosedPositionLedgerEntry {
  const { jobData, currentPrice, grossPnl, feeUsd, netPnl, exitReason, now } = params;
  return {
    closedAt: new Date(now).toISOString(),
    cumulativeRealizedPnlUsd: 0,
    entryPrice: jobData.entryPrice,
    exitPrice: currentPrice,
    exitReason,
    leverage: jobData.leverage,
    notionalUsd: jobData.notionalUsd,
    openedAt: jobData.openedAt,
    quantity: jobData.qty,
    realizedPnlUsd: netPnl,
    grossPnlUsd: grossPnl,
    feeUsd,
    championIdAtEntry: null,
    strategyType: "liquidation-cascade",
    side: jobData.side,
    stopLossPrice: jobData.stopLossPrice,
    symbol: jobData.symbol,
    takeProfitPrice: jobData.takeProfitPrice,
  };
}

export const __INTERNAL = { buildLedgerEntry };
