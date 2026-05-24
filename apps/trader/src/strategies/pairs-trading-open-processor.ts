/**
 * pairs-trading OPEN-DECISION processor (Phase 2 BullMQ migration).
 *
 * Two-leg across DIFFERENT symbols (default BTCUSDT + ETHUSDT). If leg2 order
 * fails on open, leg1 is compensated reduce-only and no manage job is enqueued.
 */

import {
  JOB_NAMES, STRATEGY_JOB_POLICY,
  type PairsTradingManageJobData, type PairsTradingOpenTickJobData,
} from "@ai-scalper/queueing";

import type { createBybitClient } from "@ai-scalper/bybit-client";
import type { TraderConfig } from "../config";
import type { WebhookAlerter } from "../alerts/webhook";
import { pairsDecide, type PairsCache } from "./pairs-trading";
import type { StrategySharedState } from "./shared/bullmq-shared-state";
import { computeQtyFromNotional, makePositionId } from "./shared/trade-job-helpers";

type BybitClient = ReturnType<typeof createBybitClient>;

export interface ManageQueueLike<TData> {
  add(name: string, data: TData, opts?: Record<string, unknown>): Promise<unknown>;
}

export interface PairsCacheStore {
  get(): PairsCache | null;
  set(c: PairsCache): void;
}

export function createInMemoryPairsCacheStore(): PairsCacheStore {
  let cache: PairsCache | null = null;
  return { get() { return cache; }, set(c) { cache = c; } };
}

export interface PairsTradingOpenProcessorDeps {
  config: TraderConfig;
  client: BybitClient;
  alerter: WebhookAlerter;
  manageQueue: ManageQueueLike<PairsTradingManageJobData>;
  sharedState: StrategySharedState;
  pairsCacheStore: PairsCacheStore;
  decideFn?: typeof pairsDecide;
  log?: (payload: Record<string, unknown>) => void;
  now?: () => number;
}

export type PairsTradingOpenTickResult =
  | { status: "skipped"; reason: string }
  | { status: "compensated"; reason: string }
  | {
      status: "opened";
      positionId: string;
      leg1Symbol: string;
      leg2Symbol: string;
      leg1Side: "long" | "short";
      leg2Side: "long" | "short";
      leg1Qty: number;
      leg2Qty: number;
      leg1EntryPrice: number;
      leg2EntryPrice: number;
      entryZ: number;
      hedgeRatio: number;
    };

