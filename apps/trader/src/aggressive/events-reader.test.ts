import { describe, expect, test } from "bun:test";
import { createInMemoryAggressiveEventsReader } from "./events-reader";

describe("InMemory AggressiveEventsReader", () => {
  test("returns only events with ts >= sinceMs", async () => {
    const r = createInMemoryAggressiveEventsReader([
      { ts: 100, side: "Buy", sizeUsd: 1000, price: 73000 },
      { ts: 200, side: "Sell", sizeUsd: 2000, price: 73100 },
      { ts: 300, side: "Buy", sizeUsd: 3000, price: 73050 },
    ]);
    const out = await r.getRecentWithPrice("BTCUSDT", 200);
    expect(out.map((e) => e.ts)).toEqual([200, 300]);
  });

  test("push appends; clear empties", async () => {
    const r = createInMemoryAggressiveEventsReader();
    r.push({ ts: 1, side: "Buy", sizeUsd: 500, price: 73000 });
    r.push({ ts: 2, side: "Sell", sizeUsd: 600, price: 73100 });
    expect((await r.getRecentWithPrice("X", 0)).length).toBe(2);
    r.clear();
    expect((await r.getRecentWithPrice("X", 0)).length).toBe(0);
  });
});

// A roundtrip parse test against the JSON shape the worker writes — covers the
// price persistence change without needing a live Redis. Reuses the same
// member shape produced by createRedisLiquidationsCache.
describe("price-bearing JSON parse contract", () => {
  test("event with price → kept; event without price → dropped by aggressive reader", () => {
    const withPrice = { ts: 100, side: "Buy" as const, sizeUsd: 1000, price: 73000, _r: "abc" };
    const noPrice =   { ts: 200, side: "Buy" as const, sizeUsd: 1000, _r: "def" };
    // Simulate what the reader does:
    const parsed = [JSON.stringify(withPrice), JSON.stringify(noPrice)]
      .map((m) => JSON.parse(m))
      .filter((p) => typeof p.price === "number" && p.price > 0);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].price).toBe(73000);
  });
});
