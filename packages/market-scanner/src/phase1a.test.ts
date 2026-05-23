import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { autoTuneSetupGate, computeScanPercentiles, percentile } from "./index";

describe("autoTuneSetupGate", () => {
  test("empty history returns fallback", () => {
    expect(autoTuneSetupGate({ scanHistory: [], targetPercentile: 75, fallbackBps: 12 })).toBe(12);
  });

  test("populated history returns median of selected percentile", () => {
    const history = [
      { ts: "1", netEdgeBpsPercentiles: { p50: 5, p75: 10, p90: 15 } },
      { ts: "2", netEdgeBpsPercentiles: { p50: 7, p75: 14, p90: 20 } },
      { ts: "3", netEdgeBpsPercentiles: { p50: 9, p75: 18, p90: 25 } },
    ];
    expect(autoTuneSetupGate({ scanHistory: history, targetPercentile: 75, fallbackBps: 0 })).toBe(14);
  });

  test("computeScanPercentiles yields expected percentiles", () => {
    const p = computeScanPercentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(p.p50).toBeCloseTo(5.5, 5);
    expect(p.p75).toBeCloseTo(7.75, 5);
    expect(p.p90).toBeCloseTo(9.1, 5);
  });

  test("percentile helper interpolates", () => {
    expect(percentile([0, 10], 50)).toBeCloseTo(5, 5);
  });
});

// ---------- symbol-quality filters via mocked bybit-client ----------

function makeTicker(symbol: string, overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    symbol,
    lastPrice: "100",
    markPrice: "100",
    indexPrice: "100",
    prevPrice1h: "99",
    prevPrice24h: "98",
    price24hPcnt: "0.02",
    turnover24h: "10000000",
    volume24h: "10000",
    openInterestValue: "5000000",
    fundingRate: "0.0001",
    nextFundingTime: "0",
    bid1Price: "99.95",
    ask1Price: "100.05",
    bid1Size: "1",
    ask1Size: "1",
    ...overrides,
  };
}

function makeInstrument(symbol: string): Record<string, unknown> {
  return {
    symbol,
    leverageFilter: { minLeverage: "1", maxLeverage: "50", leverageStep: "0.01" },
    lotSizeFilter: {
      minNotionalValue: "1",
      maxOrderQty: "1000",
      maxMktOrderQty: "1000",
      minOrderQty: "0.001",
      qtyStep: "0.001",
    },
    priceFilter: { minPrice: "0.01", maxPrice: "1000000", tickSize: "0.01" },
  };
}

function makeKline(close: number): Record<string, string> {
  return {
    startTime: "1000",
    openPrice: String(close - 0.5),
    highPrice: String(close + 0.5),
    lowPrice: String(close - 0.5),
    closePrice: String(close),
    volume: "10",
    turnover: "1000",
  };
}

// Per-symbol kline route tables for the mock client.
let dailyKlineLimits: Record<string, number> = {};
let intradayKlines: Record<string, ReturnType<typeof makeKline>[]> = {};
let tickerList: Record<string, string>[] = [];

beforeAll(() => {
  mock.module("@ai-scalper/bybit-client", () => ({
    createBybitClient: () => ({
      async getTickers() {
        return tickerList;
      },
      async getInstrumentInfo(req: { symbol: string }) {
        return makeInstrument(req.symbol);
      },
      async getKlines(req: { symbol: string; interval: string }) {
        if (req.interval === "D") {
          const count = dailyKlineLimits[req.symbol] ?? 0;
          return Array.from({ length: count }, () => makeKline(100));
        }
        return intradayKlines[req.symbol] ?? Array.from({ length: 15 }, () => makeKline(100 + Math.random()));
      },
    }),
  }));
});

afterAll(() => {
  mock.restore();
});

describe("scanner symbol-quality filters", () => {
  test("symbol with too-low open interest is filtered before scoring", async () => {
    tickerList = [
      makeTicker("LOWOI_USDT", { openInterestValue: "1000" }), // too low
    ];
    intradayKlines = {
      LOWOI_USDT: Array.from({ length: 15 }, (_, i) => makeKline(100 + i * 0.05)),
    };
    dailyKlineLimits = { LOWOI_USDT: 100 };

    const { rankTradeSetups } = await import("./index");
    const ranked = await rankTradeSetups({
      category: "linear",
      scanLimit: 10,
      scanPrefilterLimit: 25,
      scanKlineInterval: "1",
      scanKlineLimit: 15,
      scanSignalThresholdBps: 3,
      scanOutputDir: "apps/trader/data",
      scanBaseUrl: "https://example",
      scanTakerFeeBps: 5.5,
      scanEstimatedSlippageBps: 4,
      scanMinNetEdgeBps: 0,
      scanMaxFundingBps: 100,
      scanMinOpenInterestUsd: 10_000_000,
      scanMinListingAgeDays: 0,
    });
    expect(ranked.find((r) => r.symbol === "LOWOI_USDT")).toBeUndefined();
  });

  test("symbol with insufficient daily-kline history is filtered", async () => {
    tickerList = [makeTicker("NEW_USDT")];
    intradayKlines = {
      NEW_USDT: Array.from({ length: 15 }, (_, i) => makeKline(100 + i * 0.05)),
    };
    dailyKlineLimits = { NEW_USDT: 3 }; // only 3 days of history

    const { rankTradeSetups } = await import("./index");
    const ranked = await rankTradeSetups({
      category: "linear",
      scanLimit: 10,
      scanPrefilterLimit: 25,
      scanKlineInterval: "1",
      scanKlineLimit: 15,
      scanSignalThresholdBps: 3,
      scanOutputDir: "apps/trader/data",
      scanBaseUrl: "https://example",
      scanTakerFeeBps: 5.5,
      scanEstimatedSlippageBps: 4,
      scanMinNetEdgeBps: 0,
      scanMaxFundingBps: 100,
      scanMinOpenInterestUsd: 0,
      scanMinListingAgeDays: 30,
    });
    expect(ranked.find((r) => r.symbol === "NEW_USDT")).toBeUndefined();
  });
});
