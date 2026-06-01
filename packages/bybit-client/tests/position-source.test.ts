import { describe, expect, it } from "bun:test";
import {
  createRestPositionSource,
  createWsPrivatePositionSource,
} from "../src/position-source";
import type { PositionInfo } from "../src/index";

const fakeRest = (positions: Map<string, PositionInfo | null>): any => ({
  async getPosition({ symbol }: { symbol: string }) {
    return positions.get(symbol) ?? null;
  },
});

describe("createRestPositionSource", () => {
  it("delegates to client.getPosition and caches the last seen value", async () => {
    const positions = new Map<string, PositionInfo>([
      ["BTCUSDT", { symbol: "BTCUSDT", side: "Buy", size: "0.5", avgPrice: "60000", stopLoss: "", takeProfit: "" }],
    ]);
    const src = createRestPositionSource(fakeRest(positions));
    const got = await src.getPosition("BTCUSDT");
    expect(got?.size).toBe("0.5");
    expect(src.peek("BTCUSDT")?.size).toBe("0.5");
    expect(src.peek("ETHUSDT")).toBeNull();
  });
});

describe("createWsPrivatePositionSource", () => {
  const baseWs = (snap: PositionInfo | null, lastMessageAt: number | null) => ({
    getPosition: () => snap,
    stats: () => ({
      messagesReceived: 0, reconnects: 0, authSuccesses: 0, authFailures: 0,
      lastMessageAt,
    }),
  });

  it("returns the cached snapshot when fresh", async () => {
    const snap: PositionInfo = { symbol: "BTCUSDT", side: "Sell", size: "1.0", avgPrice: "50000", stopLoss: "", takeProfit: "" };
    let restCalls = 0;
    const src = createWsPrivatePositionSource({
      ws: baseWs(snap, 1_000),
      fallback: { async getPosition() { restCalls += 1; return null; } } as any,
      now: () => 2_000, // age = 1s, fresh
      defaultMaxAgeMs: 5_000,
    });
    const got = await src.getPosition("BTCUSDT");
    expect(got?.size).toBe("1.0");
    expect(restCalls).toBe(0);
  });

  it("falls back to REST when cache is stale", async () => {
    const snap: PositionInfo = { symbol: "BTCUSDT", side: "Buy", size: "0.3", avgPrice: "60000", stopLoss: "", takeProfit: "" };
    let restCalls = 0;
    const restSnap: PositionInfo = { symbol: "BTCUSDT", side: "Buy", size: "0.5", avgPrice: "60000", stopLoss: "", takeProfit: "" };
    const src = createWsPrivatePositionSource({
      ws: baseWs(snap, 1_000),
      fallback: { async getPosition() { restCalls += 1; return restSnap; } } as any,
      now: () => 10_000, // age = 9s > 5s default
    });
    const got = await src.getPosition("BTCUSDT");
    expect(got?.size).toBe("0.5"); // came from REST
    expect(restCalls).toBe(1);
  });

  it("falls back to REST when cache is empty", async () => {
    let restCalls = 0;
    const src = createWsPrivatePositionSource({
      ws: baseWs(null, null),
      fallback: { async getPosition() { restCalls += 1; return null; } } as any,
      now: () => 0,
    });
    await src.getPosition("ETHUSDT");
    expect(restCalls).toBe(1);
  });
});
