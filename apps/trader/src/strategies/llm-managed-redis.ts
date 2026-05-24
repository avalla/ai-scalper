/**
 * llm-managed shared state — Phase 1 (BullMQ migration).
 *
 * Cross-process state coordination for the new llm-managed worker pair
 * (open-decision worker + manage worker). Everything is keyed in Redis
 * so it survives bot restarts and is visible to BOTH workers.
 *
 * KEYS:
 *   - ai-scalper:llm-managed:last-cut-loss-at  (number — epoch ms)
 *
 * Active-position counting is NOT done here; it is queried directly from
 * the trade-management queue via `getActive() + getDelayed() + getWaiting()`.
 * That avoids dual-write hazards between Redis state and BullMQ state.
 */

const LAST_CUT_LOSS_KEY = "ai-scalper:llm-managed:last-cut-loss-at";

/**
 * Minimal Redis interface the helper depends on. ioredis implements this
 * natively; tests can pass an in-memory mock implementing the same shape.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
}

export interface LlmManagedSharedState {
  /**
   * Returns `true` iff there are currently 1+ trade-management jobs for the
   * llm-managed strategy that are waiting, delayed, or being processed.
   * Used by the OPEN worker to enforce 1-position-at-a-time.
   */
  hasActivePosition(): Promise<boolean>;

  /** Returns the count of active/waiting/delayed manage jobs. */
  getActivePositionCount(): Promise<number>;

  /** Persist last-cut-loss timestamp (epoch ms). */
  setLastCutLossAt(now: number): Promise<void>;

  /** Read last-cut-loss timestamp (epoch ms). Returns 0 if unset. */
  getLastCutLossAt(): Promise<number>;

  /**
   * Returns the number of ms still remaining in the cooldown window
   * after the last cut-loss, given the configured cooldownMs. 0 when not
   * in cooldown.
   */
  getCooldownRemainingMs(now: number, cooldownMs: number): Promise<number>;
}

/**
 * Minimal queue-like shape so unit tests can pass a stub without a real
 * BullMQ instance.
 */
export interface ActivePositionCounterQueue {
  getActiveCount(): Promise<number>;
  getWaitingCount(): Promise<number>;
  getDelayedCount(): Promise<number>;
}

export function createLlmManagedSharedState(deps: {
  redis: RedisLike;
  manageQueue: ActivePositionCounterQueue;
}): LlmManagedSharedState {
  const { redis, manageQueue } = deps;
  return {
    async hasActivePosition(): Promise<boolean> {
      const count = await this.getActivePositionCount();
      return count > 0;
    },

    async getActivePositionCount(): Promise<number> {
      const [active, waiting, delayed] = await Promise.all([
        manageQueue.getActiveCount(),
        manageQueue.getWaitingCount(),
        manageQueue.getDelayedCount(),
      ]);
      return active + waiting + delayed;
    },

    async setLastCutLossAt(now: number): Promise<void> {
      await redis.set(LAST_CUT_LOSS_KEY, String(now));
    },

    async getLastCutLossAt(): Promise<number> {
      const raw = await redis.get(LAST_CUT_LOSS_KEY);
      if (raw === null) return 0;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : 0;
    },

    async getCooldownRemainingMs(now: number, cooldownMs: number): Promise<number> {
      const last = await this.getLastCutLossAt();
      if (last <= 0) return 0;
      const remaining = last + cooldownMs - now;
      return remaining > 0 ? remaining : 0;
    },
  };
}

/** Exposed so tests can assert exact key strings. */
export const __INTERNAL = { LAST_CUT_LOSS_KEY };
