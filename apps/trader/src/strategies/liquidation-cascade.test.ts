import { describe, expect, it } from "bun:test";
import {
  detectClusters,
  liquidationCascadeDecide,
  type LiquidationPrint,
} from "./liquidation-cascade";

const now = 1_700_000_000_000;
const baseInput = { windowMs: 30_000, minClusterUsd: 25_000, minCount: 3, now };

function prints(...arr: Partial<LiquidationPrint>[]): LiquidationPrint[] {
  return arr.map((p, i) => ({
    ts: p.ts ?? now - i * 1000,
    symbol: p.symbol ?? "BTCUSDT",
    side: p.side ?? "Sell",
    sizeUsd: p.sizeUsd ?? 10_000,
  }));
}

describe("liquidationCascadeDecide", () => {
  it("skips when no liquidations are present", () => {
    const d = liquidationCascadeDecide({ ...baseInput, recentLiquidations: [] });
    expect(d.kind).toBe("skip");
    expect(d.kind === "skip" && d.reason).toBe("no-liquidations");
  });

  it("skips when single small liquidation is below threshold", () => {
    const d = liquidationCascadeDecide({
      ...baseInput,
      recentLiquidations: prints({ sizeUsd: 1_000 }),
    });
    expect(d.kind).toBe("skip");
  });

  it("enters LONG when LONGS are liquidated (side=Sell cluster)", () => {
    const d = liquidationCascadeDecide({
      ...baseInput,
      recentLiquidations: prints(
        { side: "Sell", sizeUsd: 20_000 },
        { side: "Sell", sizeUsd: 20_000 },
        { side: "Sell", sizeUsd: 20_000 },
      ),
    });
    expect(d.kind).toBe("enter");
    if (d.kind === "enter") {
      expect(d.side).toBe("long");
      expect(d.symbol).toBe("BTCUSDT");
      expect(d.clusterUsd).toBe(60_000);
      expect(d.reason).toContain("longs-liquidated");
    }
  });

  it("enters SHORT when SHORTS are liquidated (side=Buy cluster)", () => {
    const d = liquidationCascadeDecide({
      ...baseInput,
      recentLiquidations: prints(
        { side: "Buy", sizeUsd: 20_000 },
        { side: "Buy", sizeUsd: 20_000 },
        { side: "Buy", sizeUsd: 20_000 },
      ),
    });
    expect(d.kind).toBe("enter");
    if (d.kind === "enter") {
      expect(d.side).toBe("short");
      expect(d.reason).toContain("shorts-liquidated");
    }
  });

  it("groups by symbol — only triggers per-symbol clusters", () => {
    const clusters = detectClusters({
      ...baseInput,
      recentLiquidations: [
        ...prints({ symbol: "BTCUSDT", side: "Sell", sizeUsd: 30_000 }),
        ...prints({ symbol: "ETHUSDT", side: "Sell", sizeUsd: 30_000 }),
        ...prints({ symbol: "BTCUSDT", side: "Sell", sizeUsd: 30_000, ts: now - 2000 }),
        ...prints({ symbol: "ETHUSDT", side: "Sell", sizeUsd: 30_000, ts: now - 2000 }),
        ...prints({ symbol: "BTCUSDT", side: "Sell", sizeUsd: 30_000, ts: now - 3000 }),
        ...prints({ symbol: "ETHUSDT", side: "Sell", sizeUsd: 30_000, ts: now - 3000 }),
      ],
    });
    expect(clusters.length).toBe(2);
    const syms = clusters.map((c) => c.symbol).sort();
    expect(syms).toEqual(["BTCUSDT", "ETHUSDT"]);
  });

  it("excludes stale liquidations beyond windowMs", () => {
    const d = liquidationCascadeDecide({
      ...baseInput,
      recentLiquidations: prints(
        { side: "Sell", sizeUsd: 100_000, ts: now - 60_000 },
        { side: "Sell", sizeUsd: 100_000, ts: now - 60_000 },
        { side: "Sell", sizeUsd: 100_000, ts: now - 60_000 },
      ),
    });
    expect(d.kind).toBe("skip");
  });

  it("ranks clusters by total notional and picks the largest", () => {
    const d = liquidationCascadeDecide({
      ...baseInput,
      recentLiquidations: [
        ...prints({ symbol: "BTCUSDT", side: "Sell", sizeUsd: 10_000 }),
        ...prints({ symbol: "BTCUSDT", side: "Sell", sizeUsd: 10_000, ts: now - 1000 }),
        ...prints({ symbol: "BTCUSDT", side: "Sell", sizeUsd: 10_000, ts: now - 2000 }),
        ...prints({ symbol: "ETHUSDT", side: "Buy", sizeUsd: 50_000 }),
        ...prints({ symbol: "ETHUSDT", side: "Buy", sizeUsd: 50_000, ts: now - 1000 }),
        ...prints({ symbol: "ETHUSDT", side: "Buy", sizeUsd: 50_000, ts: now - 2000 }),
      ],
    });
    expect(d.kind).toBe("enter");
    if (d.kind === "enter") {
      expect(d.symbol).toBe("ETHUSDT");
      expect(d.side).toBe("short"); // shorts liquidated (Buy side)
    }
  });

  it("requires both minCount AND minClusterUsd", () => {
    // 2 prints summing to $100k — fails minCount=3
    const d = liquidationCascadeDecide({
      ...baseInput,
      recentLiquidations: prints(
        { side: "Sell", sizeUsd: 50_000 },
        { side: "Sell", sizeUsd: 50_000 },
      ),
    });
    expect(d.kind).toBe("skip");
  });
});
