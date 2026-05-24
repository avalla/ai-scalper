/**
 * ma-crossover OPEN-DECISION processor (Phase 2 BullMQ migration).
 *
 * Per-tick flow:
 *   1. Skip if active position exists (1-position invariant).
 *   2. Load allocator state from Redis (or initialize).
 *   3. Build the variant pool from config; pick a champion via the existing
 *      pure `selectChampion`. Persist the advanced round-robin cursor.
 *   4. Fetch ticker + accumulate price history for the configured symbol
 *      (kept in an in-memory store; not persisted, matches legacy behavior).
 *   5. Build signal using the CHAMPION's MA params. Skip on flat / warmup.
 *   6. Open position, set SL/TP derived from champion params, enqueue manage
 *      job tagged with championId + champion params snapshot.
 *
 * Scope-down vs. spec:
 *   - The per-variant `step()` shadow execution (paper-mode performance
 *     attribution across all variants) is INTENTIONALLY NOT moved into the
 *     open-processor. The legacy `run-trader.ts` keeps doing it when
 *     `maCrossoverUseBullmqJobs === false`. In BullMQ mode the bandit only
 *     learns from the champion's actual trades. This is documented in
 *     ROADMAP.md.
 *   - Multi-symbol rotation / scanner-driven symbol selection is simplified
 *     to "use config.symbol" in Phase 2. The legacy in-process loop's
 *     scanner gating remains the canonical path until Phase 3.
 */

import {
  JOB_NAMES, STRATEGY_JOB_POLICY,
  type MaCrossoverManageJobData, type MaCrossoverOpenTickJobData,
} from "@ai-scalper/queueing";

import type { createBybitClient } from "@ai-scalper/bybit-client";
import type { TickerSource } from "@ai-scalper/bybit-client/ticker-source";
import type { TraderConfig } from "../config";
import type { WebhookAlerter } from "../alerts/webhook";
import { buildSignal } from "@ai-scalper/trading-core";
import type { StrategySharedState } from "./shared/bullmq-shared-state";
import { computeQtyFromNotional, makePositionId } from "./shared/trade-job-helpers";
import {
  emptyAllocatorState,
  selectChampion,
  type AllocatorState,
} from "../meta/allocator";
import { defaultVariantPool, type Variant } from "../meta/variant-pool";
import type { AllocatorStore } from "./shared/allocator-redis";

type BybitClient = ReturnType<typeof createBybitClient>;

export interface ManageQueueLike<TData> {
  add(name: string, data: TData, opts?: Record<string, unknown>): Promise<unknown>;
}

export interface PriceHistoryStore {
  get(symbol: string): number[];
  push(symbol: string, price: number, cap: number): void;
}

export function createInMemoryPriceHistoryStore(): PriceHistoryStore {
  const m = new Map<string, number[]>();
  return {
    get(symbol) { return m.get(symbol) ?? []; },
    push(symbol, price, cap) {
      const arr = m.get(symbol) ?? [];
      arr.push(price);
      while (arr.length > cap) arr.shift();
      m.set(symbol, arr);
    },
  };
}

export interface MaCrossoverOpenProcessorDeps {
  config: TraderConfig;
  client: BybitClient;
  tickerSource: TickerSource;
  alerter: WebhookAlerter;
  manageQueue: ManageQueueLike<MaCrossoverManageJobData>;
  sharedState: StrategySharedState;
  allocatorStore: AllocatorStore;
  priceHistoryStore: PriceHistoryStore;
  /** Override the variant pool source (tests). */
  variantPoolFn?: (config: TraderConfig) => Variant[];
  /** Override the champion selector (tests). */
  selectChampionFn?: typeof selectChampion;
  /** Override the signal fn (tests). */
  buildSignalFn?: typeof buildSignal;
  log?: (payload: Record<string, unknown>) => void;
  now?: () => number;
  rng?: () => number;
}

export type MaCrossoverOpenTickResult =
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
      championIdAtEntry: string;
      stopLossPrice: number;
      takeProfitPrice: number;
    };

