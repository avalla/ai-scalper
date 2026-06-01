import { describe, expect, test } from "bun:test";
import { DEFAULT_HUNTER_PARAMS, liquidationHunterDecide } from "./liquidation-hunter";
import { buildLiquidationMap } from "./liquidation-map";
import type { AggressiveTierConfig, LiquidationEvent } from "./types";

const tier: AggressiveTierConfig = {
  minEquity: 0, maxEquity: 200, leverage: 25,
  maxNotionalPerTrade: 50, strategy: "liquidation-hunter",
  hardStopFraction: 0.02, takeProfitFraction: 0.04,
};
const REF = 73000;
const ev = (price: number, sizeUsd: number): LiquidationEvent => ({ price, sizeUsd, side: "Buy", ts: 0 });

function map(events: LiquidationEvent[]) {
  return buildLiquidationMap(events, REF, { bandBps: 20, minMagnetSizeUsd: 1000 });
}

describe("liquidationHunterDecide", () => {
  test("skips when no magnets", () => {
    const r = liquidationHunterDecide(map([]), tier);
    expect(r.kind).toBe("skip");
    if (r.kind === "skip") expect(r.reason).toBe("no-magnets");
  });

  test("LONG toward a dominant magnet above (no opposing magnet)", () => {
    const r = liquidationHunterDecide(map([ev(73200, 100_000)]), tier);
    expect(r.kind).toBe("enter");
    if (r.kind === "enter") {
      expect(r.side).toBe("long");
      expect(r.refPrice).toBe(REF);
      expect(r.leverage).toBe(25); expect(r.notionalUsd).toBe(50);
      // TP at 85% of move toward 73200 → 73000 + 0.85*200 = 73170
      expect(r.takeProfitPrice).toBeCloseTo(73170, 0);
      // Stop at -2% of refPrice = 73000 - 1460 = 71540
      expect(r.stopPrice).toBeCloseTo(71540, 0);
    }
  });

  test("SHORT toward a dominant magnet below (no opposing magnet)", () => {
    const r = liquidationHunterDecide(map([ev(72800, 100_000)]), tier);
    expect(r.kind).toBe("enter");
    if (r.kind === "enter") {
      expect(r.side).toBe("short");
      expect(r.takeProfitPrice).toBeCloseTo(72830, 0); // 73000 - 0.85*200
      expect(r.stopPrice).toBeCloseTo(74460, 0);       // 73000 + 2%
    }
  });

  test("picks the LARGER magnitude when magnets exist on both sides", () => {
    // above 100k vs below 30k → ratio 3.33 > 1.5 → take above (long)
    const r = liquidationHunterDecide(map([ev(73200, 100_000), ev(72800, 30_000)]), tier);
    expect(r.kind).toBe("enter");
    if (r.kind === "enter") expect(r.side).toBe("long");
  });

  test("skips when both sides are roughly balanced (dominance < ratio)", () => {
    // above 100k vs below 80k → ratio 1.25 < 1.5 → skip
    const r = liquidationHunterDecide(map([ev(73200, 100_000), ev(72800, 80_000)]), tier);
    expect(r.kind).toBe("skip");
    if (r.kind === "skip") expect(r.reason).toContain("dominance-too-low");
  });

  test("skips when target magnitude is below minTargetMagnitudeUsd", () => {
    const r = liquidationHunterDecide(map([ev(73200, 20_000)]), tier);
    expect(r.kind).toBe("skip");
    if (r.kind === "skip") expect(r.reason).toContain("target-too-small");
  });

  test("skips when target is too close to refPrice (distance < min)", () => {
    // 73003 vs ref 73000 → ~0.4bps, well under 10bps minimum
    const r = liquidationHunterDecide(map([ev(73003, 100_000)]), tier);
    expect(r.kind).toBe("skip");
    if (r.kind === "skip") expect(r.reason).toContain("distance-too-small");
  });

  test("skips when invoked with a non-liquidation-hunter tier", () => {
    const badTier = { ...tier, strategy: "momentum-breakout" as const };
    const r = liquidationHunterDecide(map([ev(73200, 100_000)]), badTier);
    expect(r.kind).toBe("skip");
    if (r.kind === "skip") expect(r.reason).toContain("tier-strategy-mismatch");
  });

  test("custom params override defaults (e.g. lower min magnitude)", () => {
    const r = liquidationHunterDecide(
      map([ev(73200, 20_000)]),
      tier,
      { ...DEFAULT_HUNTER_PARAMS, minTargetMagnitudeUsd: 10_000 },
    );
    expect(r.kind).toBe("enter");
  });
});
