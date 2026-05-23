import { describe, expect, test } from "bun:test";
import {
  applyConfidenceSizing,
  computeTrailingStop,
  evaluateDrawdownVelocity,
  recordPnlSample,
  reconcilePositions,
  type DrawdownVelocityState,
  type OpenPosition,
} from "../src/index";

function makeLong(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    side: "long",
    quantity: 1,
    notionalUsd: 100,
    entryPrice: 100,
    leverage: 1,
    openedAt: 0,
    stopLossPrice: 99,
    takeProfitPrice: 110,
    ...overrides,
  };
}

function makeShort(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    side: "short",
    quantity: 1,
    notionalUsd: 100,
    entryPrice: 100,
    leverage: 1,
    openedAt: 0,
    stopLossPrice: 101,
    takeProfitPrice: 90,
    ...overrides,
  };
}

describe("computeTrailingStop", () => {
  test("long below activation returns null", () => {
    const r = computeTrailingStop({
      position: makeLong(),
      marketPrice: 100.1, // +10bps, less than 30bps activation
      activationBps: 30,
      trailBps: 15,
    });
    expect(r.newStopLossPrice).toBeNull();
    expect(r.reason).toBe("below-activation");
  });

  test("long at exactly activation begins trailing", () => {
    const r = computeTrailingStop({
      position: makeLong(),
      marketPrice: 100 * 1.003, // +30bps
      activationBps: 30,
      trailBps: 15,
    });
    expect(r.reason).toBe("trailing");
    expect(r.newStopLossPrice).not.toBeNull();
    expect(r.newStopLossPrice!).toBeCloseTo(100.3 * (1 - 0.0015), 4);
  });

  test("long trailing in profit raises stop above original", () => {
    const r = computeTrailingStop({
      position: makeLong({ stopLossPrice: 99 }),
      marketPrice: 110,
      activationBps: 30,
      trailBps: 15,
    });
    expect(r.reason).toBe("trailing");
    // 110 * (1 - 0.0015) = 109.835
    expect(r.newStopLossPrice!).toBeCloseTo(109.835, 3);
    expect(r.newStopLossPrice!).toBeGreaterThan(99);
  });

  test("long trailing never lowers an existing stop", () => {
    const r = computeTrailingStop({
      position: makeLong({ stopLossPrice: 109.9 }),
      marketPrice: 110,
      activationBps: 30,
      trailBps: 15,
    });
    // candidate ~109.835 < 109.9 → keep 109.9
    expect(r.newStopLossPrice).toBe(109.9);
  });

  test("short below activation (price too high) returns null", () => {
    const r = computeTrailingStop({
      position: makeShort(),
      marketPrice: 99.9,
      activationBps: 30,
      trailBps: 15,
    });
    expect(r.newStopLossPrice).toBeNull();
  });

  test("short trailing in profit lowers stop", () => {
    const r = computeTrailingStop({
      position: makeShort({ stopLossPrice: 101 }),
      marketPrice: 90,
      activationBps: 30,
      trailBps: 15,
    });
    expect(r.reason).toBe("trailing");
    expect(r.newStopLossPrice!).toBeCloseTo(90 * (1 + 0.0015), 4);
    expect(r.newStopLossPrice!).toBeLessThan(101);
  });
});

