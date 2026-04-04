import { describe, expect, test } from "bun:test";
import { buildEntryExecutionPlan } from "./execution-policy";

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
