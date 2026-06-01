import { describe, expect, test } from "bun:test";
import { createInMemoryDailyStateStore } from "./daily-state";
import { createInMemoryEquityTracker, createPaperEquityTracker } from "./equity-tracker";

describe("InMemory DailyStateStore", () => {
  test("first call seeds dayStartEquity; subsequent calls return same", async () => {
    const store = createInMemoryDailyStateStore();
    const a = await store.getOrInitDay(500);
    expect(a).toEqual({ dayStartEquityUsd: 500, dailyRealizedPnlUsd: 0, tradesToday: 0 });
    const b = await store.getOrInitDay(999);
    expect(b.dayStartEquityUsd).toBe(500); // does not re-seed
  });

  test("recordTradeOpened bumps the count", async () => {
    const store = createInMemoryDailyStateStore();
    await store.getOrInitDay(500);
    await store.recordTradeOpened();
    await store.recordTradeOpened();
    const s = await store.getOrInitDay(500);
    expect(s.tradesToday).toBe(2);
  });

  test("recordClosedPnl accumulates signed net", async () => {
    const store = createInMemoryDailyStateStore();
    await store.recordClosedPnl(+1.5);
    await store.recordClosedPnl(-0.3);
    const s = await store.getOrInitDay(100);
    expect(s.dailyRealizedPnlUsd).toBeCloseTo(1.2, 6);
  });

  test("day rollover: date change → fresh state", async () => {
    let day = new Date("2026-06-01T10:00:00Z");
    const store = createInMemoryDailyStateStore({ now: () => day });
    await store.getOrInitDay(500);
    await store.recordTradeOpened();
    await store.recordClosedPnl(-100);
    day = new Date("2026-06-02T10:00:00Z");
    const s = await store.getOrInitDay(400);
    expect(s.tradesToday).toBe(0);
    expect(s.dailyRealizedPnlUsd).toBe(0);
    expect(s.dayStartEquityUsd).toBe(400);
  });

  test("buildGuardState merges currentEquity with daily snapshot", async () => {
    const store = createInMemoryDailyStateStore();
    await store.recordClosedPnl(-50);
    await store.recordTradeOpened();
    const g = await store.buildGuardState(450);
    expect(g.currentEquityUsd).toBe(450);
    expect(g.dailyRealizedPnlUsd).toBe(-50);
    expect(g.tradesToday).toBe(1);
  });
});

describe("EquityTracker paper", () => {
  test("equity = starting + sum(realizedPnlUsd) from ledger", async () => {
    const ledger = {
      async lrange() {
        return [
          JSON.stringify({ realizedPnlUsd: 1.5 }),
          JSON.stringify({ realizedPnlUsd: -0.3 }),
          "{}",                          // missing field — ignored
          "{ not json",                  // malformed — ignored
        ];
      },
    };
    const t = createPaperEquityTracker(ledger, { startingEquityUsd: 100 });
    expect(await t.getCurrentEquityUsd()).toBeCloseTo(101.2, 6);
  });

  test("InMemory tracker is controllable", async () => {
    const t = createInMemoryEquityTracker(500);
    expect(await t.getCurrentEquityUsd()).toBe(500);
    t.set(800);
    expect(await t.getCurrentEquityUsd()).toBe(800);
  });
});
