import { describe, expect, it, mock } from "bun:test";
import type { MarketTicker } from "../src/index";
import type { SharedTickerCache } from "../src/ws-redis-cache";
import {
  type BybitClient,
  createCachedTickerSource,
  createRestTickerSource,
} from "../src/ticker-source";

function makeTicker(symbol: string, lastPrice = "100"): MarketTicker {
  return {
    symbol,
    lastPrice,
    markPrice: lastPrice,
    indexPrice: lastPrice,
    prevPrice1h: lastPrice,
    prevPrice24h: lastPrice,
    price24hPcnt: "0",
    turnover24h: "0",
    volume24h: "0",
    openInterestValue: "0",
    fundingRate: "0",
    nextFundingTime: "0",
    bid1Price: lastPrice,
    ask1Price: lastPrice,
    bid1Size: "1",
    ask1Size: "1",
  };
}

function fakeClient(ticker: MarketTicker): BybitClient {
  const getTicker = mock(async () => ticker);
  return { getTicker } as unknown as BybitClient;
}

function fakeCache(opts: {
  ticker?: MarketTicker | null;
  ageMs?: number | null;
}): SharedTickerCache {
  return {
    publishTicker: async () => {},
    getTicker: async () => opts.ticker ?? null,
    getAge: async () => opts.ageMs ?? null,
    subscribe: () => () => {},
    close: async () => {},
  };
}

describe("createRestTickerSource", () => {
  it("delegates to the underlying client", async () => {
    const ticker = makeTicker("BTCUSDT", "50000");
    const client = fakeClient(ticker);
    const src = createRestTickerSource(client);

    const got = await src.getTicker("BTCUSDT");
    expect(got).toEqual(ticker);
    expect((client.getTicker as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    expect((client.getTicker as ReturnType<typeof mock>).mock.calls[0]?.[0]).toEqual({
      category: "linear",
      symbol: "BTCUSDT",
    });
  });

  it("uses opts.category when provided", async () => {
    const ticker = makeTicker("BTCUSDT");
    const client = fakeClient(ticker);
    const src = createRestTickerSource(client);
    await src.getTicker("BTCUSDT", { category: "spot" });
    expect((client.getTicker as ReturnType<typeof mock>).mock.calls[0]?.[0]).toEqual({
      category: "spot",
      symbol: "BTCUSDT",
    });
  });

  it("peek returns last fetched ticker", async () => {
    const ticker = makeTicker("ETHUSDT", "3000");
    const src = createRestTickerSource(fakeClient(ticker));
    expect(src.peek("ETHUSDT")).toBeNull();
    await src.getTicker("ETHUSDT");
    expect(src.peek("ETHUSDT")).toEqual(ticker);
    expect(src.peek("ethusdt")).toEqual(ticker);
  });
});

describe("createCachedTickerSource", () => {
  it("returns fresh cached entry without REST call", async () => {
    const cached = makeTicker("BTCUSDT", "100");
    const fallbackTicker = makeTicker("BTCUSDT", "999");
    const fallback = fakeClient(fallbackTicker);
    const src = createCachedTickerSource({
      cache: fakeCache({ ticker: cached, ageMs: 1_000 }),
      fallback,
      defaultMaxAgeMs: 5_000,
    });
    const got = await src.getTicker("BTCUSDT");
    expect(got.lastPrice).toBe("100");
    expect((fallback.getTicker as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  it("falls back to REST when cached entry is stale", async () => {
    const cached = makeTicker("BTCUSDT", "100");
    const fresh = makeTicker("BTCUSDT", "200");
    const fallback = fakeClient(fresh);
    const src = createCachedTickerSource({
      cache: fakeCache({ ticker: cached, ageMs: 10_000 }),
      fallback,
      defaultMaxAgeMs: 5_000,
    });
    const got = await src.getTicker("BTCUSDT");
    expect(got.lastPrice).toBe("200");
    expect((fallback.getTicker as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  it("falls back to REST when cache is empty", async () => {
    const fresh = makeTicker("ADAUSDT", "0.5");
    const fallback = fakeClient(fresh);
    const src = createCachedTickerSource({
      cache: fakeCache({ ticker: null, ageMs: null }),
      fallback,
    });
    const got = await src.getTicker("ADAUSDT");
    expect(got).toEqual(fresh);
    expect((fallback.getTicker as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  it("peek returns null before any getTicker call", () => {
    const src = createCachedTickerSource({
      cache: fakeCache({}),
      fallback: fakeClient(makeTicker("X")),
    });
    expect(src.peek("BTCUSDT")).toBeNull();
  });

  it("logs stale-fallback warning at most once per minute per symbol", async () => {
    const cached = makeTicker("BTCUSDT");
    const fallback = fakeClient(cached);
    const warn = mock((_o: Record<string, unknown>) => {});
    const logger = { info: () => {}, warn };
    let t = 0;
    const src = createCachedTickerSource({
      cache: fakeCache({ ticker: cached, ageMs: 100_000 }),
      fallback,
      defaultMaxAgeMs: 5_000,
      logger,
      now: () => t,
    });
    await src.getTicker("BTCUSDT");
    await src.getTicker("BTCUSDT");
    expect(warn.mock.calls.length).toBe(1);
    t = 70_000;
    await src.getTicker("BTCUSDT");
    expect(warn.mock.calls.length).toBe(2);
  });

  it("respects per-call maxAgeMs override", async () => {
    const cached = makeTicker("BTCUSDT", "100");
    const fresh = makeTicker("BTCUSDT", "200");
    const fallback = fakeClient(fresh);
    const src = createCachedTickerSource({
      cache: fakeCache({ ticker: cached, ageMs: 3_000 }),
      fallback,
      defaultMaxAgeMs: 5_000,
    });
    // 3s age < default 5s → cache hit
    const a = await src.getTicker("BTCUSDT");
    expect(a.lastPrice).toBe("100");
    // override to 1s → treated as stale
    const b = await src.getTicker("BTCUSDT", { maxAgeMs: 1_000 });
    expect(b.lastPrice).toBe("200");
  });
});
