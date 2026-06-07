import { describe, expect, test } from "bun:test";
import {
  classifyBybitAnnouncement, detectFundingExtremes, dedupEvents,
  type MarketEvent,
} from "./event-feeder";

const NOW = new Date("2026-06-07T14:00:00Z").toISOString();

describe("classifyBybitAnnouncement", () => {
  test("listing → high/bullish", () => {
    const e = classifyBybitAnnouncement({ title: "New Listing: PEPEUSDT Perpetual", url: "https://x" }, NOW);
    expect(e).not.toBeNull();
    expect(e!.signal).toBe("high");
    expect(e!.sentiment).toBe("bullish");
    expect(e!.symbols).toContain("PEPEUSDT");
  });

  test("delisting → high/bearish", () => {
    const e = classifyBybitAnnouncement({ title: "Delisting of XYZUSDT" }, NOW);
    expect(e!.signal).toBe("high");
    expect(e!.sentiment).toBe("bearish");
  });

  test("maintenance → medium/neutral", () => {
    const e = classifyBybitAnnouncement({ title: "System upgrade maintenance window" }, NOW);
    expect(e!.signal).toBe("medium");
    expect(e!.sentiment).toBe("neutral");
  });

  test("hack/exploit → high/bearish", () => {
    const e = classifyBybitAnnouncement({ title: "Security incident on ABCUSDT" }, NOW);
    expect(e!.signal).toBe("high");
    expect(e!.sentiment).toBe("bearish");
  });

  test("unclassifiable → null", () => {
    expect(classifyBybitAnnouncement({ title: "Happy New Year from Bybit" }, NOW)).toBeNull();
  });

  test("empty title → null", () => {
    expect(classifyBybitAnnouncement({ title: "" }, NOW)).toBeNull();
  });
});

describe("detectFundingExtremes", () => {
  test("flags symbols with abs funding > 30 bps", () => {
    const tickers = [
      { symbol: "BTCUSDT", fundingRate: "0.0050", turnover24h: "1000000" }, // +50 bps → high/bearish
      { symbol: "ETHUSDT", fundingRate: "-0.0035", turnover24h: "500000" }, // -35 bps → medium/bullish
      { symbol: "SOLUSDT", fundingRate: "0.0001", turnover24h: "100000" }, // +1 bp → ignore
    ];
    const events = detectFundingExtremes(tickers, NOW);
    expect(events).toHaveLength(2);
    expect(events.find((e) => e.symbols[0] === "BTCUSDT")?.signal).toBe("high");
    expect(events.find((e) => e.symbols[0] === "BTCUSDT")?.sentiment).toBe("bearish");
    expect(events.find((e) => e.symbols[0] === "ETHUSDT")?.signal).toBe("medium");
    expect(events.find((e) => e.symbols[0] === "ETHUSDT")?.sentiment).toBe("bullish");
  });

  test("respects topN by turnover", () => {
    const tickers = Array.from({ length: 30 }, (_, i) => ({
      symbol: `SYM${i}USDT`,
      fundingRate: "0.005",
      turnover24h: String(i * 1000),
    }));
    const events = detectFundingExtremes(tickers, NOW, { topN: 5 });
    expect(events).toHaveLength(5);
    expect(events[0]?.symbols[0]).toBe("SYM29USDT"); // top turnover
  });

  test("externalId buckets by 8h funding window — same symbol twice in window dedups", () => {
    const tickers = [{ symbol: "BTCUSDT", fundingRate: "0.005", turnover24h: "1000000" }];
    const e1 = detectFundingExtremes(tickers, new Date("2026-06-07T03:00:00Z").toISOString());
    const e2 = detectFundingExtremes(tickers, new Date("2026-06-07T05:00:00Z").toISOString());
    expect(e1[0]!.externalId).toBe(e2[0]!.externalId);
    const e3 = detectFundingExtremes(tickers, new Date("2026-06-07T09:00:00Z").toISOString());
    expect(e3[0]!.externalId).not.toBe(e1[0]!.externalId);
  });
});

describe("dedupEvents", () => {
  test("filters out repeated externalId", () => {
    const seen = new Set<string>();
    const a: MarketEvent = { source: "bybit-announcement", observedAt: NOW, signal: "high", sentiment: "bullish", symbols: [], title: "x", externalId: "id-1" };
    const b: MarketEvent = { ...a, externalId: "id-2" };
    expect(dedupEvents([a, b], seen)).toHaveLength(2);
    expect(dedupEvents([a, b], seen)).toHaveLength(0); // both seen now
  });
});