export async function processPairsTradingOpenTick(
  _jobData: PairsTradingOpenTickJobData,
  deps: PairsTradingOpenProcessorDeps,
): Promise<PairsTradingOpenTickResult> {
  const { config, client, alerter, manageQueue, sharedState, pairsCacheStore } = deps;
  const decideFn = deps.decideFn ?? pairsDecide;
  const log = deps.log ?? ((p) => console.log(JSON.stringify(p)));
  const now = (deps.now ?? Date.now)();
  const observedAt = new Date(now).toISOString();
  const leg1Symbol = config.pairsLeg1Symbol;
  const leg2Symbol = config.pairsLeg2Symbol;

  if (await sharedState.hasActivePosition()) {
    return { status: "skipped", reason: "active-position-exists" };
  }

  // Refresh kline cache if stale/missing.
  let cache = pairsCacheStore.get();
  const cacheStale = (
    cache === null
    || cache.leg1Symbol !== leg1Symbol
    || cache.leg2Symbol !== leg2Symbol
    || (now - cache.fetchedAt) >= config.pairsKlineRefreshSec * 1000
  );
  if (cacheStale) {
    try {
      const [r1, r2] = await Promise.all([
        client.getKlines({ category: "linear", symbol: leg1Symbol, interval: config.pairsKlineInterval, limit: config.pairsWindowSize + 10 }),
        client.getKlines({ category: "linear", symbol: leg2Symbol, interval: config.pairsKlineInterval, limit: config.pairsWindowSize + 10 }),
      ]);
      const l1 = ((r1 as { list?: string[][] }).list ?? []).slice().reverse().map((r) => Number(r[4]))
        .filter((n) => Number.isFinite(n) && n > 0);
      const l2 = ((r2 as { list?: string[][] }).list ?? []).slice().reverse().map((r) => Number(r[4]))
        .filter((n) => Number.isFinite(n) && n > 0);
      const n = Math.min(l1.length, l2.length);
      cache = {
        leg1Symbol, leg2Symbol, fetchedAt: now,
        leg1Closes: l1.slice(-n), leg2Closes: l2.slice(-n),
      };
      pairsCacheStore.set(cache);
    } catch (err) {
      log({
        ts: observedAt, event: "pairs-trading-klines-failed",
        error: err instanceof Error ? err.message : String(err),
      });
      return { status: "skipped", reason: "kline-refresh-failed" };
    }
  }

  const decision = decideFn({
    cache, position: null, now,
    refreshSec: config.pairsKlineRefreshSec,
    windowSize: config.pairsWindowSize,
    entryZ: config.pairsEntryZ, exitZ: config.pairsExitZ,
    maxHoldMinutes: config.pairsMaxHoldMinutes,
    leg1Symbol, leg2Symbol,
  });
  if (decision.kind !== "enter") {
    return { status: "skipped", reason: `decide-${decision.kind}:${decision.reason ?? ""}` };
  }

  let l1Price = 0; let l2Price = 0;
  let l1Instr; let l2Instr;
  try {
    const [t1, t2, i1, i2] = await Promise.all([
      client.getTicker({ category: "linear", symbol: leg1Symbol }),
      client.getTicker({ category: "linear", symbol: leg2Symbol }),
      client.getInstrumentInfo({ category: "linear", symbol: leg1Symbol }),
      client.getInstrumentInfo({ category: "linear", symbol: leg2Symbol }),
    ]);
    l1Price = Number(t1.lastPrice);
    l2Price = Number(t2.lastPrice);
    l1Instr = i1; l2Instr = i2;
  } catch (err) {
    log({
      ts: observedAt, event: "pairs-trading-instrument-fetch-failed",
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "skipped", reason: "instrument-fetch-failed" };
  }
  if (!Number.isFinite(l1Price) || l1Price <= 0 || !Number.isFinite(l2Price) || l2Price <= 0) {
    return { status: "skipped", reason: "ticker-invalid" };
  }

  const perLegNotional = config.pairsMaxNotionalUsdPerLeg;
  const q1 = computeQtyFromNotional({
    notionalUsd: perLegNotional, leverage: 1, price: l1Price,
    qtyStep: l1Instr.lotSizeFilter.qtyStep,
    minOrderQty: l1Instr.lotSizeFilter.minOrderQty,
  });
  const q2 = computeQtyFromNotional({
    notionalUsd: perLegNotional, leverage: 1, price: l2Price,
    qtyStep: l2Instr.lotSizeFilter.qtyStep,
    minOrderQty: l2Instr.lotSizeFilter.minOrderQty,
  });
  if (!q1 || !q2) return { status: "skipped", reason: "qty-below-min" };

  if (!config.paperTrading) {
    try {
      await client.createOrder({
        category: "linear", symbol: leg1Symbol,
        side: decision.leg1Side === "long" ? "Buy" : "Sell",
        qty: q1.qtyStr, orderType: "Market",
      });
    } catch (err) {
      log({
        ts: observedAt, event: "pairs-trading-leg1-open-failed",
        error: err instanceof Error ? err.message : String(err),
      });
      await alerter.send(`pairs-trading leg1 open failed: ${leg1Symbol}`).catch(() => {});
      return { status: "skipped", reason: "leg1-open-failed" };
    }
    try {
      await client.createOrder({
        category: "linear", symbol: leg2Symbol,
        side: decision.leg2Side === "long" ? "Buy" : "Sell",
        qty: q2.qtyStr, orderType: "Market",
      });
    } catch (err) {
      log({
        ts: observedAt, event: "pairs-trading-leg2-open-failed-compensating",
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        await client.createOrder({
          category: "linear", symbol: leg1Symbol,
          side: decision.leg1Side === "long" ? "Sell" : "Buy",
          qty: q1.qtyStr, orderType: "Market", reduceOnly: true,
        });
      } catch (compErr) {
        log({
          ts: observedAt, event: "pairs-trading-compensation-failed",
          error: compErr instanceof Error ? compErr.message : String(compErr),
        });
        await alerter.send(`pairs-trading COMPENSATION FAILED: ${leg1Symbol}`).catch(() => {});
      }
      await alerter.send(`pairs-trading leg2 open failed (compensated): ${leg2Symbol}`).catch(() => {});
      return { status: "compensated", reason: "leg2-open-failed" };
    }
  }

  const positionId = makePositionId({
    strategy: "pairs-trading", now,
    discriminator: `${leg1Symbol}-${leg2Symbol}`,
  });
  const manageData: PairsTradingManageJobData = {
    positionId,
    leg1Symbol, leg1Side: decision.leg1Side, leg1EntryPrice: l1Price, leg1Qty: q1.qty,
    leg2Symbol, leg2Side: decision.leg2Side, leg2EntryPrice: l2Price, leg2Qty: q2.qty,
    hedgeRatio: decision.hedgeRatio,
    entryZ: decision.z,
    notionalPerLegUsd: perLegNotional,
    openedAt: new Date(now).toISOString(),
    decisionsHistory: [{
      at: new Date(now).toISOString(),
      action: "enter", reasoning: decision.reason,
    }],
    lastReviewAt: new Date(now).toISOString(),
  };

  await manageQueue.add(
    JOB_NAMES.pairsTradingManageTick, manageData,
    { ...STRATEGY_JOB_POLICY, jobId: positionId, repeat: { every: Math.max(5_000, config.pollMs) } },
  );

  log({
    ts: observedAt, event: "pairs-trading-opened",
    positionId, leg1Symbol, leg2Symbol,
    leg1Side: decision.leg1Side, leg2Side: decision.leg2Side,
    z: decision.z, hedgeRatio: decision.hedgeRatio,
  });

  return {
    status: "opened",
    positionId, leg1Symbol, leg2Symbol,
    leg1Side: decision.leg1Side, leg2Side: decision.leg2Side,
    leg1Qty: q1.qty, leg2Qty: q2.qty,
    leg1EntryPrice: l1Price, leg2EntryPrice: l2Price,
    entryZ: decision.z, hedgeRatio: decision.hedgeRatio,
  };
}
