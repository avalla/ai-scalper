import { describe, expect, test } from "bun:test";
import { collectRecentEvents, summarizeKlines } from "./strategy-advisor-collectors";

const NOW = Date.parse("2026-06-08T10:00:00Z");

describe("collectRecentEvents", () => {
  test("returns empty when redis is null", async () => {
    const events = await collectRecentEvents(null, NOW);
    expect(events).toEqual([]);
  });

  test("returns empty when redis lacks zrangebyscore", async () => {
    const fakeRedis = { lrange: async () => [] } as never;
    const events = await collectRecentEvents(fakeRedis, NOW);
    expect(events).toEqual([]);
  });

  test("returns events with ageMinutes and sorted by signal priority", async () => {
    const t1 = new Date(NOW - 30 * 60_000).toISOString(); // 30 min ago, medium
    const t2 = new Date(NOW - 5 * 60_000).toISOString();  // 5 min ago, low
    const t3 = new Date(NOW - 90 * 60_000).toISOString(); // 90 min ago, high
    const fakeRedis = {
      lrange: async () => [],
      zrangebyscore: async () => [
        JSON.stringify({ source: "funding-extreme", signal: "medium", sentiment: "bullish", symbols: ["BTCUSDT"], title: "mid", observedAt: t1 }),
        JSON.stringify({ source: "bybit-announcement", signal: "low", sentiment: "neutral", symbols: [], title: "low", observedAt: t2 }),
        JSON.stringify({ source: "bybit-announcement", signal: "high", sentiment: "bullish", symbols: ["ETHUSDT"], title: "high old", observedAt: t3 }),
      ],
    } as never;
    const events = await collectRecentEvents(fakeRedis, NOW);
    expect(events).toHaveLength(3);
    // high event ranks first despite being older
    expect(events[0]!.signal).toBe("high");
    expect(events[0]!.ageMinutes).toBe(90);
    // remaining events: medium then low
    expect(events[1]!.signal).toBe("medium");
    expect(events[2]!.signal).toBe("low");
  });

  test("caps to max returned events", async () => {
    const items = Array.from({ length: 20 }, (_, i) => JSON.stringify({
      source: "funding-extreme", signal: "high", sentiment: "bullish",
      symbols: [`SYM${i}USDT`], title: `evt-${i}`,
      observedAt: new Date(NOW - i * 60_000).toISOString(),
    }));
    const fakeRedis = { lrange: async () => [], zrangebyscore: async () => items } as never;
    const events = await collectRecentEvents(fakeRedis, NOW);
    expect(events.length).toBeLessThanOrEqual(8);
  });

  test("skips malformed json gracefully", async () => {
    const valid = JSON.stringify({ source: "x", signal: "low", sentiment: "neutral", symbols: [], title: "ok", observedAt: new Date(NOW).toISOString() });
    const fakeRedis = {
      lrange: async () => [],
      zrangebyscore: async () => ["not json", valid, "{broken"],
    } as never;
    const events = await collectRecentEvents(fakeRedis, NOW);
    expect(events).toHaveLength(1);
    expect(events[0]!.title).toBe("ok");
  });
});

describe("summarizeKlines", () => {
  test("empty input → zeros", () => {
    const s = summarizeKlines([]);
    expect(s.barsSampled).toBe(0);
    expect(s.trendBps).toBe(0);
  });

  test("computes range/trend/volume correctly (newest-first input)", () => {
    // Bybit gives newest-first; oldest is index 2.
    // closes oldest→newest: 100, 110, 121 → +21% = +2100 bps
    const klines = [
      { highPrice: "125", lowPrice: "120", closePrice: "121", volume: "50" },
      { highPrice: "115", lowPrice: "108", closePrice: "110", volume: "20" },
      { highPrice: "105", lowPrice: "98", closePrice: "100", volume: "10" },
    ];
    const s = summarizeKlines(klines);
    expect(s.barsSampled).toBe(3);
    expect(s.rangeHigh).toBe(125);
    expect(s.rangeLow).toBe(98);
    expect(s.lastClose).toBe(121);
    expect(s.trendBps).toBeCloseTo(2100, 0);
    // Last vol 50 vs avg of prior 2 [10, 20] = 15 → ratio 3.33
    expect(s.volumeRatioVsAvg).toBeCloseTo(50 / 15, 5);
  });
});
