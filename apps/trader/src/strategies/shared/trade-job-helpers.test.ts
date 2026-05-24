import { describe, expect, test } from "bun:test";
import {
  appendDecisionHistory,
  computeQtyFromNotional,
  floorQtyToStep,
  makeOpenTickJobId,
  makePositionId,
  safeRemoveRepeatable,
} from "./trade-job-helpers";

describe("trade-job-helpers", () => {
  test("makePositionId is deterministic and includes strategy+now+discriminator", () => {
    expect(makePositionId({ strategy: "funding-arb", now: 1_700_000_000_000, discriminator: "BTCUSDT" }))
      .toBe("funding-arb-position:1700000000000-BTCUSDT");
  });

  test("makeOpenTickJobId is constant per strategy (recurring dedup)", () => {
    expect(makeOpenTickJobId("longer-tf")).toBe("longer-tf:open-tick:recurring");
    expect(makeOpenTickJobId("ma-crossover")).toBe("ma-crossover:open-tick:recurring");
  });

  test("appendDecisionHistory preserves order and caps at the configured limit", () => {
    const seed = [
      { at: "t0", action: "open", reasoning: "r0" },
      { at: "t1", action: "hold", reasoning: "r1" },
    ];
    const next = appendDecisionHistory(seed, { at: "t2", action: "hold", reasoning: "r2" });
    expect(next).toHaveLength(3);
    expect(next[2]).toEqual({ at: "t2", action: "hold", reasoning: "r2" });

    const big = Array.from({ length: 51 }, (_, i) => ({ at: `t${i}`, action: "hold", reasoning: `r${i}` }));
    const capped = appendDecisionHistory(big, { at: "t51", action: "hold", reasoning: "r51" });
    expect(capped).toHaveLength(50);
    expect(capped[0]!.at).toBe("t2"); // oldest 2 dropped
    expect(capped[49]!.at).toBe("t51");
  });

  test("floorQtyToStep floors to step + formats decimals; null below min", () => {
    expect(floorQtyToStep({ rawQty: 0.12345, qtyStep: "0.001", minOrderQty: "0.001" }))
      .toEqual({ qty: 0.123, qtyStr: "0.123" });
    expect(floorQtyToStep({ rawQty: 0.0005, qtyStep: "0.001", minOrderQty: "0.001" })).toBeNull();
    expect(floorQtyToStep({ rawQty: 50, qtyStep: "1", minOrderQty: "1" }))
      .toEqual({ qty: 50, qtyStr: "50" });
  });

  test("computeQtyFromNotional derives qty from notional × leverage / price, then floors", () => {
    expect(computeQtyFromNotional({
      notionalUsd: 100,
      leverage: 5,
      price: 50_000,
      qtyStep: "0.001",
      minOrderQty: "0.001",
    })).toEqual({ qty: 0.01, qtyStr: "0.010" });

    expect(computeQtyFromNotional({
      notionalUsd: 100,
      leverage: 0,
      price: 50_000,
      qtyStep: "0.001",
      minOrderQty: "0.001",
    })).toEqual({ qty: 0.002, qtyStr: "0.002" }); // leverage clamped to ≥1

    expect(computeQtyFromNotional({
      notionalUsd: 100, leverage: 1, price: 0, qtyStep: "0.001", minOrderQty: "0.001",
    })).toBeNull();
  });

  test("safeRemoveRepeatable returns true on success and false on missing key", async () => {
    const calls: Array<string> = [];
    const okQueue = { removeRepeatableByKey: async (k: string) => { calls.push(k); } };
    expect(await safeRemoveRepeatable({ queue: okQueue as any, repeatKey: "rk-1", event: "x" })).toBe(true);
    expect(calls).toEqual(["rk-1"]);

    expect(await safeRemoveRepeatable({ queue: okQueue as any, repeatKey: null, event: "x" })).toBe(false);
    expect(await safeRemoveRepeatable({ queue: okQueue as any, repeatKey: undefined, event: "x" })).toBe(false);

    const failingQueue = { removeRepeatableByKey: async () => { throw new Error("boom"); } };
    let logged: Record<string, unknown> | null = null;
    expect(await safeRemoveRepeatable({
      queue: failingQueue as any,
      repeatKey: "rk-2",
      event: "x-fail",
      log: (p) => { logged = p; },
    })).toBe(false);
    expect(logged).not.toBeNull();
    expect(logged!.event).toBe("x-fail");
    expect(String(logged!.error)).toContain("boom");
  });
});
