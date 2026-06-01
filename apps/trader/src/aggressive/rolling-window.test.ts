import { describe, expect, test } from "bun:test";
import { createRollingWindowStore } from "./rolling-window";

describe("RollingWindowStore", () => {
  test("snapshot is null before any push", () => {
    const s = createRollingWindowStore({ windowMs: 60_000 });
    expect(s.snapshot("BTCUSDT")).toBeNull();
  });

  test("push + snapshot returns the samples", () => {
    let t = 1_700_000_000_000;
    const s = createRollingWindowStore({ windowMs: 60_000, now: () => t });
    s.push("BTCUSDT", { ts: t, price: 73_000, incrementalVolumeUsd: 1000 });
    s.push("BTCUSDT", { ts: t + 5_000, price: 73_050, incrementalVolumeUsd: 500 });
    const snap = s.snapshot("BTCUSDT")!;
    expect(snap.symbol).toBe("BTCUSDT");
    expect(snap.samples).toHaveLength(2);
    expect(snap.samples[0]!.price).toBe(73_000);
    expect(snap.samples[1]!.incrementalVolumeUsd).toBe(500);
  });

  test("prunes samples older than windowMs", () => {
    let t = 1_700_000_000_000;
    const s = createRollingWindowStore({ windowMs: 10_000, now: () => t });
    s.push("X", { ts: t, price: 100, incrementalVolumeUsd: 10 });
    s.push("X", { ts: t + 5_000, price: 110, incrementalVolumeUsd: 20 });
    t = t + 20_000; // both old now relative to windowMs=10_000
    s.push("X", { ts: t, price: 120, incrementalVolumeUsd: 30 });
    const snap = s.snapshot("X")!;
    // First two should be pruned (their ts < now-windowMs)
    expect(snap.samples).toHaveLength(1);
    expect(snap.samples[0]!.price).toBe(120);
  });

  test("computes incremental volume from cumulativeVolumeUsd diffs", () => {
    let t = 1_700_000_000_000;
    const s = createRollingWindowStore({ windowMs: 60_000, now: () => t });
    s.push("X", { ts: t, price: 100, cumulativeVolumeUsd: 1000 });   // first → 0
    s.push("X", { ts: t + 5_000, price: 110, cumulativeVolumeUsd: 1500 }); // +500
    s.push("X", { ts: t + 10_000, price: 120, cumulativeVolumeUsd: 1700 }); // +200
    const snap = s.snapshot("X")!;
    expect(snap.samples.map((x) => x.incrementalVolumeUsd)).toEqual([0, 500, 200]);
  });

  test("baselineWindowVolumeUsd reflects scaled long-history average", () => {
    let t = 1_700_000_000_000;
    const s = createRollingWindowStore({ windowMs: 10_000, baselineWindowMs: 100_000, now: () => t });
    // Push 10 samples evenly over 90 seconds with vol 100 each = total 1000 over ~90s
    for (let i = 0; i < 10; i += 1) {
      s.push("X", { ts: t + i * 9_000, price: 100, incrementalVolumeUsd: 100 });
    }
    t = t + 10 * 9_000;
    const snap = s.snapshot("X")!;
    // Baseline span ~81s, total ~1000, scaled to 10s window → ~123
    expect(snap.baselineWindowVolumeUsd).toBeGreaterThan(80);
    expect(snap.baselineWindowVolumeUsd).toBeLessThan(200);
  });

  test("symbols() lists tracked symbols, drop() removes", () => {
    const t = 1_700_000_000_000;
    const s = createRollingWindowStore({ windowMs: 10_000, now: () => t });
    s.push("BTCUSDT", { ts: t, price: 73_000 });
    s.push("ETHUSDT", { ts: t, price: 3_800 });
    expect(s.symbols().sort()).toEqual(["BTCUSDT", "ETHUSDT"]);
    s.drop("BTCUSDT");
    expect(s.symbols()).toEqual(["ETHUSDT"]);
  });

  test("rejects invalid samples (NaN price, zero price)", () => {
    const t = 1_700_000_000_000;
    const s = createRollingWindowStore({ windowMs: 60_000, now: () => t });
    s.push("X", { ts: t, price: Number.NaN, incrementalVolumeUsd: 100 });
    s.push("X", { ts: t, price: 0, incrementalVolumeUsd: 100 });
    expect(s.snapshot("X")).toBeNull();
  });

  test("cap on samplesPerWindow drops oldest", () => {
    let t = 1_700_000_000_000;
    const s = createRollingWindowStore({ windowMs: 1_000_000, samplesPerWindow: 3, now: () => t });
    for (let i = 0; i < 5; i += 1) {
      s.push("X", { ts: t + i * 1000, price: 100 + i, incrementalVolumeUsd: 1 });
    }
    const snap = s.snapshot("X")!;
    expect(snap.samples).toHaveLength(3);
    expect(snap.samples[0]!.price).toBe(102); // oldest 2 dropped
  });
});
