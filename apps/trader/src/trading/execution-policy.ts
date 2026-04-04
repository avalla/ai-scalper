import type { InstrumentInfo, MarketTicker } from "@ai-scalper/bybit-client";
import type { TraderConfig } from "../config";

export type EntryExecutionMode = "taker" | "maker-entry" | "maker-preferred-with-timeout";

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
  const rawMakerPrice = params.action === "long"
    ? bidPrice - (tickSize * params.config.entryMakerOffsetTicks)
    : askPrice + (tickSize * params.config.entryMakerOffsetTicks);

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
