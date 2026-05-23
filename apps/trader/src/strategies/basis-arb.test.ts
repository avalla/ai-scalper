import { describe, expect, test } from "bun:test";
import { basisArbDecide, computeBasisBps, type BasisPosition } from "./basis-arb";

const NOW = 1_700_000_000_000;
const min = 60_000;

const baseCfg = {
  entryThresholdBps: 8,
  exitThresholdBps: 2,
  maxHoldMinutes: 240,
};

describe("computeBasisBps", () => {
  test("returns 0 when spotPrice is 0", () => {
    expect(computeBasisBps(0, 100)).toBe(0);
  });

  test("returns 0 when spotPrice is negative", () => {
    expect(computeBasisBps(-10, 100)).toBe(0);
  });

  test("computes positive basis when perp > spot", () => {
    // perp 100.10, spot 100 → (0.10/100)*10000 = 10 bps
    expect(computeBasisBps(100, 100.1)).toBeCloseTo(10, 6);
  });

  test("computes negative basis when perp < spot", () => {
    expect(computeBasisBps(100, 99.9)).toBeCloseTo(-10, 6);
  });
});

describe("basisArbDecide", () => {
  test("hold:basis-too-small when no position and basis below threshold", () => {
    const decision = basisArbDecide({
      spotPrice: 100,
      perpPrice: 100.05, // 5 bps < 8
      now: NOW,
      position: null,
      config: baseCfg,
    });
    expect(decision.kind).toBe("hold");
    if (decision.kind === "hold") expect(decision.reason).toBe("basis-too-small");
  });

  test("enter perp=short spot=long when positive basis above threshold", () => {
    const decision = basisArbDecide({
      spotPrice: 100,
      perpPrice: 100.15, // 15 bps > 8
      now: NOW,
      position: null,
      config: baseCfg,
    });
    expect(decision.kind).toBe("enter");
    if (decision.kind === "enter") {
      expect(decision.perpSide).toBe("short");
      expect(decision.spotSide).toBe("long");
      expect(decision.basisBps).toBeCloseTo(15, 6);
    }
  });

  test("enter perp=long spot=short when negative basis below -threshold", () => {
    const decision = basisArbDecide({
      spotPrice: 100,
      perpPrice: 99.85, // -15 bps
      now: NOW,
      position: null,
      config: baseCfg,
    });
    expect(decision.kind).toBe("enter");
    if (decision.kind === "enter") {
      expect(decision.perpSide).toBe("long");
      expect(decision.spotSide).toBe("short");
    }
  });

  test("hold:waiting-convergence when in position and basis still wide", () => {
    const pos: BasisPosition = {
      perpSide: "short",
      spotSide: "long",
      entryBasisBps: 15,
      entryAt: NOW - 5 * min,
    };
    const decision = basisArbDecide({
      spotPrice: 100,
      perpPrice: 100.1, // 10 bps, still > exit 2
      now: NOW,
      position: pos,
      config: baseCfg,
    });
    expect(decision.kind).toBe("hold");
    if (decision.kind === "hold") expect(decision.reason).toBe("waiting-convergence");
  });

  test("exit:basis-converged when |basis| within exit threshold", () => {
    const pos: BasisPosition = {
      perpSide: "short",
      spotSide: "long",
      entryBasisBps: 15,
      entryAt: NOW - 10 * min,
    };
    const decision = basisArbDecide({
      spotPrice: 100,
      perpPrice: 100.01, // 1 bps < 2
      now: NOW,
      position: pos,
      config: baseCfg,
    });
    expect(decision.kind).toBe("exit");
    if (decision.kind === "exit") expect(decision.reason).toBe("basis-converged");
  });

  test("exit:max-hold-exceeded when held > maxHoldMinutes regardless of basis", () => {
    const pos: BasisPosition = {
      perpSide: "short",
      spotSide: "long",
      entryBasisBps: 15,
      entryAt: NOW - 300 * min, // 300 min > 240
    };
    const decision = basisArbDecide({
      spotPrice: 100,
      perpPrice: 100.15, // basis still wide
      now: NOW,
      position: pos,
      config: baseCfg,
    });
    expect(decision.kind).toBe("exit");
    if (decision.kind === "exit") expect(decision.reason).toBe("max-hold-exceeded");
  });

  test("edge: basis exactly at entry threshold does NOT enter (strict >)", () => {
    const decision = basisArbDecide({
      spotPrice: 100,
      perpPrice: 100.08, // exactly 8 bps == entryThreshold
      now: NOW,
      position: null,
      config: baseCfg,
    });
    expect(decision.kind).toBe("hold");
    if (decision.kind === "hold") expect(decision.reason).toBe("basis-too-small");
  });

  test("edge: basis exactly at exit threshold triggers exit (<= inclusive)", () => {
    const pos: BasisPosition = {
      perpSide: "short",
      spotSide: "long",
      entryBasisBps: 15,
      entryAt: NOW - 5 * min,
    };
    const decision = basisArbDecide({
      spotPrice: 100,
      perpPrice: 100.02, // exactly 2 bps == exitThreshold
      now: NOW,
      position: pos,
      config: baseCfg,
    });
    expect(decision.kind).toBe("exit");
    if (decision.kind === "exit") expect(decision.reason).toBe("basis-converged");
  });

  test("max-hold takes precedence over basis-converged", () => {
    const pos: BasisPosition = {
      perpSide: "short",
      spotSide: "long",
      entryBasisBps: 15,
      entryAt: NOW - 300 * min,
    };
    const decision = basisArbDecide({
      spotPrice: 100,
      perpPrice: 100.0, // 0 bps, would also trigger basis-converged
      now: NOW,
      position: pos,
      config: baseCfg,
    });
    expect(decision.kind).toBe("exit");
    if (decision.kind === "exit") expect(decision.reason).toBe("max-hold-exceeded");
  });

  test("symmetric: negative-basis position holds while basis still wide negative", () => {
    const pos: BasisPosition = {
      perpSide: "long",
      spotSide: "short",
      entryBasisBps: -15,
      entryAt: NOW - 3 * min,
    };
    const decision = basisArbDecide({
      spotPrice: 100,
      perpPrice: 99.9, // -10 bps
      now: NOW,
      position: pos,
      config: baseCfg,
    });
    expect(decision.kind).toBe("hold");
    if (decision.kind === "hold") expect(decision.reason).toBe("waiting-convergence");
  });
});
