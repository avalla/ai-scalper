import { describe, expect, test } from "bun:test";
import {
  MAKER_ONLY_AGGRESSIVE_MAX_RETRIES,
  buildEntryExecutionPlan,
  nextMakerOnlyAggressiveRetryPrice,
} from "./execution-policy";

const instrument = {
  symbol: "BTCUSDT",
  leverageFilter: {
    minLeverage: "1",
    maxLeverage: "100",
    leverageStep: "0.01",
  },
  lotSizeFilter: {
    minNotionalValue: "5",
    maxOrderQty: "1000",
    maxMktOrderQty: "1000",
    minOrderQty: "0.001",
    qtyStep: "0.001",
  },
  priceFilter: {
    minPrice: "1",
    maxPrice: "1000000",
    tickSize: "0.1",
  },
};

const ticker = {
  symbol: "BTCUSDT",
  lastPrice: "70000",
  markPrice: "70000",
  indexPrice: "70000",
  prevPrice1h: "69800",
  prevPrice24h: "69000",
  price24hPcnt: "0.01",
  turnover24h: "1000000000",
  volume24h: "10000",
  openInterestValue: "500000000",
  fundingRate: "0.0001",
  nextFundingTime: "0",
  bid1Price: "69999.8",
  ask1Price: "70000.0",
  bid1Size: "10",
  ask1Size: "12",
};

describe("buildEntryExecutionPlan", () => {
  test("uses market orders in taker mode", () => {
    expect(buildEntryExecutionPlan({
      action: "long",
      config: {
        entryExecutionMode: "taker",
        entryMakerOffsetTicks: 0,
      } as never,
      instrument,
      ticker,
    })).toEqual({
      limitPrice: null,
      mode: "taker",
      orderType: "Market",
      shouldFallbackToTaker: false,
    });
  });

  test("uses post-only maker price for long entries", () => {
    expect(buildEntryExecutionPlan({
      action: "long",
      config: {
        entryExecutionMode: "maker-entry",
        entryMakerOffsetTicks: 1,
      } as never,
      instrument,
      ticker,
    })).toEqual({
      limitPrice: 69999.7,
      mode: "maker-entry",
      orderType: "Limit",
      shouldFallbackToTaker: false,
      timeInForce: "PostOnly",
    });
  });

  test("maker-only-aggressive places post-only AT best bid for long", () => {
    expect(buildEntryExecutionPlan({
      action: "long",
      config: {
        entryExecutionMode: "maker-only-aggressive",
        entryMakerOffsetTicks: 0,
      } as never,
      instrument,
      ticker,
    })).toEqual({
      limitPrice: 69999.8,
      mode: "maker-only-aggressive",
      orderType: "Limit",
      shouldFallbackToTaker: false,
      timeInForce: "PostOnly",
    });
  });

  test("maker-only-aggressive places post-only AT best ask for short", () => {
    expect(buildEntryExecutionPlan({
      action: "short",
      config: {
        entryExecutionMode: "maker-only-aggressive",
        entryMakerOffsetTicks: 0,
      } as never,
      instrument,
      ticker,
    })).toEqual({
      limitPrice: 70000,
      mode: "maker-only-aggressive",
      orderType: "Limit",
      shouldFallbackToTaker: false,
      timeInForce: "PostOnly",
    });
  });

  test("enables taker fallback for maker-preferred mode", () => {
    expect(buildEntryExecutionPlan({
      action: "short",
      config: {
        entryExecutionMode: "maker-preferred-with-timeout",
        entryMakerOffsetTicks: 0,
      } as never,
      instrument,
      ticker,
    })).toEqual({
      limitPrice: 70000,
      mode: "maker-preferred-with-timeout",
      orderType: "Limit",
      shouldFallbackToTaker: true,
      timeInForce: "PostOnly",
    });
  });
});

describe("nextMakerOnlyAggressiveRetryPrice", () => {
  test("long retries escalate price toward mid by 1 tick per attempt", () => {
    // tickSize 0.1; start at best bid 100.0
    const a1 = nextMakerOnlyAggressiveRetryPrice({
      action: "long",
      attempt: 1,
      basePrice: 100.0,
      instrument,
    });
    expect(a1).toBe(100.1);
    const a2 = nextMakerOnlyAggressiveRetryPrice({
      action: "long",
      attempt: 2,
      basePrice: a1 ?? 0,
      instrument,
    });
    expect(a2).toBe(100.2);
    const a3 = nextMakerOnlyAggressiveRetryPrice({
      action: "long",
      attempt: 3,
      basePrice: a2 ?? 0,
      instrument,
    });
    expect(a3).toBe(100.3);
  });

  test("short retries escalate price toward mid (downward)", () => {
    const a1 = nextMakerOnlyAggressiveRetryPrice({
      action: "short",
      attempt: 1,
      basePrice: 100.5,
      instrument,
    });
    expect(a1).toBe(100.4);
  });

  test("returns null after MAKER_ONLY_AGGRESSIVE_MAX_RETRIES (no taker fallback)", () => {
    expect(MAKER_ONLY_AGGRESSIVE_MAX_RETRIES).toBe(3);
    expect(nextMakerOnlyAggressiveRetryPrice({
      action: "long",
      attempt: 4,
      basePrice: 100,
      instrument,
    })).toBeNull();
    expect(nextMakerOnlyAggressiveRetryPrice({
      action: "long",
      attempt: 0,
      basePrice: 100,
      instrument,
    })).toBeNull();
  });

  test("respects instrument tickSize when normalizing", () => {
    const coarseInstrument = {
      ...instrument,
      priceFilter: { ...instrument.priceFilter, tickSize: "0.5" },
    };
    expect(nextMakerOnlyAggressiveRetryPrice({
      action: "long",
      attempt: 1,
      basePrice: 100,
      instrument: coarseInstrument,
    })).toBe(100.5);
    expect(nextMakerOnlyAggressiveRetryPrice({
      action: "short",
      attempt: 1,
      basePrice: 100,
      instrument: coarseInstrument,
    })).toBe(99.5);
  });
});
