/**
 * bollinger-adx MANAGE processor (Phase 2 BullMQ migration).
 * Static SL/TP at the bps prices captured at entry. No regime re-classification
 * inside the manage loop (matches `runBollingerAdxTick`'s in-position branch:
 * SL/TP take precedence over signal flip).
 */

import type { createBybitClient } from "@ai-scalper/bybit-client";
import type { TickerSource } from "@ai-scalper/bybit-client/ticker-source";
import type { BollingerAdxManageJobData } from "@ai-scalper/queueing";
import type { TraderConfig } from "../config";
import type { WebhookAlerter } from "../alerts/webhook";
import type { StrategySharedState } from "./shared/bullmq-shared-state";
import { appendDecisionHistory } from "./shared/trade-job-helpers";
import type { ClosedPositionLedgerEntry } from "../trading/position-ledger";

type BybitClient = ReturnType<typeof createBybitClient>;

export interface BollingerAdxManageProcessorLedger {
  appendClosedPosition(entry: ClosedPositionLedgerEntry): Promise<void>;
}

export interface BollingerAdxManageProcessorDeps {
  config: TraderConfig;
  client: BybitClient;
  tickerSource: TickerSource;
  alerter: WebhookAlerter;
  sharedState: StrategySharedState;
  positionLedger: BollingerAdxManageProcessorLedger;
  log?: (payload: Record<string, unknown>) => void;
  now?: () => number;
}

export type BollingerAdxManageTickResult =
  | { status: "complete"; reason: string }
  | { status: "continue"; updatedData: BollingerAdxManageJobData };

export async function processBollingerAdxManageTick(
  jobData: BollingerAdxManageJobData,
  deps: BollingerAdxManageProcessorDeps,
): Promise<BollingerAdxManageTickResult> {
  const { config, client, tickerSource, alerter, sharedState, positionLedger } = deps;
  const log = deps.log ?? ((p) => console.log(JSON.stringify(p)));
  const now = (deps.now ?? Date.now)();
  const observedAt = new Date(now).toISOString();

  if (!config.paperTrading) {
    try {
      const live = await client.getPosition({ category: "linear", symbol: jobData.symbol });
      const liveSize = live ? Number(live.size) : 0;
      if (jobData.qty > 0 && (!live || !Number.isFinite(liveSize) || liveSize < jobData.qty * 0.01)) {
        await positionLedger.appendClosedPosition(buildLedger(jobData, jobData.entryPrice, 0, 0, 0, "external-close-detected"));
        await alerter.send(`bollinger-adx: external close ${jobData.symbol}`).catch(() => {});
        return { status: "complete", reason: "external-close" };
      }
    } catch (err) {
      log({
        ts: observedAt, event: "bollinger-adx-reconcile-failed",
        positionId: jobData.positionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let currentPrice = jobData.entryPrice;
  try {
    const t = await tickerSource.getTicker(jobData.symbol, { category: "linear" });
    const p = Number(t.lastPrice);
    if (Number.isFinite(p) && p > 0) currentPrice = p;
  } catch (err) {
    log({
      ts: observedAt, event: "bollinger-adx-ticker-unavailable",
      symbol: jobData.symbol,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "continue", updatedData: { ...jobData, lastReviewAt: observedAt } };
  }

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
          qty: String(jobData.qty), orderType: "Market", reduceOnly: true,
        });
      } catch (err) {
        log({
          ts: observedAt, event: "bollinger-adx-close-failed",
          symbol: jobData.symbol,
          error: err instanceof Error ? err.message : String(err),
        });
        await alerter.send(`bollinger-adx close failed: ${jobData.symbol}`).catch(() => {});
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
      ts: observedAt, event: "bollinger-adx-close",
      positionId: jobData.positionId, symbol: jobData.symbol,
      currentPrice, grossPnl, feeUsd, netPnl, reason,
    });
    return { status: "complete", reason };
  }

  return {
    status: "continue",
    updatedData: {
      ...jobData, lastReviewAt: observedAt,
      decisionsHistory: appendDecisionHistory(jobData.decisionsHistory, {
        at: observedAt, action: "hold", reasoning: `price=${currentPrice}`,
      }),
    },
  };
}

function buildLedger(
  jobData: BollingerAdxManageJobData,
  exitPrice: number, netPnl: number, grossPnl: number, feeUsd: number, reason: string,
): ClosedPositionLedgerEntry {
  return {
    closedAt: new Date().toISOString(),
    cumulativeRealizedPnlUsd: 0,
    entryPrice: jobData.entryPrice,
    exitPrice, exitReason: reason,
    leverage: jobData.leverage,
    notionalUsd: jobData.qty * exitPrice,
    openedAt: jobData.openedAt,
    quantity: jobData.qty,
    realizedPnlUsd: netPnl, grossPnlUsd: grossPnl, feeUsd,
    championIdAtEntry: null,
    strategyType: "bollinger-adx",
    side: jobData.side,
    stopLossPrice: jobData.stopLossPrice,
    symbol: jobData.symbol,
    takeProfitPrice: jobData.takeProfitPrice,
  };
}

export const __INTERNAL = { buildLedger };
