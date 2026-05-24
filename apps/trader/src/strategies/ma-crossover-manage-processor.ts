/**
 * ma-crossover MANAGE processor (Phase 2 BullMQ migration).
 *
 * Static SL/TP from `jobData.championParams` (captured at entry). On close
 * (any reason), update the Redis-backed allocator via `recordClosedTrade`
 * keyed by `jobData.championIdAtEntry` so bandit attribution survives the
 * position's lifecycle.
 */

import type { createBybitClient } from "@ai-scalper/bybit-client";
import type { TickerSource } from "@ai-scalper/bybit-client/ticker-source";
import type { MaCrossoverManageJobData } from "@ai-scalper/queueing";
import type { TraderConfig } from "../config";
import type { WebhookAlerter } from "../alerts/webhook";
import type { StrategySharedState } from "./shared/bullmq-shared-state";
import { appendDecisionHistory } from "./shared/trade-job-helpers";
import type { ClosedPositionLedgerEntry } from "../trading/position-ledger";
import { emptyAllocatorState, recordClosedTrade } from "../meta/allocator";
import type { AllocatorStore } from "./shared/allocator-redis";

type BybitClient = ReturnType<typeof createBybitClient>;

export interface MaCrossoverManageProcessorLedger {
  appendClosedPosition(entry: ClosedPositionLedgerEntry): Promise<void>;
}

export interface MaCrossoverManageProcessorDeps {
  config: TraderConfig;
  client: BybitClient;
  tickerSource: TickerSource;
  alerter: WebhookAlerter;
  sharedState: StrategySharedState;
  positionLedger: MaCrossoverManageProcessorLedger;
  allocatorStore: AllocatorStore;
  log?: (payload: Record<string, unknown>) => void;
  now?: () => number;
}

export type MaCrossoverManageTickResult =
  | { status: "complete"; reason: string }
  | { status: "continue"; updatedData: MaCrossoverManageJobData };

export async function processMaCrossoverManageTick(
  jobData: MaCrossoverManageJobData,
  deps: MaCrossoverManageProcessorDeps,
): Promise<MaCrossoverManageTickResult> {
  const { config, client, tickerSource, alerter, sharedState, positionLedger, allocatorStore } = deps;
  const log = deps.log ?? ((p) => console.log(JSON.stringify(p)));
  const now = (deps.now ?? Date.now)();
  const observedAt = new Date(now).toISOString();

  if (!config.paperTrading) {
    try {
      const live = await client.getPosition({ category: "linear", symbol: jobData.symbol });
      const liveSize = live ? Number(live.size) : 0;
      if (jobData.qty > 0 && (!live || !Number.isFinite(liveSize) || liveSize < jobData.qty * 0.01)) {
        await positionLedger.appendClosedPosition(buildLedger(jobData, jobData.entryPrice, 0, 0, 0, "external-close-detected"));
        await updateAllocator(allocatorStore, jobData.championIdAtEntry, 0, now);
        await alerter.send(`ma-crossover: external close ${jobData.symbol}`).catch(() => {});
        return { status: "complete", reason: "external-close" };
      }
    } catch (err) {
      log({
        ts: observedAt, event: "ma-crossover-reconcile-failed",
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
      ts: observedAt, event: "ma-crossover-ticker-unavailable",
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
          ts: observedAt, event: "ma-crossover-close-failed",
          symbol: jobData.symbol,
          error: err instanceof Error ? err.message : String(err),
        });
        await alerter.send(`ma-crossover close failed: ${jobData.symbol}`).catch(() => {});
        return {
          status: "continue",
          updatedData: {
            ...jobData, lastReviewAt: observedAt,
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
    await updateAllocator(allocatorStore, jobData.championIdAtEntry, netPnl, now);
    await sharedState.setLastTradeAt(now);

    log({
      ts: observedAt, event: "ma-crossover-close",
      positionId: jobData.positionId, symbol: jobData.symbol,
      currentPrice, grossPnl, feeUsd, netPnl, reason,
      championIdAtEntry: jobData.championIdAtEntry,
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

async function updateAllocator(
  store: AllocatorStore, championId: string, pnl: number, now: number,
): Promise<void> {
  const current = (await store.load()) ?? emptyAllocatorState();
  const next = recordClosedTrade(current, championId, pnl, now);
  await store.save(next);
}

function buildLedger(
  jobData: MaCrossoverManageJobData,
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
    championIdAtEntry: jobData.championIdAtEntry,
    strategyType: "ma-crossover",
    side: jobData.side,
    stopLossPrice: jobData.stopLossPrice,
    symbol: jobData.symbol,
    takeProfitPrice: jobData.takeProfitPrice,
  };
}

export const __INTERNAL = { buildLedger, updateAllocator };
