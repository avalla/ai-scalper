import { describe, expect, test } from "bun:test";
import {
  emptyAllocatorState,
  recordClosedTrade,
  selectChampion,
  DEFAULT_PNL_WINDOW_SIZE,
} from "./allocator";
import type { Variant } from "./variant-pool";
import type { StepParams } from "../trading/step";

const dummyParams: StepParams = {
  fastWindow: 5,
  slowWindow: 20,
  thresholdBps: 4,
  stopLossBps: 20,
  takeProfitBps: 30,
  leverage: 1,
  orderUsd: 100,
  maxPositionUsd: 1000,
  maxDailyLossUsd: 50,
  maxSpreadBps: 8,
  minTradeIntervalMs: 0,
};

function makeVariants(ids: string[]): Variant[] {
  return ids.map((id) => ({ id, label: id, params: dummyParams }));
}

/** Deterministic uniform RNG in (0, 1). */
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("selectChampion", () => {
  test("single-variant pool returns it directly", () => {
    const variants = makeVariants(["only-one"]);
    const result = selectChampion({
      allocator: emptyAllocatorState(),
      variants,
      now: 1,
    });
    expect(result.championId).toBe("only-one");
    expect(result.reason).toBe("single-variant");
  });

  test("cold start rotates through variants in deterministic warmup order", () => {
    const variants = makeVariants(["a", "b", "c", "d"]);
    let alloc = emptyAllocatorState();

    // Strict round-robin: cursor starts at 0, so pick "a" first.
    const first = selectChampion({ allocator: alloc, variants, now: 1 });
    expect(first.reason).toBe("warmup-rotation");
    expect(first.championId).toBe("a");
    alloc = first.allocator ?? alloc;

    alloc = recordClosedTrade(alloc, "a", 1, 1);
    const second = selectChampion({ allocator: alloc, variants, now: 2 });
    expect(second.reason).toBe("warmup-rotation");
    expect(second.championId).toBe("b");
    alloc = second.allocator ?? alloc;

    alloc = recordClosedTrade(alloc, "b", 1, 2);
    const third = selectChampion({ allocator: alloc, variants, now: 3 });
    expect(third.championId).toBe("c");
  });

  test("transitions from warmup-rotation to thompson-sample once all variants meet warmup", () => {
    const variants = makeVariants(["a", "b"]);
    let alloc = emptyAllocatorState();
    // Give each variant exactly warmupMinTrades=5 closed trades.
    for (let i = 0; i < 5; i++) {
      alloc = recordClosedTrade(alloc, "a", 0.1, i);
      alloc = recordClosedTrade(alloc, "b", -0.1, i);
    }
    const result = selectChampion({
      allocator: alloc,
      variants,
      now: 100,
      rng: seededRng(42),
    });
    expect(result.reason).toBe("thompson-sample");
    expect(["a", "b"]).toContain(result.championId);
  });

  test("strong winner is selected most of the time over many trials", () => {
    const variants = makeVariants(["winner", "loser"]);
    let alloc = emptyAllocatorState();
    // Winner: consistent +PnL. Loser: consistent -PnL.
    for (let i = 0; i < 20; i++) {
      alloc = recordClosedTrade(alloc, "winner", 1.0 + (i % 3) * 0.05, i);
      alloc = recordClosedTrade(alloc, "loser", -1.0 - (i % 3) * 0.05, i);
    }
    const rng = seededRng(7);
    let winnerCount = 0;
    const trials = 500;
    for (let i = 0; i < trials; i++) {
      const r = selectChampion({ allocator: alloc, variants, now: i, rng });
      if (r.championId === "winner") winnerCount++;
    }
    // Winner mean (~1.05) and loser mean (~-1.05) are very well separated
    // relative to σ/√n, so the winner should dominate strongly.
    expect(winnerCount / trials).toBeGreaterThan(0.95);
  });
});

