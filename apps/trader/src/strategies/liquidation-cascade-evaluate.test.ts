import { describe, expect, it } from "bun:test";
import { evaluateLiquidationCascade, type LiquidationsReader } from "./liquidation-cascade-evaluate";

function fakeCache(byteSymbol: Record<string, Array<{ ts: number; side: "Buy" | "Sell"; sizeUsd: number }>>): LiquidationsReader {
  return {
    async getRecent(symbol, sinceMs) {
      return (byteSymbol[symbol] ?? []).filter((p) => p.ts >= sinceMs);
    },
  };
}

describe("evaluateLiquidationCascade (glue)", () => {
  const now = 100_000;
  const windowMs = 30_000;

  it("returns enter LONG when longs are liquidated (side=Sell cluster)", async () => {
    const cache = fakeCache({
      BTCUSDT: [
        { ts: now - 10_000, side: "Sell", sizeUsd: 20_000 },
        { ts: now - 9_000, side: "Sell", sizeUsd: 15_000 },
        { ts: now - 8_000, side: "Sell", sizeUsd: 12_000 },
        { ts: now - 7_000, side: "Sell", sizeUsd: 11_000 },
        { ts: now - 6_000, side: "Sell", sizeUsd: 10_000 },
      ],
    });
    const decision = await evaluateLiquidationCascade({
      cache,
      symbols: ["BTCUSDT"],
      windowMs,
      minClusterUsd: 50_000,
      minCount: 5,
      now,
    });
    expect(decision.kind).toBe("enter");
    if (decision.kind === "enter") {
      expect(decision.side).toBe("long");
      expect(decision.symbol).toBe("BTCUSDT");
      expect(decision.clusterUsd).toBeGreaterThanOrEqual(50_000);
    }
  });

  it("returns enter SHORT when shorts are liquidated (side=Buy cluster)", async () => {
    const cache = fakeCache({
      ETHUSDT: [
        { ts: now - 5_000, side: "Buy", sizeUsd: 30_000 },
        { ts: now - 4_000, side: "Buy", sizeUsd: 30_000 },
        { ts: now - 3_000, side: "Buy", sizeUsd: 25_000 },
        { ts: now - 2_000, side: "Buy", sizeUsd: 20_000 },
        { ts: now - 1_000, side: "Buy", sizeUsd: 20_000 },
      ],
    });
    const decision = await evaluateLiquidationCascade({
      cache,
      symbols: ["ETHUSDT"],
      windowMs,
      minClusterUsd: 50_000,
      minCount: 5,
      now,
    });
    expect(decision.kind).toBe("enter");
    if (decision.kind === "enter") {
      expect(decision.side).toBe("short");
      expect(decision.symbol).toBe("ETHUSDT");
    }
  });

  it("returns skip when cluster size below threshold", async () => {
    const cache = fakeCache({
      BTCUSDT: [
        { ts: now - 5_000, side: "Sell", sizeUsd: 1_000 },
        { ts: now - 4_000, side: "Sell", sizeUsd: 1_000 },
      ],
    });
    const decision = await evaluateLiquidationCascade({
      cache,
      symbols: ["BTCUSDT"],
      windowMs,
      minClusterUsd: 50_000,
      minCount: 5,
      now,
    });
    expect(decision.kind).toBe("skip");
  });

  it("excludes prints outside the window", async () => {
    const cache = fakeCache({
      BTCUSDT: [
        // ALL outside the 30s window
        { ts: now - 120_000, side: "Sell", sizeUsd: 100_000 },
        { ts: now - 100_000, side: "Sell", sizeUsd: 100_000 },
      ],
    });
    const decision = await evaluateLiquidationCascade({
      cache,
      symbols: ["BTCUSDT"],
      windowMs: 30_000,
      minClusterUsd: 50_000,
      minCount: 1,
      now,
    });
    expect(decision.kind).toBe("skip");
  });

  it("picks the largest cluster across multiple symbols", async () => {
    const cache = fakeCache({
      BTCUSDT: [
        { ts: now - 5_000, side: "Sell", sizeUsd: 15_000 },
        { ts: now - 4_000, side: "Sell", sizeUsd: 15_000 },
        { ts: now - 3_000, side: "Sell", sizeUsd: 12_000 },
        { ts: now - 2_000, side: "Sell", sizeUsd: 10_000 },
        { ts: now - 1_000, side: "Sell", sizeUsd: 10_000 },
      ],
      ETHUSDT: [
        { ts: now - 5_000, side: "Sell", sizeUsd: 60_000 },
        { ts: now - 4_000, side: "Sell", sizeUsd: 60_000 },
        { ts: now - 3_000, side: "Sell", sizeUsd: 50_000 },
        { ts: now - 2_000, side: "Sell", sizeUsd: 50_000 },
        { ts: now - 1_000, side: "Sell", sizeUsd: 50_000 },
      ],
    });
    const decision = await evaluateLiquidationCascade({
      cache,
      symbols: ["BTCUSDT", "ETHUSDT"],
      windowMs,
      minClusterUsd: 50_000,
      minCount: 5,
      now,
    });
    expect(decision.kind).toBe("enter");
    if (decision.kind === "enter") {
      expect(decision.symbol).toBe("ETHUSDT");
    }
  });
});
