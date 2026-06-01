import { describe, expect, test } from "bun:test";
import { buildLiquidationMap, nearestMagnets } from "./liquidation-map";
import type { LiquidationEvent } from "./types";

const REF = 73000;
const NOW = 1_700_000_000_000;
const ev = (price: number, sizeUsd: number, side: "Buy" | "Sell" = "Buy", ts = NOW): LiquidationEvent => ({ price, sizeUsd, side, ts });

const baseOpts = { bandBps: 20, minMagnetSizeUsd: 1000 };

describe("buildLiquidationMap", () => {
  test("empty events → empty map", () => {
    const m = buildLiquidationMap([], REF, baseOpts);
    expect(m.above).toHaveLength(0); expect(m.below).toHaveLength(0);
  });

  test("invalid refPrice → empty map", () => {
    const m = buildLiquidationMap([ev(73100, 50_000)], 0, baseOpts);
    expect(m.above).toHaveLength(0);
  });

  test("clusters nearby prints into one magnet (within bandBps)", () => {
    // 73100, 73105, 73110 — all within 20bps of each other (band at REF 73000 is ~146)
    const events = [ev(73100, 10_000), ev(73105, 20_000), ev(73110, 30_000)];
    const m = buildLiquidationMap(events, REF, baseOpts);
    expect(m.above).toHaveLength(1);
    expect(m.above[0]!.count).toBe(3);
    expect(m.above[0]!.magnitudeUsd).toBe(60_000);
    // weighted mean: (73100*10 + 73105*20 + 73110*30)/60 = 73106.67
    expect(m.above[0]!.price).toBeCloseTo(73106.67, 1);
  });

  test("splits clusters when gap exceeds bandBps", () => {
    // bandBps=20 → ~146 USD apart at REF 73000. 73100 vs 73300 = 200 USD apart → split.
    const events = [ev(73100, 10_000), ev(73300, 20_000)];
    const m = buildLiquidationMap(events, REF, baseOpts);
    expect(m.above).toHaveLength(2);
    expect(m.above[0]!.price).toBeCloseTo(73100, 1);
    expect(m.above[1]!.price).toBeCloseTo(73300, 1);
  });

  test("separates above/below the reference price", () => {
    const events = [ev(73200, 30_000), ev(72800, 40_000)];
    const m = buildLiquidationMap(events, REF, baseOpts);
    expect(m.above).toHaveLength(1); expect(m.below).toHaveLength(1);
    expect(m.above[0]!.price).toBe(73200);
    expect(m.below[0]!.price).toBe(72800);
  });

  test("sorts above ascending and below descending (nearest first)", () => {
    const events = [ev(73500, 15_000), ev(73200, 25_000), ev(72500, 20_000), ev(72800, 30_000)];
    const m = buildLiquidationMap(events, REF, baseOpts);
    expect(m.above.map((x) => x.price)).toEqual([73200, 73500]);
    expect(m.below.map((x) => x.price)).toEqual([72800, 72500]);
  });

  test("filters magnets below minMagnetSizeUsd", () => {
    const events = [ev(73200, 500), ev(73500, 5000)]; // 500 < 1000 floor
    const m = buildLiquidationMap(events, REF, baseOpts);
    expect(m.above).toHaveLength(1);
    expect(m.above[0]!.price).toBe(73500);
  });

  test("respects maxAgeMs filter", () => {
    const events = [ev(73200, 50_000, "Buy", NOW - 3_600_000), ev(73400, 50_000, "Buy", NOW - 600_000)];
    const m = buildLiquidationMap(events, REF, { ...baseOpts, maxAgeMs: 1_800_000, nowMs: NOW });
    expect(m.above).toHaveLength(1);
    expect(m.above[0]!.price).toBe(73400); // the older one is dropped
  });

  test("respects maxDistanceBps (drops far magnets)", () => {
    // 73100 is ~14bps from ref; 80000 is way out (~959bps). cap at 100.
    const events = [ev(73100, 5000), ev(80000, 50_000)];
    const m = buildLiquidationMap(events, REF, { ...baseOpts, maxDistanceBps: 100 });
    expect(m.above).toHaveLength(1);
    expect(m.above[0]!.price).toBeCloseTo(73100, 1);
  });

  test("rejects invalid events (NaN price, zero size)", () => {
    const events = [ev(Number.NaN, 5000), ev(73100, 0), ev(73200, 10_000)];
    const m = buildLiquidationMap(events, REF, baseOpts);
    expect(m.above).toHaveLength(1);
    expect(m.above[0]!.magnitudeUsd).toBe(10_000);
  });
});

describe("nearestMagnets", () => {
  test("returns null on each side when no magnets", () => {
    const m = buildLiquidationMap([], REF, baseOpts);
    const n = nearestMagnets(m);
    expect(n.above).toBeNull(); expect(n.below).toBeNull();
  });

  test("returns the front of each sorted list", () => {
    const events = [ev(73500, 15_000), ev(73200, 25_000), ev(72500, 20_000), ev(72800, 30_000)];
    const m = buildLiquidationMap(events, REF, baseOpts);
    const n = nearestMagnets(m);
    expect(n.above!.price).toBe(73200);
    expect(n.below!.price).toBe(72800);
  });
});
