/**
 * bollinger-adx OPEN-DECISION processor (Phase 2 BullMQ migration).
 */

import {
  JOB_NAMES,
  STRATEGY_JOB_POLICY,
  type BollingerAdxManageJobData,
  type BollingerAdxOpenTickJobData,
} from "@ai-scalper/queueing";

import type { createBybitClient } from "@ai-scalper/bybit-client";
import type { TickerSource } from "@ai-scalper/bybit-client/ticker-source";
import type { TraderConfig } from "../config";
import type { WebhookAlerter } from "../alerts/webhook";
import { bollingerAdxDecide, type BollingerAdxKlineCache } from "./bollinger-adx";
import type { StrategySharedState } from "./shared/bullmq-shared-state";
import { computeQtyFromNotional, makePositionId } from "./shared/trade-job-helpers";

type BybitClient = ReturnType<typeof createBybitClient>;

export interface ManageQueueLike<TData> {
  add(name: string, data: TData, opts?: Record<string, unknown>): Promise<unknown>;
}

export interface BollingerAdxKlineCacheStore {
  get(symbol: string): BollingerAdxKlineCache | null;
  set(symbol: string, cache: BollingerAdxKlineCache): void;
}

export function createInMemoryBollingerAdxKlineCacheStore(): BollingerAdxKlineCacheStore {
  const m = new Map<string, BollingerAdxKlineCache>();
  return {
    get(symbol) { return m.get(symbol) ?? null; },
    set(symbol, cache) { m.set(symbol, cache); },
  };
}

export interface BollingerAdxOpenProcessorDeps {
  config: TraderConfig;
  client: BybitClient;
  tickerSource: TickerSource;
  alerter: WebhookAlerter;
  manageQueue: ManageQueueLike<BollingerAdxManageJobData>;
  sharedState: StrategySharedState;
  klineCacheStore: BollingerAdxKlineCacheStore;
  decideFn?: typeof bollingerAdxDecide;
  log?: (payload: Record<string, unknown>) => void;
  now?: () => number;
}

export type BollingerAdxOpenTickResult =
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
      regime: "ranging" | "trending" | "unknown";
    };