export async function processMaCrossoverOpenTick(
  _jobData: MaCrossoverOpenTickJobData,
  deps: MaCrossoverOpenProcessorDeps,
): Promise<MaCrossoverOpenTickResult> {
  const { config, client, tickerSource, alerter, manageQueue, sharedState, allocatorStore, priceHistoryStore } = deps;
  const variantPoolFn = deps.variantPoolFn ?? defaultVariantPool;
  const selectChampionFn = deps.selectChampionFn ?? selectChampion;
  const buildSignalFn = deps.buildSignalFn ?? buildSignal;
  const log = deps.log ?? ((p) => console.log(JSON.stringify(p)));
  const now = (deps.now ?? Date.now)();
  const observedAt = new Date(now).toISOString();
  const symbol = config.symbol;

  if (await sharedState.hasActivePosition()) {
    return { status: "skipped", reason: "active-position-exists" };
  }

  // (2) Load allocator state.
  let allocator: AllocatorState = (await allocatorStore.load()) ?? emptyAllocatorState();

  // (3) Variant pool + champion selection.
  const pool = variantPoolFn(config);
  if (pool.length === 0) {
    return { status: "skipped", reason: "empty-variant-pool" };
  }
  const sel = selectChampionFn({
    allocator, variants: pool, now,
    warmupMinTrades: config.metaWarmupMinTrades,
    rng: deps.rng,
    halfLifeDays: config.bandit_halfLifeDays,
  });
  if (sel.allocator) {
    allocator = sel.allocator;
    await allocatorStore.save(allocator);
  }
  const champion = pool.find((v) => v.id === sel.championId);
  if (!champion) {
    return { status: "skipped", reason: "champion-not-in-pool" };
  }
  // Symbol-filter check (matches the bandit metadata contract).
  if (champion.symbolFilter && !champion.symbolFilter.includes(symbol)) {
    return { status: "skipped", reason: `champion-symbol-filtered:${champion.id}` };
  }

  // (4) Fetch ticker + accumulate price history.
  let lastPrice = 0;
  try {
    const t = await tickerSource.getTicker(symbol, { category: "linear" });
    lastPrice = Number(t.lastPrice);
  } catch (err) {
    log({
      ts: observedAt, event: "ma-crossover-ticker-unavailable",
      symbol, error: err instanceof Error ? err.message : String(err),
    });
    return { status: "skipped", reason: "ticker-unavailable" };
  }
  if (!Number.isFinite(lastPrice) || lastPrice <= 0) return { status: "skipped", reason: "ticker-invalid" };
  priceHistoryStore.push(symbol, lastPrice, Math.max(champion.params.slowWindow * 4, 100));
  const history = priceHistoryStore.get(symbol);

  // (5) Compute signal using champion params.
  if (history.length < champion.params.slowWindow) {
    return { status: "skipped", reason: "warmup" };
  }
  const signal = buildSignalFn({
    prices: history,
    fastWindow: champion.params.fastWindow,
    slowWindow: champion.params.slowWindow,
    thresholdBps: champion.params.thresholdBps,
  });
  if (signal === "flat") {
    return { status: "skipped", reason: "signal-flat" };
  }
  const side: "long" | "short" = signal === "long" ? "long" : "short";

  // (6) Instrument info + qty.
  let instrument;
  try {
    instrument = await client.getInstrumentInfo({ category: "linear", symbol });
  } catch (err) {
    log({
      ts: observedAt, event: "ma-crossover-instrument-info-unavailable",
      symbol, error: err instanceof Error ? err.message : String(err),
    });
    return { status: "skipped", reason: "instrument-info-unavailable" };
  }

  const leverage = Math.max(1, champion.params.leverage ?? config.leverage);
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
        side: side === "long" ? "Buy" : "Sell",
        qty: qtyOut.qtyStr, orderType: "Market",
      });
    } catch (err) {
      log({
        ts: observedAt, event: "ma-crossover-open-order-failed",
        symbol, error: err instanceof Error ? err.message : String(err),
      });
      await alerter.send(`ma-crossover open order failed: ${symbol}`).catch(() => {});
      return { status: "skipped", reason: "open-order-failed" };
    }
  }

  const slBps = champion.params.stopLossBps;
  const tpBps = champion.params.takeProfitBps;
  const stopLossPrice = side === "long"
    ? lastPrice * (1 - slBps / 10_000)
    : lastPrice * (1 + slBps / 10_000);
  const takeProfitPrice = side === "long"
    ? lastPrice * (1 + tpBps / 10_000)
    : lastPrice * (1 - tpBps / 10_000);

  const positionId = makePositionId({ strategy: "ma-crossover", now, discriminator: symbol });
  const manageData: MaCrossoverManageJobData = {
    positionId, symbol, side,
    entryPrice: lastPrice, qty: qtyOut.qty,
    qtyStep: instrument.lotSizeFilter.qtyStep,
    minOrderQty: instrument.lotSizeFilter.minOrderQty,
    notionalUsd, leverage,
    openedAt: new Date(now).toISOString(),
    championIdAtEntry: champion.id,
    championParams: {
      fastWindow: champion.params.fastWindow,
      slowWindow: champion.params.slowWindow,
      thresholdBps: champion.params.thresholdBps,
      stopLossBps: champion.params.stopLossBps,
      takeProfitBps: champion.params.takeProfitBps,
    },
    stopLossPrice, takeProfitPrice,
    entryReasoning: `ma-crossover:${side}:champion=${champion.id}:reason=${sel.reason}`,
    decisionsHistory: [{
      at: new Date(now).toISOString(),
      action: "enter", reasoning: `signal=${side}:champion=${champion.id}`,
    }],
    lastReviewAt: new Date(now).toISOString(),
  };

  await manageQueue.add(
    JOB_NAMES.maCrossoverManageTick, manageData,
    { ...STRATEGY_JOB_POLICY, jobId: positionId, repeat: { every: Math.max(5_000, config.pollMs) } },
  );

  log({
    ts: observedAt, event: "ma-crossover-opened",
    positionId, symbol, side, qty: qtyOut.qty,
    entryPrice: lastPrice, notionalUsd, leverage,
    championIdAtEntry: champion.id, championReason: sel.reason,
    stopLossPrice, takeProfitPrice,
  });

  return {
    status: "opened",
    positionId, symbol, side, qty: qtyOut.qty,
    entryPrice: lastPrice, notionalUsd, leverage,
    championIdAtEntry: champion.id,
    stopLossPrice, takeProfitPrice,
  };
}
