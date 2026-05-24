import { describe, expect, test } from "bun:test";
import {
  __INTERNAL,
  createLlmManagedSharedState,
  type ActivePositionCounterQueue,
  type RedisLike,
} from "./llm-managed-redis";

function makeRedisMock(initial: Record<string, string> = {}): RedisLike & { _store: Map<string, string> } {
  const store = new Map(Object.entries(initial));
  return {
    _store: store,
    async get(key: string) {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    async set(key: string, value: string) {
      store.set(key, value);
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

describe("llm-managed shared state", () => {
  test("hasActivePosition is false when manageQueue is empty", async () => {
    const state = createLlmManagedSharedState({
      redis: makeRedisMock(),
      manageQueue: makeQueueMock(),
    });
    expect(await state.hasActivePosition()).toBe(false);
    expect(await state.getActivePositionCount()).toBe(0);
  });

  test("hasActivePosition is true when any of active/waiting/delayed > 0", async () => {
    const stateA = createLlmManagedSharedState({
      redis: makeRedisMock(),
      manageQueue: makeQueueMock({ active: 1 }),
    });
    expect(await stateA.hasActivePosition()).toBe(true);

    const stateB = createLlmManagedSharedState({
      redis: makeRedisMock(),
      manageQueue: makeQueueMock({ delayed: 1 }),
    });
    expect(await stateB.hasActivePosition()).toBe(true);

    const stateC = createLlmManagedSharedState({
      redis: makeRedisMock(),
      manageQueue: makeQueueMock({ waiting: 2, active: 1, delayed: 1 }),
    });
    expect(await stateC.getActivePositionCount()).toBe(4);
  });

  test("setLastCutLossAt + getLastCutLossAt round-trip via Redis key", async () => {
    const redis = makeRedisMock();
    const state = createLlmManagedSharedState({ redis, manageQueue: makeQueueMock() });

    expect(await state.getLastCutLossAt()).toBe(0);
    await state.setLastCutLossAt(1_700_000_000_000);
    expect(await state.getLastCutLossAt()).toBe(1_700_000_000_000);
    expect(redis._store.get(__INTERNAL.LAST_CUT_LOSS_KEY)).toBe("1700000000000");
  });

  test("getCooldownRemainingMs returns 0 when no cut-loss has been recorded", async () => {
    const state = createLlmManagedSharedState({
      redis: makeRedisMock(),
      manageQueue: makeQueueMock(),
    });
    expect(await state.getCooldownRemainingMs(Date.now(), 30 * 60_000)).toBe(0);
  });

  test("getCooldownRemainingMs returns positive ms during cooldown and 0 after expiry", async () => {
    const redis = makeRedisMock();
    const state = createLlmManagedSharedState({ redis, manageQueue: makeQueueMock() });
    await state.setLastCutLossAt(1_000_000);

    expect(await state.getCooldownRemainingMs(1_000_100, 1_000)).toBe(900);
    expect(await state.getCooldownRemainingMs(1_001_000, 1_000)).toBe(0);
    expect(await state.getCooldownRemainingMs(1_005_000, 1_000)).toBe(0);
  });
});
