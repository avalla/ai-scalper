import { describe, expect, test } from "bun:test";
import {
  __INTERNAL,
  createStrategySharedState,
  sharedStateKeys,
  type ActivePositionCounterQueue,
  type RedisLike,
} from "./bullmq-shared-state";

function makeRedisMock(initial: Record<string, string> = {}): RedisLike & { _store: Map<string, string> } {
  const store = new Map(Object.entries(initial));
  return {
    _store: store,
    async get(key: string) {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    async set(key: string, val: string) {
      store.set(key, val);
      return "OK";
    },
  };
}

function makeQueueMock(counts: { active?: number; waiting?: number; delayed?: number } = {}): ActivePositionCounterQueue {
  return {
    async getActiveCount() { return counts.active ?? 0; },
    async getWaitingCount() { return counts.waiting ?? 0; },
    async getDelayedCount() { return counts.delayed ?? 0; },
  };
}

describe("strategy shared state factory", () => {
  test("namespaces Redis keys per strategy (no leakage across strategies)", async () => {
    const redis = makeRedisMock();
    const aState = createStrategySharedState({ strategy: "funding-arb", redis, manageQueue: makeQueueMock() });
    const bState = createStrategySharedState({ strategy: "longer-tf", redis, manageQueue: makeQueueMock() });

    await aState.setLastCutLossAt(1_700_000_000_000);
    await bState.setLastCutLossAt(1_800_000_000_000);

    expect(await aState.getLastCutLossAt()).toBe(1_700_000_000_000);
    expect(await bState.getLastCutLossAt()).toBe(1_800_000_000_000);
    expect(redis._store.get("ai-scalper:funding-arb:last-cut-loss-at")).toBe("1700000000000");
    expect(redis._store.get("ai-scalper:longer-tf:last-cut-loss-at")).toBe("1800000000000");
  });

  test("hasActivePosition reflects manageQueue active+waiting+delayed sum", async () => {
    const state = createStrategySharedState({
      strategy: "bollinger-adx",
      redis: makeRedisMock(),
      manageQueue: makeQueueMock({ active: 1, waiting: 2, delayed: 1 }),
    });
    expect(await state.getActivePositionCount()).toBe(4);
    expect(await state.hasActivePosition()).toBe(true);
  });

  test("cooldown countdown: positive while inside window, 0 once expired", async () => {
    const state = createStrategySharedState({
      strategy: "basis-arb",
      redis: makeRedisMock(),
      manageQueue: makeQueueMock(),
    });
    await state.setLastCutLossAt(1_000_000);
    expect(await state.getCooldownRemainingMs(1_000_100, 1_000)).toBe(900);
    expect(await state.getCooldownRemainingMs(1_001_000, 1_000)).toBe(0);
    expect(await state.getCooldownRemainingMs(1_005_000, 1_000)).toBe(0);
  });

  test("setLastTradeAt / getLastTradeAt round-trip via namespaced Redis key", async () => {
    const redis = makeRedisMock();
    const state = createStrategySharedState({ strategy: "pairs-trading", redis, manageQueue: makeQueueMock() });

    expect(await state.getLastTradeAt()).toBe(0);
    await state.setLastTradeAt(1_700_111_222_333);
    expect(await state.getLastTradeAt()).toBe(1_700_111_222_333);
    expect(redis._store.get("ai-scalper:pairs-trading:last-trade-at")).toBe("1700111222333");
  });

  test("rejects invalid strategy names (must be lowercase/digits/dash)", () => {
    expect(() => createStrategySharedState({
      strategy: "Funding Arb",
      redis: makeRedisMock(),
      manageQueue: makeQueueMock(),
    })).toThrow(/invalid strategy name/);
  });

  test("sharedStateKeys exposes the exact wire format used in Redis", () => {
    expect(sharedStateKeys("calendar-spread")).toEqual({
      lastCutLossAt: "ai-scalper:calendar-spread:last-cut-loss-at",
      lastTradeAt: "ai-scalper:calendar-spread:last-trade-at",
    });
    expect(__INTERNAL.sharedStateKeys("ma-crossover").lastCutLossAt).toBe(
      "ai-scalper:ma-crossover:last-cut-loss-at",
    );
  });
});
