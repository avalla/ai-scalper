import { describe, expect, test } from "bun:test";
import {
  computeHedgeRatio,
  computeZScore,
  pairsDecide,
  type PairsCache,
  type PairsPosition,
} from "./pairs-trading";

const NOW = 1_700_000_000_000;
const min = 60_000;

const baseCfg = {
  now: NOW,
  refreshSec: 30,
  windowSize: 50,
  entryZ: 2.0,
  exitZ: 0.3,
  maxHoldMinutes: 480,
  leg1Symbol: "BTCUSDT",
  leg2Symbol: "ETHUSDT",
};

function buildCache(leg1: number[], leg2: number[], ageMs = 0): PairsCache {
  return {
    leg1Symbol: "BTCUSDT",
    leg2Symbol: "ETHUSDT",
    fetchedAt: NOW - ageMs,
    leg1Closes: leg1,
    leg2Closes: leg2,
  };
}

function buildSeries(n: number, base: number, slope: number, noise: number[] = []): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(base + slope * i + (noise[i] ?? 0));
  }
  return out;
}

describe("computeHedgeRatio", () => {
  test("returns ~1 for perfectly proportional series (leg2 == leg1)", () => {
    const series = buildSeries(50, 100, 1);
    const beta = computeHedgeRatio(series, series);
    expect(beta).toBeCloseTo(1, 6);
  });

  test("returns ~2 when log(leg2) = 2 * log(leg1) + c (multiplicative scaling)", () => {
    const leg1 = buildSeries(50, 100, 1);
    const leg2 = leg1.map((p) => p * p); // log(leg2) = 2 log(leg1)
    const beta = computeHedgeRatio(leg1, leg2);
    expect(beta).toBeCloseTo(2, 4);
  });

  test("falls back to 1 on length mismatch", () => {
    expect(computeHedgeRatio([1, 2, 3], [1, 2])).toBe(1);
  });
});

describe("computeZScore", () => {
  test("returns z=0 when current spread equals the rolling mean", () => {
    // Constant leg1 and leg2 → spread constant → mean=spread, stddev=0, z=0.
    const leg1 = Array(20).fill(100);
    const leg2 = Array(20).fill(150);
    const result = computeZScore(leg1, leg2, 1);
    expect(result.z).toBe(0);
    expect(result.stddev).toBe(0);
  });

  test("positive z when last spread is well above the mean", () => {
    // 19 stable points + 1 large jump in leg2.
    const leg1 = Array(20).fill(100);
    const leg2 = [...Array(19).fill(150), 200];
    const result = computeZScore(leg1, leg2, 1);
    expect(result.z).toBeGreaterThan(2);
  });
});

