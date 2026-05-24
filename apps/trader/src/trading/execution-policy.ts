import type { InstrumentInfo, MarketTicker } from "@ai-scalper/bybit-client";
import type { TraderConfig } from "../config";

export type EntryExecutionMode =
  | "taker"
  | "maker-entry"
  | "maker-preferred-with-timeout"
  | "maker-only-aggressive";

export interface EntryExecutionPlan {
  limitPrice: number | null;
  mode: EntryExecutionMode;
  orderType: "Market" | "Limit";
  shouldFallbackToTaker: boolean;
  timeInForce?: "PostOnly";
}

function countDecimals(value: string): number {
  const parts = value.split(".");
  return parts[1]?.length ?? 0;
}

function toStep(value: string): number {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    throw new Error(`Invalid step value: ${value}`);
  }
  return numericValue;
}

function normalizePrice(params: {
  instrument: InstrumentInfo;
  price: number;
}): number {
  const tickSize = toStep(params.instrument.priceFilter.tickSize);
  const normalizedPrice = Math.round(params.price / tickSize) * tickSize;
  return Number(normalizedPrice.toFixed(countDecimals(params.instrument.priceFilter.tickSize)));
}

export function buildEntryExecutionPlan(params: {
  action: "long" | "short";
  config: TraderConfig;
  instrument: InstrumentInfo;
  ticker: MarketTicker;
}): EntryExecutionPlan {
  if (params.config.entryExecutionMode === "taker") {
    return {
      limitPrice: null,
      mode: "taker",
      orderType: "Market",
      shouldFallbackToTaker: false,
    };
  }

  const tickSize = toStep(params.instrument.priceFilter.tickSize);
  const bidPrice = Number(params.ticker.bid1Price);
  const askPrice = Number(params.ticker.ask1Price);

  // maker-only-aggressive: first attempt sits AT best bid (long) / best ask (short).
  // Subsequent retries are produced by `nextMakerOnlyAggressiveRetryPrice`.
  let rawMakerPrice: number;
  if (params.config.entryExecutionMode === "maker-only-aggressive") {
    rawMakerPrice = params.action === "long" ? bidPrice : askPrice;
  } else {
    rawMakerPrice = params.action === "long"
      ? bidPrice - (tickSize * params.config.entryMakerOffsetTicks)
      : askPrice + (tickSize * params.config.entryMakerOffsetTicks);
  }

  return {
    limitPrice: normalizePrice({
      instrument: params.instrument,
      price: rawMakerPrice,
    }),
    mode: params.config.entryExecutionMode,
    orderType: "Limit",
    shouldFallbackToTaker: params.config.entryExecutionMode === "maker-preferred-with-timeout",
    timeInForce: "PostOnly",
  };
}

/** Maker-only-aggressive: max number of retry attempts after the initial place. */
export const MAKER_ONLY_AGGRESSIVE_MAX_RETRIES = 3;

/**
 * Compute the next post-only retry price for `maker-only-aggressive`. Each
 * attempt moves one full tick closer to mid relative to the *previous*
 * attempt — so given initial best bid 100.0 and tickSize 0.1 the sequence is
 * 100.0 (initial) → 100.1 (attempt 1) → 100.2 (attempt 2) → 100.3 (attempt 3).
 *
 * Returns `null` when the attempt exceeds `MAKER_ONLY_AGGRESSIVE_MAX_RETRIES`
 * — caller must give up (no taker fallback) to preserve fee discipline.
 *
 * `basePrice` should be the limit price of the *previous* attempt (initial
 * best bid/ask for attempt=1, then the result of the previous call for
 * subsequent attempts).
 */
export function nextMakerOnlyAggressiveRetryPrice(params: {
  action: "long" | "short";
  attempt: number; // 1-based: the Nth retry after the initial place
  basePrice: number;
  instrument: InstrumentInfo;
}): number | null {
  if (params.attempt < 1 || params.attempt > MAKER_ONLY_AGGRESSIVE_MAX_RETRIES) {
    return null;
  }
  const tickSize = toStep(params.instrument.priceFilter.tickSize);
  // One full tick toward mid per attempt (per spec sample: 100.0 → 100.1 → 100.2).
  const raw = params.action === "long"
    ? params.basePrice + tickSize
    : params.basePrice - tickSize;
  return normalizePrice({ instrument: params.instrument, price: raw });
}