describe("selectChampion - Phase 1A round-robin & time-decay", () => {
  test("strict round-robin sequence through 4 variants regardless of trades", () => {
    const variants = makeVariants(["a", "b", "c", "d"]);
    let alloc = emptyAllocatorState();
    const seq: string[] = [];
    for (let i = 0; i < 8; i++) {
      const r = selectChampion({ allocator: alloc, variants, now: i });
      seq.push(r.championId);
      // propagate cursor only — do NOT record trades; pure round-robin.
      if (r.allocator) alloc = r.allocator;
    }
    expect(seq).toEqual(["a", "b", "c", "d", "a", "b", "c", "d"]);
  });

  test("halfLifeDays undefined produces identical results to legacy code path", () => {
    const variants = makeVariants(["a", "b"]);
    let alloc = emptyAllocatorState();
    for (let i = 0; i < 5; i++) {
      alloc = recordClosedTrade(alloc, "a", 1, i);
      alloc = recordClosedTrade(alloc, "b", -1, i);
    }
    const rngA = seededRng(123);
    const rngB = seededRng(123);
    const r1 = selectChampion({ allocator: alloc, variants, now: 1000, rng: rngA });
    const r2 = selectChampion({ allocator: alloc, variants, now: 1000, rng: rngB, halfLifeDays: undefined });
    expect(r1.championId).toBe(r2.championId);
  });

  test("time-decay weights recent trades more (recent winner overtakes ancient winner)", () => {
    const variants = makeVariants(["a", "b"]);
    let alloc = emptyAllocatorState();
    const dayMs = 24 * 60 * 60 * 1000;
    // Variant "a": modest positive wins LONG ago (~30 days back), some variance.
    const aSamples = [9, 11, 10, 12, 8];
    for (let i = 0; i < aSamples.length; i++) {
      alloc = recordClosedTrade(alloc, "a", aSamples[i]!, i * 60_000); // ts: 0..4 minutes
    }
    // Variant "b": stronger recent positive PnLs, some variance.
    const bSamples = [3, 5, 4, 6, 2];
    for (let i = 0; i < bSamples.length; i++) {
      alloc = recordClosedTrade(alloc, "b", bSamples[i]!, 30 * dayMs + i * 60_000);
    }
    const now = 30 * dayMs + 10 * 60_000;

    // Without decay: μ_a=10, μ_b=4 → a wins.
    let aWinsNoDecay = 0;
    const trials = 300;
    let rng = seededRng(1);
    for (let i = 0; i < trials; i++) {
      const r = selectChampion({ allocator: alloc, variants, now, rng });
      if (r.championId === "a") aWinsNoDecay++;
    }
    expect(aWinsNoDecay / trials).toBeGreaterThan(0.8);

    // With halfLife=0.5d: a's samples are ~30d/0.5d = 60 half-lives old → weight ~0;
    // b's samples are ~10min old → near full weight → b wins despite lower raw μ.
    let bWinsDecay = 0;
    rng = seededRng(1);
    for (let i = 0; i < trials; i++) {
      const r = selectChampion({ allocator: alloc, variants, now, rng, halfLifeDays: 0.5 });
      if (r.championId === "b") bWinsDecay++;
    }
    // With near-zero weight on a, a's weighted mu floor is 0; b's weighted mu ≈ 4.
    expect(bWinsDecay / trials).toBeGreaterThan(0.8);
  });
});

describe("recordClosedTrade", () => {
  test("updates wins/losses/realizedPnl/window correctly", () => {
    let alloc = emptyAllocatorState();
    alloc = recordClosedTrade(alloc, "v1", 2, 100);
    alloc = recordClosedTrade(alloc, "v1", -1, 101);
    alloc = recordClosedTrade(alloc, "v1", 0, 102);

    const s = alloc.stats["v1"]!;
    expect(s.closedTrades).toBe(3);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
    expect(s.realizedPnlUsd).toBe(1);
    expect(s.recentPnlWindow).toEqual([2, -1, 0]);
    expect(s.lastUpdatedAt).toBe(102);
  });

  test("drops oldest entry once the FIFO window exceeds the cap (K=50)", () => {
    let alloc = emptyAllocatorState();
    // Push 52 trades; the first 2 should drop out.
    for (let i = 0; i < 52; i++) {
      alloc = recordClosedTrade(alloc, "v1", i, i);
    }
    const s = alloc.stats["v1"]!;
    expect(s.closedTrades).toBe(52);
    expect(s.recentPnlWindow.length).toBe(DEFAULT_PNL_WINDOW_SIZE);
    expect(s.recentPnlWindow[0]).toBe(2);
    expect(s.recentPnlWindow[s.recentPnlWindow.length - 1]).toBe(51);
  });
});