describe("drawdown velocity guard", () => {
  test("no halt with steady pnl", () => {
    let state: DrawdownVelocityState = { recentPnlSamples: [] };
    state = recordPnlSample(state, 1000, 0, 60_000);
    state = recordPnlSample(state, 2000, 1, 60_000);
    state = recordPnlSample(state, 3000, 2, 60_000);
    const r = evaluateDrawdownVelocity(state, {
      now: 3000,
      windowMs: 60_000,
      maxDrawdownInWindowUsd: 10,
    });
    expect(r.halted).toBe(false);
  });

  test("halts on rapid drawdown in window", () => {
    let state: DrawdownVelocityState = { recentPnlSamples: [] };
    state = recordPnlSample(state, 1000, 50, 60_000);
    state = recordPnlSample(state, 2000, 40, 60_000);
    state = recordPnlSample(state, 3000, 10, 60_000); // drop of 40 from peak
    const r = evaluateDrawdownVelocity(state, {
      now: 3000,
      windowMs: 60_000,
      maxDrawdownInWindowUsd: 20,
    });
    expect(r.halted).toBe(true);
    expect(r.reason).toBe("drawdown-velocity");
  });

  test("halts on N consecutive losses", () => {
    const state: DrawdownVelocityState = { recentPnlSamples: [] };
    const r = evaluateDrawdownVelocity(state, {
      now: 0,
      windowMs: 60_000,
      maxDrawdownInWindowUsd: 1000,
      maxConsecutiveLosses: 3,
      closedTradeOutcomes: ["win", "loss", "loss", "loss"],
    });
    expect(r.halted).toBe(true);
    expect(r.reason).toBe("consecutive-losses");
  });

  test("drops stale samples outside window", () => {
    let state: DrawdownVelocityState = { recentPnlSamples: [] };
    state = recordPnlSample(state, 1000, 100, 5000);
    state = recordPnlSample(state, 10_000, 90, 5000); // stale ones dropped
    expect(state.recentPnlSamples.length).toBe(1);
    expect(state.recentPnlSamples[0]!.ts).toBe(10_000);
    // no halt because peak in window is just 90
    const r = evaluateDrawdownVelocity(state, {
      now: 10_000,
      windowMs: 5000,
      maxDrawdownInWindowUsd: 5,
    });
    expect(r.halted).toBe(false);
  });
});

describe("reconcilePositions", () => {
  test("both null = aligned", () => {
    const r = reconcilePositions({ expected: null, observed: null });
    expect(r.aligned).toBe(true);
    expect(r.drift).toBeNull();
  });

  test("expected without observed = missing-on-exchange", () => {
    const r = reconcilePositions({ expected: makeLong(), observed: null });
    expect(r.aligned).toBe(false);
    expect(r.drift).toBe("missing-on-exchange");
  });

  test("observed without expected = extra-on-exchange", () => {
    const r = reconcilePositions({
      expected: null,
      observed: { side: "Buy", size: 1, avgPrice: 100 },
    });
    expect(r.aligned).toBe(false);
    expect(r.drift).toBe("extra-on-exchange");
  });

  test("side mismatch", () => {
    const r = reconcilePositions({
      expected: makeLong(),
      observed: { side: "Sell", size: 1, avgPrice: 100 },
    });
    expect(r.drift).toBe("side-mismatch");
  });

  test("size mismatch", () => {
    const r = reconcilePositions({
      expected: makeLong({ quantity: 1 }),
      observed: { side: "Buy", size: 2, avgPrice: 100 },
    });
    expect(r.drift).toBe("size-mismatch");
  });

  test("aligned when both match within tolerance", () => {
    const r = reconcilePositions({
      expected: makeLong({ quantity: 1 }),
      observed: { side: "Buy", size: 1 + 1e-9, avgPrice: 100 },
    });
    expect(r.aligned).toBe(true);
  });
});

describe("applyConfidenceSizing", () => {
  test("at reference returns 1x", () => {
    const r = applyConfidenceSizing({ baseOrderUsd: 100, scanScore: 50, referenceScore: 50 });
    expect(r.multiplier).toBe(1);
    expect(r.orderUsd).toBe(100);
  });

  test("very high score clamps at max", () => {
    const r = applyConfidenceSizing({
      baseOrderUsd: 100,
      scanScore: 1000,
      referenceScore: 50,
      maxMultiplier: 2,
    });
    expect(r.multiplier).toBe(2);
    expect(r.orderUsd).toBe(200);
  });

  test("very low score clamps at min", () => {
    const r = applyConfidenceSizing({
      baseOrderUsd: 100,
      scanScore: 1,
      referenceScore: 50,
      minMultiplier: 0.5,
    });
    expect(r.multiplier).toBe(0.5);
    expect(r.orderUsd).toBe(50);
  });
});
