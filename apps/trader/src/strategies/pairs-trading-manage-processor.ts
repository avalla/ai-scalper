/**
 * pairs-trading MANAGE processor (Phase 2 BullMQ migration).
 *
 * Two-leg different symbols. On every tick:
 *   1. Reconcile both legs (live). Any missing → close both, ledger, complete.
 *   2. Fetch both tickers; refresh kline cache if stale (used for z-score).
 *   3. Call pairsDecide with frozen hedgeRatio from entry. exit → close both
 *      reduce-only, ledger, complete. hold → continue.
 */

import type { createBybitClient } from "@ai-scalper/bybit-client";
import type { TickerSource } from "@ai-scalper/bybit-client/ticker-source";
import type { PairsTradingManageJobData } from "@ai-scalper/queueing";
import type { TraderConfig } from "../config";
import type { WebhookAlerter } from "../alerts/webhook";
import { pairsDecide, type PairsCache } from "./pairs-trading";
import type { StrategySharedState } from "./shared/bullmq-shared-state";
import { appendDecisionHistory } from "./shared/trade-job-helpers";
import type { ClosedPositionLedgerEntry } from "../trading/position-ledger";
import type { PairsCacheStore } from "./pairs-trading-open-processor";

type BybitClient = ReturnType<typeof createBybitClient>;

export interface PairsTradingManageProcessorLedger {
  appendClosedPosition(entry: ClosedPositionLedgerEntry): Promise<void>;
}

export interface PairsTradingManageProcessorDeps {
  config: TraderConfig;
  client: BybitClient;
  tickerSource: TickerSource;
  alerter: WebhookAlerter;
  sharedState: StrategySharedState;
  positionLedger: PairsTradingManageProcessorLedger;
  pairsCacheStore: PairsCacheStore;
  decideFn?: typeof pairsDecide;
  log?: (payload: Record<string, unknown>) => void;
  now?: () => number;
}

export type PairsTradingManageTickResult =
  | { status: "complete"; reason: string }
  | { status: "continue"; updatedData: PairsTradingManageJobData };