export async function processBollingerAdxOpenTick(
  _jobData: BollingerAdxOpenTickJobData,
  deps: BollingerAdxOpenProcessorDeps,
): Promise<BollingerAdxOpenTickResult> {
  const { config, client, tickerSource, alerter, manageQueue, sharedState, klineCacheStore } = deps;
  const decideFn = deps.decideFn ?? bollingerAdxDecide;
  const log = deps.log ?? ((p) => console.log(JSON.stringify(p)));
  const now = (deps.now ?? Date.now)();
  const observedAt = new Date(now).toISOString();
  const symbol = config.symbol;

  if (await sharedState.hasActivePosition()) {
    return { status: "skipped", reason: "active-position-exists" };
  }

  let lastPrice = 0;
  try {
    const t = await tickerSource.getTicker(symbol, { category: "linear" });
    lastPrice = Number(t.lastPrice);
  } catch (err) {
    log({
      ts: observedAt, event: "bollinger-adx-ticker-unavailable", symbol,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "skipped", reason: "ticker-unavailable" };
  }
  if (!Number.isFinite(lastPrice) || lastPrice <= 0) return { status: "skipped", reason: "ticker-invalid" };

  let cache = klineCacheStore.get(symbol);
  const cacheStale = (
    cache === null
    || cache.symbol !== symbol
    || (now - cache.fetchedAt) >= config.bollingerAdxKlineRefreshSec * 1000
  );
  if (cacheStale) {
    try {
      const raw = await client.getKlines({
        category: "linear", symbol,
        interval: config.bollingerAdxKlineInterval,
        limit: Math.max(config.bollingerAdxBbPeriod, config.bollingerAdxAdxPeriod) * 3 + 10,
      });
      // Bybit row: [start, open, high, low, close, volume, turnover]. Newest first.
      const list = ((raw as { list?: string[][] }).list ?? []).slice().reverse();
      const highs: number[] = []; const lows: number[] = []; const closes: number[] = [];
      for (const r of list) {
        const h = Number(r[2]); const l = Number(r[3]); const c = Number(r[4]);
        if (Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(c)) {
          highs.push(h); lows.push(l); closes.push(c);
        }
      }
      cache = { symbol, fetchedAt: now, highs, lows, closes };
      klineCacheStore.set(symbol, cache);
    } catch (err) {
      log({
        ts: observedAt, event: "bollinger-adx-klines-failed", symbol,
        error: err instanceof Error ? err.message : String(err),
      });
      return { status: "skipped", reason: "kline-refresh-failed" };
    }
  }

  const decision = decideFn({
    klineCache: cache, position: null, symbol,
    currentPrice: lastPrice, now,
    refreshSec: config.bollingerAdxKlineRefreshSec,
    bbPeriod: config.bollingerAdxBbPeriod,
    bbStdDev: config.bollingerAdxBbStdDev,
    adxPeriod: config.bollingerAdxAdxPeriod,
    adxRangingThreshold: config.bollingerAdxAdxRangingThreshold,
    adxTrendingThreshold: config.bollingerAdxAdxTrendingThreshold,
    stopLossBps: config.bollingerAdxStopLossBps,
    takeProfitBps: config.bollingerAdxTakeProfitBps,
  });
  if (decision.kind !== "enter") {
    return { status: "skipped", reason: `decide-${decision.kind}:${decision.reason}` };
  }

  let instrument;
  try {
    instrument = await client.getInstrumentInfo({ category: "linear", symbol });
  } catch (err) {
    log({
      ts: observedAt, event: "bollinger-adx-instrument-info-unavailable", symbol,
      error: err instanceof Error ? err.message : String(err),
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
    } catch { /* tolerate */ }
    try {
      await client.createOrder({
        category: "linear", symbol,
        side: decision.side === "long" ? "Buy" : "Sell",
        qty: qtyOut.qtyStr, orderType: "Market",
      });
    } catch (err) {
      log({
        ts: observedAt, event: "bollinger-adx-open-order-failed", symbol,
        error: err instanceof Error ? err.message : String(err),
      });
      await alerter.send(`bollinger-adx open order failed: ${symbol}`).catch(() => {});
      return { status: "skipped", reason: "open-order-failed" };
    }
  }

  const slBps = config.bollingerAdxStopLossBps;
  const tpBps = config.bollingerAdxTakeProfitBps;
  const stopLossPrice = decision.side === "long"
    ? lastPrice * (1 - slBps / 10_000)
    : lastPrice * (1 + slBps / 10_000);
  const takeProfitPrice = decision.side === "long"
    ? lastPrice * (1 + tpBps / 10_000)
    : lastPrice * (1 - tpBps / 10_000);

  const positionId = makePositionId({ strategy: "bollinger-adx", now, discriminator: symbol });
  const manageData: BollingerAdxManageJobData = {
    positionId, symbol, side: decision.side,
    entryPrice: lastPrice, qty: qtyOut.qty,
    qtyStep: instrument.lotSizeFilter.qtyStep,
    minOrderQty: instrument.lotSizeFilter.minOrderQty,
    notionalUsd, leverage,
    openedAt: new Date(now).toISOString(),
    stopLossPrice, takeProfitPrice,
    entryRegime: decision.regime,
    entryReasoning: decision.reason,
    decisionsHistory: [{
      at: new Date(now).toISOString(),
      action: "enter", reasoning: decision.reason,
    }],
    lastReviewAt: new Date(now).toISOString(),
  };

  await manageQueue.add(
    JOB_NAMES.bollingerAdxManageTick, manageData,
    { ...STRATEGY_JOB_POLICY, jobId: positionId, repeat: { every: Math.max(5_000, config.pollMs) } },
  );

  log({
    ts: observedAt, event: "bollinger-adx-opened",
    positionId, symbol, side: decision.side, qty: qtyOut.qty,
    entryPrice: lastPrice, notionalUsd, leverage, regime: decision.regime,
    stopLossPrice, takeProfitPrice,
  });

  return {
    status: "opened",
    positionId, symbol, side: decision.side,
    qty: qtyOut.qty, entryPrice: lastPrice, notionalUsd, leverage,
    stopLossPrice, takeProfitPrice, regime: decision.regime,
  };
}