describe("pairsDecide", () => {
  test("hold:needs-refresh when cache is null", () => {
    const d = pairsDecide({ ...baseCfg, cache: null, position: null });
    expect(d.kind).toBe("hold");
    if (d.kind === "hold") expect(d.reason).toBe("needs-refresh");
  });

  test("hold:needs-refresh when cache is stale", () => {
    const d = pairsDecide({
      ...baseCfg,
      cache: buildCache([100, 101], [150, 151], 31_000),
      position: null,
    });
    expect(d.kind).toBe("hold");
    if (d.kind === "hold") expect(d.reason).toBe("needs-refresh");
  });

  test("hold:warmup when fewer samples than windowSize", () => {
    const d = pairsDecide({
      ...baseCfg,
      cache: buildCache(buildSeries(10, 100, 0.1), buildSeries(10, 150, 0.15)),
      position: null,
    });
    expect(d.kind).toBe("hold");
    if (d.kind === "hold") expect(d.reason).toBe("warmup");
  });

  test("hold:within-bands when |z| < entryZ on stable series", () => {
    const leg1 = buildSeries(60, 100, 0.1);
    const leg2 = leg1.map((p) => p * 1.5);
    const d = pairsDecide({
      ...baseCfg,
      cache: buildCache(leg1, leg2),
      position: null,
    });
    expect(d.kind).toBe("hold");
    if (d.kind === "hold") expect(d.reason).toBe("within-bands");
  });

  test("enter short leg2 + long leg1 when z > +entryZ", () => {
    const leg1 = Array(60).fill(100);
    // Stable leg2 with last point jumped sharply higher.
    const leg2 = [...Array(59).fill(150), 165];
    const d = pairsDecide({
      ...baseCfg,
      cache: buildCache(leg1, leg2),
      position: null,
    });
    expect(d.kind).toBe("enter");
    if (d.kind === "enter") {
      expect(d.leg1Side).toBe("long");
      expect(d.leg2Side).toBe("short");
      expect(d.z).toBeGreaterThan(baseCfg.entryZ);
    }
  });

  test("enter long leg2 + short leg1 when z < -entryZ", () => {
    const leg1 = Array(60).fill(100);
    const leg2 = [...Array(59).fill(150), 135];
    const d = pairsDecide({
      ...baseCfg,
      cache: buildCache(leg1, leg2),
      position: null,
    });
    expect(d.kind).toBe("enter");
    if (d.kind === "enter") {
      expect(d.leg1Side).toBe("short");
      expect(d.leg2Side).toBe("long");
      expect(d.z).toBeLessThan(-baseCfg.entryZ);
    }
  });

  test("exit:z-converged when in position and |z| ≤ exitZ", () => {
    const leg1 = Array(60).fill(100);
    const leg2 = Array(60).fill(150);
    const position: PairsPosition = {
      leg1Symbol: "BTCUSDT",
      leg1Side: "long",
      leg1EntryPrice: 100,
      leg1Qty: 0.01,
      leg2Symbol: "ETHUSDT",
      leg2Side: "short",
      leg2EntryPrice: 150,
      leg2Qty: 0.06,
      entryZ: 2.5,
      hedgeRatio: 1.0,
      entryAt: NOW - 5 * min,
    };
    const d = pairsDecide({
      ...baseCfg,
      cache: buildCache(leg1, leg2),
      position,
    });
    expect(d.kind).toBe("exit");
    if (d.kind === "exit") expect(d.reason).toBe("z-converged");
  });

  test("exit:max-hold-exceeded after maxHoldMinutes regardless of z", () => {
    const leg1 = Array(60).fill(100);
    const leg2 = [...Array(59).fill(150), 170]; // still wide
    const position: PairsPosition = {
      leg1Symbol: "BTCUSDT",
      leg1Side: "long",
      leg1EntryPrice: 100,
      leg1Qty: 0.01,
      leg2Symbol: "ETHUSDT",
      leg2Side: "short",
      leg2EntryPrice: 150,
      leg2Qty: 0.06,
      entryZ: 2.5,
      hedgeRatio: 1.0,
      entryAt: NOW - 500 * min, // > 480
    };
    const d = pairsDecide({
      ...baseCfg,
      cache: buildCache(leg1, leg2),
      position,
    });
    expect(d.kind).toBe("exit");
    if (d.kind === "exit") expect(d.reason).toBe("max-hold-exceeded");
  });

  test("hold:waiting-convergence when in position and |z| still wide", () => {
    const leg1 = Array(60).fill(100);
    const leg2 = [...Array(59).fill(150), 170];
    const position: PairsPosition = {
      leg1Symbol: "BTCUSDT",
      leg1Side: "long",
      leg1EntryPrice: 100,
      leg1Qty: 0.01,
      leg2Symbol: "ETHUSDT",
      leg2Side: "short",
      leg2EntryPrice: 150,
      leg2Qty: 0.06,
      entryZ: 2.5,
      hedgeRatio: 1.0,
      entryAt: NOW - 5 * min,
    };
    const d = pairsDecide({
      ...baseCfg,
      cache: buildCache(leg1, leg2),
      position,
    });
    expect(d.kind).toBe("hold");
    if (d.kind === "hold") expect(d.reason).toBe("waiting-convergence");
  });
});
