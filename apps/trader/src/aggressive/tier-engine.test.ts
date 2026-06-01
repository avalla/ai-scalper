import { describe, expect, test } from "bun:test";
import {
  selectActiveTier,
  tierWouldChange,
  validateTierLadder,
} from "./tier-engine";
import type { AggressiveTierLadder } from "./types";

const ladder: AggressiveTierLadder = [
  { minEquity: 0,     maxEquity: 200,                          leverage: 25, maxNotionalPerTrade: 50,   strategy: "liquidation-hunter", hardStopFraction: 0.02, takeProfitFraction: 0.04 },
  { minEquity: 200,   maxEquity: 1000,                         leverage: 10, maxNotionalPerTrade: 200,  strategy: "liquidation-hunter", hardStopFraction: 0.03, takeProfitFraction: 0.06 },
  { minEquity: 1000,  maxEquity: 10000,                        leverage: 5,  maxNotionalPerTrade: 1000, strategy: "liquidation-hunter", hardStopFraction: 0.04, takeProfitFraction: 0.08 },
  { minEquity: 10000, maxEquity: Number.POSITIVE_INFINITY,     leverage: 2,  maxNotionalPerTrade: 5000, strategy: "liquidation-hunter", hardStopFraction: 0.05, takeProfitFraction: 0.10 },
];

describe("validateTierLadder", () => {
  test("accepts a well-formed ladder", () => {
    expect(() => validateTierLadder(ladder)).not.toThrow();
  });
  test("rejects empty ladder", () => {
    expect(() => validateTierLadder([])).toThrow(/empty/);
  });
  test("rejects gap between tiers", () => {
    const bad = [ladder[0]!, { ...ladder[1]!, minEquity: 500 }, ...ladder.slice(2)];
    expect(() => validateTierLadder(bad as AggressiveTierLadder)).toThrow(/no gaps/);
  });
  test("rejects first tier not starting at 0", () => {
    const bad = [{ ...ladder[0]!, minEquity: 100 }, ...ladder.slice(1)];
    expect(() => validateTierLadder(bad as AggressiveTierLadder)).toThrow(/first tier/);
  });
  test("rejects leverage < 1", () => {
    const bad = [{ ...ladder[0]!, leverage: 0 }, ...ladder.slice(1)];
    expect(() => validateTierLadder(bad as AggressiveTierLadder)).toThrow(/leverage/);
  });
  test("rejects hardStopFraction outside (0,1)", () => {
    const bad = [{ ...ladder[0]!, hardStopFraction: 1.5 }, ...ladder.slice(1)];
    expect(() => validateTierLadder(bad as AggressiveTierLadder)).toThrow(/hardStop/);
  });
});

describe("selectActiveTier", () => {
  test("equity 0 → first (most aggressive) tier", () => {
    const s = selectActiveTier(ladder, 0);
    expect(s.index).toBe(0); expect(s.tier.leverage).toBe(25);
  });
  test("equity 150 → first tier (still under 200)", () => {
    expect(selectActiveTier(ladder, 150).index).toBe(0);
  });
  test("equity 200 (boundary) → second tier (boundary is inclusive on min, exclusive on max)", () => {
    const s = selectActiveTier(ladder, 200);
    expect(s.index).toBe(1); expect(s.tier.leverage).toBe(10);
  });
  test("equity 5000 → third tier", () => {
    expect(selectActiveTier(ladder, 5000).index).toBe(2);
  });
  test("equity 50000 → top tier (above top max clamps)", () => {
    expect(selectActiveTier(ladder, 50000).index).toBe(3);
  });
  test("negative equity → first tier (degraded wind-down)", () => {
    expect(selectActiveTier(ladder, -10).index).toBe(0);
  });
  test("NaN equity → first tier", () => {
    expect(selectActiveTier(ladder, Number.NaN).index).toBe(0);
  });
});

describe("tierWouldChange", () => {
  test("crossing 200 upward → tier changes", () => {
    expect(tierWouldChange(ladder, 199, 201)).toBe(true);
  });
  test("crossing 200 downward → tier changes (demotion)", () => {
    expect(tierWouldChange(ladder, 201, 199)).toBe(true);
  });
  test("staying within a tier → no change", () => {
    expect(tierWouldChange(ladder, 300, 500)).toBe(false);
  });
});
