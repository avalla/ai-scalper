import { describe, expect, test } from "bun:test";
import { createPositionLedger } from "./position-ledger";

function createRedisStub() {
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();

  return {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => {
      values.set(key, value);
    },
    lpush: async (key: string, value: string) => {
      const existing = lists.get(key) ?? [];
      existing.unshift(value);
      lists.set(key, existing);
      return existing.length;
    },
    ltrim: async (key: string, start: number, stop: number) => {
      const existing = lists.get(key) ?? [];
      lists.set(key, existing.slice(start, stop + 1));
    },
    quit: async () => "OK",
    disconnect: () => undefined,
    values,
    lists,
  };
}

describe("position ledger", () => {
  test("hydrates a persisted open position snapshot", async () => {
    const redis = createRedisStub();
    await redis.set("ai-scalper:trader:position-state", JSON.stringify({
      lastTradeAt: 123,
      realizedPnlUsd: 4.2,
      position: {
        side: "long",
        quantity: 2,
        notionalUsd: 200,
        entryPrice: 100,
        leverage: 5,
        openedAt: 120,
        stopLossPrice: 99.8,
        takeProfitPrice: 100.3,
      },
      openPositionSymbol: "BTCUSDT",
      updatedAt: "2026-04-05T00:00:00.000Z",
    }));

    const ledger = createPositionLedger(redis);
    await expect(ledger.loadSnapshot()).resolves.toMatchObject({
      openPositionSymbol: "BTCUSDT",
      realizedPnlUsd: 4.2,
      position: {
        side: "long",
        openedAt: 120,
      },
    });
  });

  test("stores closed positions as a capped list", async () => {
    const redis = createRedisStub();
    const ledger = createPositionLedger(redis);

    await ledger.appendClosedPosition({
      closedAt: "2026-04-05T00:00:10.000Z",
      cumulativeRealizedPnlUsd: 1,
      entryPrice: 100,
      exitPrice: 101,
      exitReason: "take-profit",
      leverage: 5,
      notionalUsd: 100,
      openedAt: "2026-04-05T00:00:00.000Z",
      quantity: 1,
      realizedPnlUsd: 1,
      side: "long",
      stopLossPrice: 99.8,
      symbol: "BTCUSDT",
      takeProfitPrice: 100.3,
    });

    const stored = redis.lists.get("ai-scalper:trader:positions:closed");
    expect(stored).toHaveLength(1);
    expect(stored?.[0]).toContain("\"exitReason\":\"take-profit\"");
  });
});
