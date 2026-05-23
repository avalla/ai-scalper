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

    // With zero trades for every variant, ties break by lexical id → "a".
    const first = selectChampion({ allocator: alloc, variants, now: 1 });
    expect(first.reason).toBe("warmup-rotation");
    expect(first.championId).toBe("a");

    alloc = recordClosedTrade(alloc, "a", 1, 1);
    const second = selectChampion({ allocator: alloc, variants, now: 2 });
    expect(second.reason).toBe("warmup-rotation");
    expect(second.championId).toBe("b"); // a now has 1 trade, b/c/d have 0

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
