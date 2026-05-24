/**
 * longer-tf OPEN-DECISION processor (Phase 2 BullMQ migration).
 *
 * Per-tick flow:
 *   1. Skip if active position exists (1-position invariant).
 *   2. Refresh kline cache (fetch klines from Bybit) if stale/missing.
 *   3. Compute MA-crossover signal via `longerTfSignal`. Skip on warmup or
 *      needs-refresh; skip on flat.
 *   4. Fetch instrument info + ticker for entry price + qty sizing.
 *   5. Place entry order, derive SL/TP prices, enqueue manage job.
 */

import {
  JOB_NAMES,
  STRATEGY_JOB_POLICY,
  type LongerTfManageJobData,
  type LongerTfOpenTickJobData,
} from "@ai-scalper/queueing";

import type { createBybitClient } from "@ai-scalper/bybit-client";
import type { TraderConfig } from "../config";
import type { WebhookAlerter } from "../alerts/webhook";
import { longerTfSignal, type LongerTfKlineCache } from "./longer-tf";
import type { StrategySharedState } from "./shared/bullmq-shared-state";
import { computeQtyFromNotional, makePositionId } from "./shared/trade-job-helpers";

type BybitClient = ReturnType<typeof createBybitClient>;

export interface ManageQueueLike<TData> {
  add(name: string, data: TData, opts?: Record<string, unknown>): Promise<unknown>;
}

export interface KlineCacheStore {
  get(symbol: string): LongerTfKlineCache | null;
  set(symbol: string, cache: LongerTfKlineCache): void;
}

/** Build an in-memory cache store backed by a Map (default for the worker). */
export function createInMemoryKlineCacheStore(): KlineCacheStore {
  const m = new Map<string, LongerTfKlineCache>();
  return {
    get(symbol) { return m.get(symbol) ?? null; },
    set(symbol, cache) { m.set(symbol, cache); },
  };
}

export interface LongerTfOpenProcessorDeps {
  config: TraderConfig;
  client: BybitClient;
  alerter: WebhookAlerter;
  manageQueue: ManageQueueLike<LongerTfManageJobData>;
  sharedState: StrategySharedState;
  klineCacheStore: KlineCacheStore;
  /** Optional override for the pure signal fn (tests). */
  signalFn?: typeof longerTfSignal;
  log?: (payload: Record<string, unknown>) => void;
  now?: () => number;
}

export type LongerTfOpenTickResult =
  | { status: "skipped"; reason: string }
  | {
      status: "opened";
      positionId: string;
      symbol: string;
      side: "long" | "short";
      qty: number;
      entryPrice: number;
      notionalUsd: number;
      leverage: number;
      stopLossPrice: number;
      takeProfitPrice: number;
    };

