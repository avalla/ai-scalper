import { describe, expect, test } from "bun:test";
import { longerTfSignal } from "./longer-tf";

const NOW = 1_700_000_000_000;
const base = {
  now: NOW,
  refreshSec: 60,
  symbol: "BTCUSDT",
  fastWindow: 3,
  slowWindow: 5,
  thresholdBps: 10,
};

describe("longerTfSignal", () => {
  test("needs-refresh when cache is null", () => {
    expect(longerTfSignal({ ...base, cache: null })).toBe("needs-refresh");
  });

  test("needs-refresh when cache is stale", () => {
    const cache = {
      symbol: "BTCUSDT",
      fetchedAt: NOW - 61_000,
      closePrices: [100, 101, 102, 103, 104],
    };
    expect(longerTfSignal({ ...base, cache })).toBe("needs-refresh");
  });

  test("needs-refresh when cache symbol does not match", () => {
    const cache = {
      symbol: "ETHUSDT",
      fetchedAt: NOW,
      closePrices: [100, 101, 102, 103, 104],
    };
    expect(longerTfSignal({ ...base, cache })).toBe("needs-refresh");
  });

  test("warmup when not enough closes", () => {
    const cache = {
      symbol: "BTCUSDT",
      fetchedAt: NOW,
      closePrices: [100, 101, 102], // < slowWindow=5
    };
    expect(longerTfSignal({ ...base, cache })).toBe("warmup");
  });

  test("long when fast MA exceeds slow MA by threshold", () => {
    // Five prices: slow MA = avg(all), fast MA = avg(last 3). Last 3 are higher.
    const cache = {
      symbol: "BTCUSDT",
      fetchedAt: NOW,
      closePrices: [90, 90, 110, 110, 110],
    };
    expect(longerTfSignal({ ...base, cache })).toBe("long");
  });

  test("flat when fast vs slow MA difference is within threshold", () => {
    const cache = {
      symbol: "BTCUSDT",
      fetchedAt: NOW,
      closePrices: [100, 100, 100, 100, 100],
    };
    expect(longerTfSignal({ ...base, cache })).toBe("flat");
  });
});
