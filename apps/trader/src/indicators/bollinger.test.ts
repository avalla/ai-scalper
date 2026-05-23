import { describe, expect, test } from "bun:test";
import { computeBollinger } from "./bollinger";

describe("computeBollinger", () => {
  test("returns null for insufficient data", () => {
    expect(computeBollinger([1, 2, 3], 20, 2)).toBeNull();
  });

  test("middle equals SMA of the last `period` closes", () => {
    const closes = [10, 20, 30, 40, 50];
    const r = computeBollinger(closes, 5, 2);
    expect(r).not.toBeNull();
    if (r) {
      expect(r.middle).toBe(30);
    }
  });

  test("upper - lower == 2 * stdDevMultiplier * stddev", () => {
    const closes = [10, 12, 15, 18, 20, 22, 24, 27, 30, 33];
    const r = computeBollinger(closes, 10, 2);
    expect(r).not.toBeNull();
    if (r) {
      expect(r.upper - r.lower).toBeCloseTo(2 * 2 * r.stddev, 9);
    }
  });

  test("stddev is zero when all closes in the window are equal", () => {
    const r = computeBollinger([100, 100, 100, 100, 100], 5, 2);
    expect(r).not.toBeNull();
    if (r) {
      expect(r.stddev).toBe(0);
      expect(r.upper).toBe(100);
      expect(r.lower).toBe(100);
    }
  });

  test("uses only the most recent `period` closes when more are supplied", () => {
    // First 5 are noise; last 5 are constant 100 → BB should center on 100.
    const closes = [1, 2, 3, 4, 5, 100, 100, 100, 100, 100];
    const r = computeBollinger(closes, 5, 2);
    expect(r).not.toBeNull();
    if (r) {
      expect(r.middle).toBe(100);
      expect(r.stddev).toBe(0);
    }
  });
});
