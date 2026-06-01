import { describe, expect, test } from "bun:test";
import {
  DEFAULT_AGGRESSIVE_GUARDS,
  dailyLossCapGuard,
  maxTradesPerDayGuard,
  runAggressiveGuards,
  shouldHardStop,
  shouldTakeProfit,
  totalCapitalCapGuard,
} from "./guards";
import type {
  AggressiveGuardLimits,
  AggressiveGuardState,
  AggressiveIntent,
} from "./types";

const baseState: AggressiveGuardState = {
  dailyRealizedPnlUsd: 0,
  dayStartEquityUsd: 500,
  tradesToday: 0,
  currentEquityUsd: 500,
};

const baseLimits: AggressiveGuardLimits = {
  dailyLossCapFraction: 0.5,
  maxTradesPerDay: 10,
  maxTotalCapitalUsd: 1000,
};

const enter: AggressiveIntent = {
  kind: "enter", side: "long", notionalUsd: 100, leverage: 10,
  refPrice: 73000, stopPrice: 72500, takeProfitPrice: 74000, reason: "test",
};
const skip: AggressiveIntent = { kind: "skip", reason: "test" };

describe("dailyLossCapGuard", () => {
  test("allows when no loss", () => {
    expect(dailyLossCapGuard(enter, baseState, baseLimits).allowed).toBe(true);
  });
  test("blocks when realized loss hits the cap fraction of day-start equity", () => {
    const r = dailyLossCapGuard(enter, { ...baseState, dailyRealizedPnlUsd: -260 }, baseLimits);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toContain("daily-loss-cap-hit");
  });
  test("allows when loss below cap", () => {
    expect(dailyLossCapGuard(enter, { ...baseState, dailyRealizedPnlUsd: -100 }, baseLimits).allowed).toBe(true);
  });
  test("ignores skip intents (only gates entries)", () => {
    expect(dailyLossCapGuard(skip, { ...baseState, dailyRealizedPnlUsd: -1000 }, baseLimits).allowed).toBe(true);
  });
  test("disabled when fraction is 0 — no cap", () => {
    expect(dailyLossCapGuard(enter, { ...baseState, dailyRealizedPnlUsd: -1000 }, { ...baseLimits, dailyLossCapFraction: 0 }).allowed).toBe(true);
  });
});

describe("maxTradesPerDayGuard", () => {
  test("allows under the limit", () => {
    expect(maxTradesPerDayGuard(enter, { ...baseState, tradesToday: 5 }, baseLimits).allowed).toBe(true);
  });
  test("blocks at the limit", () => {
    const r = maxTradesPerDayGuard(enter, { ...baseState, tradesToday: 10 }, baseLimits);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toContain("max-trades-per-day-hit");
  });
});

describe("totalCapitalCapGuard", () => {
  test("blocks above the cap", () => {
    const r = totalCapitalCapGuard(enter, { ...baseState, currentEquityUsd: 1500 }, baseLimits);
    expect(r.allowed).toBe(false);
  });
  test("allows at or below cap", () => {
    expect(totalCapitalCapGuard(enter, { ...baseState, currentEquityUsd: 1000 }, baseLimits).allowed).toBe(true);
  });
});

describe("runAggressiveGuards", () => {
  test("DEFAULT set allows a normal entry", () => {
    expect(runAggressiveGuards(DEFAULT_AGGRESSIVE_GUARDS, enter, baseState, baseLimits).allowed).toBe(true);
  });
  test("first-failure short-circuits — daily-loss before tilt", () => {
    const r = runAggressiveGuards(
      DEFAULT_AGGRESSIVE_GUARDS,
      enter,
      { ...baseState, dailyRealizedPnlUsd: -300, tradesToday: 11 },
      baseLimits,
    );
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toContain("daily-loss-cap-hit");
  });
});

describe("shouldHardStop / shouldTakeProfit", () => {
  test("long: stop triggers when price drops to/below stopPrice", () => {
    expect(shouldHardStop({ side: "long", entryPrice: 73000, stopPrice: 72500, currentPrice: 72499 })).toBe(true);
    expect(shouldHardStop({ side: "long", entryPrice: 73000, stopPrice: 72500, currentPrice: 72500 })).toBe(true);
    expect(shouldHardStop({ side: "long", entryPrice: 73000, stopPrice: 72500, currentPrice: 72501 })).toBe(false);
  });
  test("short: stop triggers when price rises to/above stopPrice", () => {
    expect(shouldHardStop({ side: "short", entryPrice: 73000, stopPrice: 73500, currentPrice: 73501 })).toBe(true);
    expect(shouldHardStop({ side: "short", entryPrice: 73000, stopPrice: 73500, currentPrice: 73499 })).toBe(false);
  });
  test("long TP triggers when price rises to/above TP", () => {
    expect(shouldTakeProfit({ side: "long", entryPrice: 73000, takeProfitPrice: 74000, currentPrice: 74000 })).toBe(true);
    expect(shouldTakeProfit({ side: "long", entryPrice: 73000, takeProfitPrice: 74000, currentPrice: 73999 })).toBe(false);
  });
  test("short TP triggers when price drops to/below TP", () => {
    expect(shouldTakeProfit({ side: "short", entryPrice: 73000, takeProfitPrice: 72000, currentPrice: 72000 })).toBe(true);
  });
});
