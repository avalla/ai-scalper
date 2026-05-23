/**
 * Longer-timeframe MA crossover strategy (pure decision module — no I/O).
 *
 * Operates on Bybit 15-minute klines instead of 1-second tick prices. Larger
 * SL/TP magnitudes (50/150 bps default) make the 5-11 bps round-trip fee
 * structurally irrelevant.
 *
 * The caller fetches klines on demand (when `needs-refresh` is returned) and
 * supplies the close-price cache. This module remains pure for testability.
 */

import { buildSignal, type StrategySignal } from "@ai-scalper/trading-core";

export interface LongerTfKlineCache {
  symbol: string;
  /** Date.now() when the cache was last (re)populated. */
  fetchedAt: number;
  /** Most recent close last. Oldest first. */
  closePrices: number[];
}

export interface LongerTfSignalInput {
  cache: LongerTfKlineCache | null;
  now: number;
  refreshSec: number;
  symbol: string;
  fastWindow: number;
  slowWindow: number;
  thresholdBps: number;
}

export type LongerTfSignal = StrategySignal | "needs-refresh" | "warmup";

export function longerTfSignal(input: LongerTfSignalInput): LongerTfSignal {
  const stale =
    input.cache === null
    || input.cache.symbol !== input.symbol
    || (input.now - input.cache.fetchedAt) >= input.refreshSec * 1000;

  if (stale) {
    return "needs-refresh";
  }

  // After stale check we know cache is non-null.
  const cache = input.cache as LongerTfKlineCache;
  if (cache.closePrices.length < input.slowWindow) {
    return "warmup";
  }

  return buildSignal({
    prices: cache.closePrices,
    fastWindow: input.fastWindow,
    slowWindow: input.slowWindow,
    thresholdBps: input.thresholdBps,
  });
}
