import { describe, expect, test } from "bun:test";
import { computeAdx } from "./adx";

describe("computeAdx", () => {
  test("returns null for insufficient data", () => {
    expect(
      computeAdx({
        highs: [1, 2, 3],
        lows: [0.5, 1.5, 2.5],
        closes: [1, 2, 3],
        period: 14,
      }),
    ).toBeNull();
  });

  test("returns null on length mismatch", () => {
    expect(
      computeAdx({
        highs: Array(30).fill(1),
        lows: Array(30).fill(0.5),
        closes: Array(29).fill(1),
        period: 14,
      }),
    ).toBeNull();
  });

  test("detects strong uptrend: ADX > 25, +DI > -DI", () => {
    const n = 60;
    const highs: number[] = [];
    const lows: number[] = [];
    const closes: number[] = [];
    // Synthetic clean uptrend: each bar +1, range = 1.
    for (let i = 0; i < n; i += 1) {
      const c = 100 + i;
      closes.push(c);
      highs.push(c + 0.5);
      lows.push(c - 0.5);
    }
    const r = computeAdx({ highs, lows, closes, period: 14 });
    expect(r).not.toBeNull();
    if (r) {
      expect(r.adx).toBeGreaterThan(25);
      expect(r.plusDi).toBeGreaterThan(r.minusDi);
    }
  });

  test("detects strong downtrend: ADX > 25, -DI > +DI", () => {
    const n = 60;
    const highs: number[] = [];
    const lows: number[] = [];
    const closes: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const c = 200 - i;
      closes.push(c);
      highs.push(c + 0.5);
      lows.push(c - 0.5);
    }
    const r = computeAdx({ highs, lows, closes, period: 14 });
    expect(r).not.toBeNull();
    if (r) {
      expect(r.adx).toBeGreaterThan(25);
      expect(r.minusDi).toBeGreaterThan(r.plusDi);
    }
  });

  test("low ADX in a flat / choppy market", () => {
    const n = 60;
    const highs: number[] = [];
    const lows: number[] = [];
    const closes: number[] = [];
    for (let i = 0; i < n; i += 1) {
      // Pure square wave around 100 — net zero directional movement.
      const c = 100 + (i % 2 === 0 ? 0.5 : -0.5);
      closes.push(c);
      highs.push(c + 0.2);
      lows.push(c - 0.2);
    }
    const r = computeAdx({ highs, lows, closes, period: 14 });
    expect(r).not.toBeNull();
    if (r) {
      expect(r.adx).toBeLessThan(25);
    }
  });
});
