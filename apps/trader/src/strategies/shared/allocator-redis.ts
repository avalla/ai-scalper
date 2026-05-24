/**
 * Redis-backed `AllocatorState` store for the ma-crossover Phase 2 BullMQ
 * migration. Lets multiple workers / processes share the same bandit state
 * without dual-writes between filesystem (legacy `persistAllocatorState`) and
 * Redis.
 *
 * Concurrency: the ma-crossover open-worker runs at concurrency 1, so within
 * a single process there is no race. Cross-process races are mitigated by the
 * `if (currentChampion !== expected)` cooperative pattern in callers — for
 * simplicity we do a plain GET + SET round-trip rather than full WATCH/MULTI.
 *
 * Wire format: JSON.stringify of the `AllocatorState` object under the key
 * `ai-scalper:ma-crossover:allocator-state`.
 */

import type { AllocatorState } from "../../meta/allocator";

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, val: string): Promise<unknown>;
}

const ALLOCATOR_KEY = "ai-scalper:ma-crossover:allocator-state";

export interface AllocatorStore {
  load(): Promise<AllocatorState | null>;
  save(state: AllocatorState): Promise<void>;
}

export function createAllocatorRedisStore(redis: RedisLike): AllocatorStore {
  return {
    async load() {
      try {
        const raw = await redis.get(ALLOCATOR_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as AllocatorState;
        if (!parsed || typeof parsed !== "object" || typeof parsed.stats !== "object") {
          return null;
        }
        return parsed;
      } catch {
        return null;
      }
    },
    async save(state: AllocatorState) {
      await redis.set(ALLOCATOR_KEY, JSON.stringify(state));
    },
  };
}

export const __INTERNAL = { ALLOCATOR_KEY };