export async function processLongerTfOpenTick(
  _jobData: LongerTfOpenTickJobData,
  deps: LongerTfOpenProcessorDeps,
): Promise<LongerTfOpenTickResult> {
  const { config, client, alerter, manageQueue, sharedState, klineCacheStore } = deps;
  const signalFn = deps.signalFn ?? longerTfSignal;
  const log = deps.log ?? ((p) => console.log(JSON.stringify(p)));
  const now = (deps.now ?? Date.now)();
  const observedAt = new Date(now).toISOString();
  const symbol = config.symbol;

  if (await sharedState.hasActivePosition()) {
    return { status: "skipped", reason: "active-position-exists" };
  }

  // Refresh cache via klines.
  let cache = klineCacheStore.get(symbol);
  let signal = signalFn({
    cache, now, refreshSec: config.longerTfKlineRefreshSec, symbol,
    fastWindow: config.longerTfFastWindow,
    slowWindow: config.longerTfSlowWindow,
    thresholdBps: config.longerTfThresholdBps,
  });
  if (signal === "needs-refresh") {
    try {
      const raw = await client.getKlines({
        category: "linear", symbol,
        interval: config.longerTfKlineInterval,
        limit: Math.max(config.longerTfSlowWindow + 10, 50),
      });
      // Bybit returns newest-first; we need oldest-first.
      const list = ((raw as { list?: string[][] }).list ?? []).slice().reverse();
      const closes = list.map((row) => Number(row[4])).filter((n) => Number.isFinite(n) && n > 0);
      cache = { symbol, fetchedAt: now, closePrices: closes };
      klineCacheStore.set(symbol, cache);
      signal = signalFn({
        cache, now, refreshSec: config.longerTfKlineRefreshSec, symbol,
        fastWindow: config.longerTfFastWindow,
        slowWindow: config.longerTfSlowWindow,
        thresholdBps: config.longerTfThresholdBps,
      });
    } catch (err) {
      log({
        ts: observedAt, event: "longer-tf-klines-failed",
        symbol, error: err instanceof Error ? err.message : String(err),
      });
      return { status: "skipped", reason: "kline-refresh-failed" };
    }
  }

  if (signal === "warmup" || signal === "needs-refresh" || signal === "flat") {
    return { status: "skipped", reason: `signal-${signal}` };
  }

  const side: "long" | "short" = signal === "long" ? "long" : "short";

  let lastPrice = 0;
  try {
    const t = await client.getTicker({ category: "linear", symbol });
    lastPrice = Number(t.lastPrice);
  } catch (err) {
    log({
      ts: observedAt, event: "longer-tf-ticker-unavailable",
      symbol, error: err instanceof Error ? err.message : String(err),
    });
    return { status: "skipped", reason: "ticker-unavailable" };
  }
  if (!Number.isFinite(lastPrice) || lastPrice <= 0) {
    return { status: "skipped", reason: "ticker-invalid" };
  }

  let instrument;
  try {
    instrument = await client.getInstrumentInfo({ category: "linear", symbol });
  } catch (err) {
    log({
      ts: observedAt, event: "longer-tf-instrument-info-unavailable",
      symbol, error: err instanceof Error ? err.message : String(err),
    });
    return { status: "skipped", reason: "instrument-info-unavailable" };
  }

  const leverage = Math.max(1, config.leverage);
  const notionalUsd = config.orderUsd;
  const qtyOut = computeQtyFromNotional({
    notionalUsd, leverage, price: lastPrice,
    qtyStep: instrument.lotSizeFilter.qtyStep,
    minOrderQty: instrument.lotSizeFilter.minOrderQty,
  });
  if (!qtyOut) return { status: "skipped", reason: "qty-below-min" };

  if (!config.paperTrading) {
    try {
      await client.setLeverage({
        category: "linear", symbol,
        buyLeverage: String(leverage), sellLeverage: String(leverage),
      });
    } catch { /* ignore — Bybit might already have it set. */ }
    try {
      await client.createOrder({
        category: "linear", symbol,
        side: side === "long" ? "Buy" : "Sell",
        qty: qtyOut.qtyStr, orderType: "Market",
      });
    } catch (err) {
      log({
        ts: observedAt, event: "longer-tf-open-order-failed",
        symbol, error: err instanceof Error ? err.message : String(err),
      });
      await alerter.send(`longer-tf open order failed: ${symbol}`).catch(() => {});
      return { status: "skipped", reason: "open-order-failed" };
    }
  }

  const slBps = config.longerTfStopLossBps;
  const tpBps = config.longerTfTakeProfitBps;
  const stopLossPrice = side === "long"
    ? lastPrice * (1 - slBps / 10_000)
    : lastPrice * (1 + slBps / 10_000);
  const takeProfitPrice = side === "long"
    ? lastPrice * (1 + tpBps / 10_000)
    : lastPrice * (1 - tpBps / 10_000);

  const positionId = makePositionId({ strategy: "longer-tf", now, discriminator: symbol });
  const manageData: LongerTfManageJobData = {
    positionId, symbol, side,
    entryPrice: lastPrice,
    qty: qtyOut.qty,
    qtyStep: instrument.lotSizeFilter.qtyStep,
    minOrderQty: instrument.lotSizeFilter.minOrderQty,
    notionalUsd, leverage,
    openedAt: new Date(now).toISOString(),
    stopLossPrice, takeProfitPrice,
    entryReasoning: `longer-tf:${side}:${config.longerTfKlineInterval}m`,
    decisionsHistory: [{
      at: new Date(now).toISOString(),
      action: "enter", reasoning: `signal=${side}`,
    }],
    lastReviewAt: new Date(now).toISOString(),
  };

  await manageQueue.add(
    JOB_NAMES.longerTfManageTick, manageData,
    {
      ...STRATEGY_JOB_POLICY,
      jobId: positionId,
      repeat: { every: Math.max(5_000, config.pollMs) },
    },
  );

  log({
    ts: observedAt, event: "longer-tf-opened",
    positionId, symbol, side, qty: qtyOut.qty,
    entryPrice: lastPrice, notionalUsd, leverage,
    stopLossPrice, takeProfitPrice,
  });

  return {
    status: "opened",
    positionId, symbol, side, qty: qtyOut.qty,
    entryPrice: lastPrice, notionalUsd, leverage,
    stopLossPrice, takeProfitPrice,
  };
}
