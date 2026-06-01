import { describe, expect, test } from "bun:test";
import { createUniverseFetcher } from "./universe-fetcher";
import { DEFAULT_LIQUIDITY_CRITERIA } from "./pump-scanner";

const mkClient = (tickers: any[]) => ({
  async getTickers() { return tickers; },
} as any);

const t = (overrides: Partial<any> = {}) => ({
  symbol: "BTCUSDT",
  lastPrice: "73000",
  turnover24h: "50000000",
  bid1Price: "72998",
  ask1Price: "73002",
  ...overrides,
});

describe("createUniverseFetcher.fetchActive", () => {
  test("returns only symbols passing the liquidity gate", async () => {
    const u = createUniverseFetcher(mkClient([
      t({ symbol: "BTCUSDT", turnover24h: "50000000" }),
      t({ symbol: "TINYUSDT", turnover24h: "10000", bid1Price: "1.0", ask1Price: "1.05" }), // low turnover + wide spread
      t({ symbol: "ETHUSDT", turnover24h: "20000000", lastPrice: "3800", bid1Price: "3799.5", ask1Price: "3800.5" }),
    ]));
    const list = await u.fetchActive(DEFAULT_LIQUIDITY_CRITERIA);
    expect(list.map((e) => e.symbol).sort()).toEqual(["BTCUSDT", "ETHUSDT"]);
  });

  test("whitelist restricts to listed symbols", async () => {
    const u = createUniverseFetcher(
      mkClient([t({ symbol: "BTCUSDT" }), t({ symbol: "ETHUSDT", lastPrice: "3800", bid1Price: "3799.5", ask1Price: "3800.5" })]),
      { symbolWhitelist: ["BTCUSDT"] },
    );
    const list = await u.fetchActive(DEFAULT_LIQUIDITY_CRITERIA);
    expect(list).toHaveLength(1);
    expect(list[0]!.symbol).toBe("BTCUSDT");
  });

  test("blacklist excludes after whitelist", async () => {
    const u = createUniverseFetcher(
      mkClient([t({ symbol: "BTCUSDT" }), t({ symbol: "ETHUSDT", lastPrice: "3800", bid1Price: "3799.5", ask1Price: "3800.5" })]),
      { symbolBlacklist: ["BTCUSDT"] },
    );
    const list = await u.fetchActive(DEFAULT_LIQUIDITY_CRITERIA);
    expect(list.map((e) => e.symbol)).toEqual(["ETHUSDT"]);
  });

  test("adapts Bybit field names (lastPrice/bid1Price/ask1Price/turnover24h) to SymbolTickerSnapshot", async () => {
    const u = createUniverseFetcher(mkClient([t()]));
    const list = await u.fetchActive(DEFAULT_LIQUIDITY_CRITERIA);
    expect(list[0]!.ticker.lastPrice).toBe(73000);
    expect(list[0]!.ticker.turnover24hUsd).toBe(50_000_000);
    expect(list[0]!.ticker.bid1Price).toBe(72998);
  });

  test("skips entries with empty symbol", async () => {
    const u = createUniverseFetcher(mkClient([t({ symbol: "" }), t({ symbol: "BTCUSDT" })]));
    const list = await u.fetchActive(DEFAULT_LIQUIDITY_CRITERIA);
    expect(list.map((e) => e.symbol)).toEqual(["BTCUSDT"]);
  });
});
