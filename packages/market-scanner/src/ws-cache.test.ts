import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { MarketTicker } from "@ai-scalper/bybit-client";
import type { SharedTickerCache } from "@ai-scalper/bybit-client/ws-redis-cache";

// REST has a wide spread; cache has a tight spread. After ranking, the
// candidate's `spreadBps` lets us prove which source was used. Tight spread
// produces a higher `score` and lower `spreadBps`.
const REST_BID = "100.00";
const REST_ASK = "100.10";   // ~10 bps spread (passes scoreScalpCandidate gate)
const CACHE_BID = "100.10";
const CACHE_ASK = "100.11";  // ~1 bp spread

function makeTicker(symbol: string, bid: string, ask: string): MarketTicker {
  return {
    symbol,
    lastPrice: bid,
    markPrice: bid,
    indexPrice: bid,
    prevPrice1h: "99.5",
    prevPrice24h: "98",
    price24hPcnt: "0.02",
    turnover24h: "100000000",
    volume24h: "10000",
    openInterestValue: "50000000",
    fundingRate: "0.00005",
    nextFundingTime: "1700000000000",
    bid1Price: bid,
    ask1Price: ask,
    bid1Size: "100",
    ask1Size: "100",
  };
}

function makeInstrument(symbol: string) {
  return {
    symbol,
    leverageFilter: { minLeverage: "1", maxLeverage: "50", leverageStep: "1" },
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

function makeKline(close: number) {
  // Wide intra-bar range so minuteRangeBps clears the netEdge floor.
  return {
    startTime: String(Date.now()),
    openPrice: String(close * 0.997),
    highPrice: String(close * 1.005),
    lowPrice: String(close * 0.995),
    closePrice: String(close),
    volume: "10",
    turnover: "1000",
  };
}

beforeAll(() => {
  mock.module("@ai-scalper/bybit-client", () => ({
    createBybitClient: () => ({
      async getTickers() {
        return [makeTicker("BTCUSDT", REST_BID, REST_ASK)];
      },
      async getInstrumentInfo(req: { symbol: string }) {
        return makeInstrument(req.symbol);
      },
      async getKlines() {
        return Array.from({ length: 15 }, (_, i) => makeKline(100 + i * 0.1));
      },
    }),
  }));
});

afterAll(() => {
  mock.restore();
});

function fakeCache(opts: { age: number | null; ticker: MarketTicker | null }): SharedTickerCache {
  return {
    async publishTicker() {},
    async getAge() { return opts.age; },
    async getTicker() { return opts.ticker; },
    subscribe() { return () => {}; },
    async close() {},
  };
}

const baseConfig = {
  category: "linear",
  scanLimit: 10,
  scanPrefilterLimit: 25,
  scanKlineInterval: "1",
  scanKlineLimit: 15,
  scanSignalThresholdBps: 3,
  scanOutputDir: "apps/trader/data",
  scanBaseUrl: "https://example",
  scanTakerFeeBps: 0,
  scanEstimatedSlippageBps: 0,
  scanMinNetEdgeBps: 0,
  scanMaxFundingBps: 100,
  scanMinOpenInterestUsd: 0,
  scanMinListingAgeDays: 0,
};

describe("scanner WS PoC integration", () => {
  test("uses cached ticker bid/ask when cache is fresh (tight spread → lower spreadBps)", async () => {
    const { rankTradeSetups } = await import("./index");
    const cached = makeTicker("BTCUSDT", CACHE_BID, CACHE_ASK);
    const ranked = await rankTradeSetups(
      { ...baseConfig, useWebSocket: true, cacheMaxAgeMs: 30_000 },
      fakeCache({ age: 1_000, ticker: cached }),
    );
    const btc = ranked.find((r) => r.symbol === "BTCUSDT");
    expect(btc).toBeDefined();
    // Cache ~1 bp spread should be < REST 20 bps spread.
    expect(btc!.spreadBps).toBeLessThan(5);
  });

  test("falls back to REST when cache is stale (REST wide spread persists)", async () => {
    const { rankTradeSetups } = await import("./index");
    const cached = makeTicker("BTCUSDT", CACHE_BID, CACHE_ASK);
    const ranked = await rankTradeSetups(
      { ...baseConfig, useWebSocket: true, cacheMaxAgeMs: 30_000 },
      fakeCache({ age: 60_000, ticker: cached }),
    );
    const btc = ranked.find((r) => r.symbol === "BTCUSDT");
    expect(btc).toBeDefined();
    expect(btc!.spreadBps).toBeGreaterThan(5);
  });

  test("ignores cache entirely when useWebSocket=false (REST spread preserved)", async () => {
    const { rankTradeSetups } = await import("./index");
    const cached = makeTicker("BTCUSDT", CACHE_BID, CACHE_ASK);
    const ranked = await rankTradeSetups(
      { ...baseConfig, useWebSocket: false },
      fakeCache({ age: 1_000, ticker: cached }),
    );
    const btc = ranked.find((r) => r.symbol === "BTCUSDT");
    expect(btc).toBeDefined();
    expect(btc!.spreadBps).toBeGreaterThan(5);
  });

  test("falls back to REST when cache returns null (no override)", async () => {
    const { rankTradeSetups } = await import("./index");
    const ranked = await rankTradeSetups(
      { ...baseConfig, useWebSocket: true },
      fakeCache({ age: null, ticker: null }),
    );
    const btc = ranked.find((r) => r.symbol === "BTCUSDT");
    expect(btc).toBeDefined();
    expect(btc!.spreadBps).toBeGreaterThan(5);
  });
});