export async function processPairsTradingManageTick(
  jobData: PairsTradingManageJobData,
  deps: PairsTradingManageProcessorDeps,
): Promise<PairsTradingManageTickResult> {
  const { config, client, tickerSource, alerter, sharedState, positionLedger, pairsCacheStore } = deps;
  const decideFn = deps.decideFn ?? pairsDecide;
  const log = deps.log ?? ((p) => console.log(JSON.stringify(p)));
  const now = (deps.now ?? Date.now)();
  const observedAt = new Date(now).toISOString();

  // (1) Reconcile both legs (live).
  if (!config.paperTrading) {
    try {
      const [l1, l2] = await Promise.all([
        client.getPosition({ category: "linear", symbol: jobData.leg1Symbol }),
        client.getPosition({ category: "linear", symbol: jobData.leg2Symbol }),
      ]);
      const s1 = l1 ? Number(l1.size) : 0;
      const s2 = l2 ? Number(l2.size) : 0;
      const leg1Missing = !l1 || !Number.isFinite(s1) || s1 < jobData.leg1Qty * 0.01;
      const leg2Missing = !l2 || !Number.isFinite(s2) || s2 < jobData.leg2Qty * 0.01;
      if (leg1Missing || leg2Missing) {
        await positionLedger.appendClosedPosition(buildLedger(jobData, jobData.leg1EntryPrice, jobData.leg2EntryPrice, 0, 0, 0, "external-close-detected", jobData.entryZ));
        await alerter.send(`pairs-trading: external close ${jobData.leg1Symbol}+${jobData.leg2Symbol}`).catch(() => {});
        return { status: "complete", reason: "external-close" };
      }
    } catch (err) {
      log({
        ts: observedAt, event: "pairs-trading-reconcile-failed",
        positionId: jobData.positionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // (2) ticker refresh + kline cache refresh
  let l1Price = jobData.leg1EntryPrice; let l2Price = jobData.leg2EntryPrice;
  try {
    const [t1, t2] = await Promise.all([
      tickerSource.getTicker(jobData.leg1Symbol, { category: "linear" }),
      tickerSource.getTicker(jobData.leg2Symbol, { category: "linear" }),
    ]);
    const p1 = Number(t1.lastPrice); const p2 = Number(t2.lastPrice);
    if (Number.isFinite(p1) && p1 > 0) l1Price = p1;
    if (Number.isFinite(p2) && p2 > 0) l2Price = p2;
  } catch (err) {
    log({
      ts: observedAt, event: "pairs-trading-ticker-unavailable",
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "continue", updatedData: { ...jobData, lastReviewAt: observedAt } };
  }

  let cache: PairsCache | null = pairsCacheStore.get();
  const cacheStale = (
    cache === null
    || cache.leg1Symbol !== jobData.leg1Symbol
    || cache.leg2Symbol !== jobData.leg2Symbol
    || (now - cache.fetchedAt) >= config.pairsKlineRefreshSec * 1000
  );
  if (cacheStale) {
    try {
      const [r1, r2] = await Promise.all([
        client.getKlines({ category: "linear", symbol: jobData.leg1Symbol, interval: config.pairsKlineInterval, limit: config.pairsWindowSize + 10 }),
        client.getKlines({ category: "linear", symbol: jobData.leg2Symbol, interval: config.pairsKlineInterval, limit: config.pairsWindowSize + 10 }),
      ]);
      const l1 = ((r1 as { list?: string[][] }).list ?? []).slice().reverse().map((r) => Number(r[4]))
        .filter((n) => Number.isFinite(n) && n > 0);
      const l2 = ((r2 as { list?: string[][] }).list ?? []).slice().reverse().map((r) => Number(r[4]))
        .filter((n) => Number.isFinite(n) && n > 0);
      const n = Math.min(l1.length, l2.length);
      cache = { leg1Symbol: jobData.leg1Symbol, leg2Symbol: jobData.leg2Symbol, fetchedAt: now,
        leg1Closes: l1.slice(-n), leg2Closes: l2.slice(-n) };
      pairsCacheStore.set(cache);
    } catch (err) {
      log({
        ts: observedAt, event: "pairs-trading-kline-refresh-failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // (3) decide
  const decision = decideFn({
    cache, position: {
      leg1Symbol: jobData.leg1Symbol, leg1Side: jobData.leg1Side, leg1EntryPrice: jobData.leg1EntryPrice, leg1Qty: jobData.leg1Qty,
      leg2Symbol: jobData.leg2Symbol, leg2Side: jobData.leg2Side, leg2EntryPrice: jobData.leg2EntryPrice, leg2Qty: jobData.leg2Qty,
      hedgeRatio: jobData.hedgeRatio, entryZ: jobData.entryZ,
      entryAt: new Date(jobData.openedAt).getTime(),
    },
    now,
    refreshSec: config.pairsKlineRefreshSec,
    windowSize: config.pairsWindowSize,
    entryZ: config.pairsEntryZ, exitZ: config.pairsExitZ,
    maxHoldMinutes: config.pairsMaxHoldMinutes,
    leg1Symbol: jobData.leg1Symbol, leg2Symbol: jobData.leg2Symbol,
  });

  if (decision.kind === "hold") {
    return {
      status: "continue",
      updatedData: {
        ...jobData, lastReviewAt: observedAt,
        decisionsHistory: appendDecisionHistory(jobData.decisionsHistory, {
          at: observedAt, action: "hold", reasoning: decision.reason,
        }),
      },
    };
  }

  // exit — close both legs reduce-only
  if (!config.paperTrading) {
    const legs: Array<{ symbol: string; side: "Buy" | "Sell"; qty: string; label: string }> = [
      { symbol: jobData.leg1Symbol, side: jobData.leg1Side === "long" ? "Sell" : "Buy", qty: String(jobData.leg1Qty), label: "leg1" },
      { symbol: jobData.leg2Symbol, side: jobData.leg2Side === "long" ? "Sell" : "Buy", qty: String(jobData.leg2Qty), label: "leg2" },
    ];
    for (const leg of legs) {
      try {
        await client.createOrder({
          category: "linear", symbol: leg.symbol,
          side: leg.side, qty: leg.qty, orderType: "Market", reduceOnly: true,
        });
      } catch (err) {
        log({
          ts: observedAt, event: "pairs-trading-close-leg-failed",
          leg: leg.label, symbol: leg.symbol,
          error: err instanceof Error ? err.message : String(err),
        });
        await alerter.send(`pairs-trading close ${leg.label} failed: ${leg.symbol}`).catch(() => {});
        return {
          status: "continue",
          updatedData: {
            ...jobData, lastReviewAt: observedAt,
            decisionsHistory: appendDecisionHistory(jobData.decisionsHistory, {
              at: observedAt, action: "close-attempt-failed", reasoning: leg.label,
            }),
          },
        };
      }
    }
  }

  const s1 = jobData.leg1Side === "long" ? 1 : -1;
  const s2 = jobData.leg2Side === "long" ? 1 : -1;
  const l1Pnl = s1 * (l1Price - jobData.leg1EntryPrice) * jobData.leg1Qty;
  const l2Pnl = s2 * (l2Price - jobData.leg2EntryPrice) * jobData.leg2Qty;
  const grossPnl = l1Pnl + l2Pnl;
  const feeUsd = ((jobData.leg1Qty * l1Price) + (jobData.leg2Qty * l2Price)) * (config.feeRoundTripBps / 10_000);
  const netPnl = grossPnl - feeUsd;
  const exitZ = decision.kind === "exit" ? decision.currentZ : jobData.entryZ;

  await positionLedger.appendClosedPosition(buildLedger(jobData, l1Price, l2Price, netPnl, grossPnl, feeUsd, decision.reason, exitZ));
  await sharedState.setLastTradeAt(now);

  log({
    ts: observedAt, event: "pairs-trading-close",
    positionId: jobData.positionId,
    l1Pnl, l2Pnl, grossPnl, feeUsd, netPnl, reason: decision.reason, exitZ,
  });
  return { status: "complete", reason: decision.reason };
}

function buildLedger(
  jobData: PairsTradingManageJobData,
  l1Exit: number, _l2Exit: number,
  netPnl: number, grossPnl: number, feeUsd: number,
  reason: string, exitZ: number,
): ClosedPositionLedgerEntry {
  return {
    closedAt: new Date().toISOString(),
    cumulativeRealizedPnlUsd: 0,
    entryPrice: jobData.leg1EntryPrice,
    exitPrice: l1Exit,
    exitReason: reason,
    leverage: 1,
    notionalUsd: jobData.leg1Qty * l1Exit,
    openedAt: jobData.openedAt,
    quantity: jobData.leg1Qty,
    realizedPnlUsd: netPnl,
    grossPnlUsd: grossPnl,
    feeUsd,
    championIdAtEntry: null,
    strategyType: "pairs-trading",
    pairsLeg2Symbol: jobData.leg2Symbol,
    pairsEntryZ: jobData.entryZ,
    pairsExitZ: exitZ,
    side: jobData.leg1Side,
    stopLossPrice: 0,
    symbol: jobData.leg1Symbol,
    takeProfitPrice: 0,
  };
}

export const __INTERNAL = { buildLedger };
