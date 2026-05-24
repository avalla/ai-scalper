import { describe, expect, test } from "bun:test";
import { __INTERNAL, createAllocatorRedisStore, type RedisLike } from "./allocator-redis";
import { emptyAllocatorState, recordClosedTrade } from "../../meta/allocator";

function makeRedis(): RedisLike & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    _store: store,
    async get(k) { return store.has(k) ? store.get(k)! : null; },
    async set(k, v) { store.set(k, v); return "OK"; },
  };
}

describe("allocator-redis store", () => {
  test("load returns null when key missing", async () => {
    const store = createAllocatorRedisStore(makeRedis());
    expect(await store.load()).toBeNull();
  });

  test("save+load round-trip preserves recordClosedTrade mutations", async () => {
    const redis = makeRedis();
    const store = createAllocatorRedisStore(redis);
    const a0 = emptyAllocatorState();
    const a1 = recordClosedTrade(a0, "ma-5-20-th4", 2.5, 1_700_000_000_000);
    await store.save(a1);
    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.stats["ma-5-20-th4"]!.closedTrades).toBe(1);
    expect(loaded!.stats["ma-5-20-th4"]!.realizedPnlUsd).toBe(2.5);
    // Wire format is at the documented key.
    expect(redis._store.has(__INTERNAL.ALLOCATOR_KEY)).toBe(true);
  });

  test("load returns null on malformed JSON / bad shape", async () => {
    const redis = makeRedis();
    redis._store.set(__INTERNAL.ALLOCATOR_KEY, "not json");
    expect(await createAllocatorRedisStore(redis).load()).toBeNull();
    redis._store.set(__INTERNAL.ALLOCATOR_KEY, JSON.stringify({ no: "stats" }));
    expect(await createAllocatorRedisStore(redis).load()).toBeNull();
  });
});
