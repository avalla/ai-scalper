/**
 * Generic per-strategy shared state for Phase 2 BullMQ migration.
 *
 * Each strategy gets its own Redis namespace via the `strategy` parameter so
 * the same factory can be reused for funding-arb, longer-tf, bollinger-adx,
 * basis-arb, pairs-trading, calendar-spread and ma-crossover without
 * leaking cooldown / active-position state across strategies.
 *
 * Active-position counting goes through the trade-management BullMQ queue
 * (active + waiting + delayed) rather than a duplicate Redis key, which
 * avoids dual-write hazards between the workers' authoritative queue state
 * and an out-of-band counter.
 */

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, val: string): Promise<unknown>;
}

export interface ActivePositionCounterQueue {
  getActiveCount(): Promise<number>;
  getWaitingCount(): Promise<number>;
  getDelayedCount(): Promise<number>;
}

export interface StrategySharedState {
  /** True iff there are 1+ live trade-management jobs (active/waiting/delayed). */
  hasActivePosition(): Promise<boolean>;
  /** Live trade-management job count. */
  getActivePositionCount(): Promise<number>;
  /** Persist last-cut-loss timestamp (epoch ms). */
  setLastCutLossAt(now: number): Promise<void>;
  /** Read last-cut-loss timestamp (epoch ms). Returns 0 if unset. */
  getLastCutLossAt(): Promise<number>;
  /** ms still remaining in cooldown window after last cut-loss. */
  getCooldownRemainingMs(now: number, cooldownMs: number): Promise<number>;
  /** Persist last-trade-at (any side, any outcome). */
  setLastTradeAt(now: number): Promise<void>;
  /** Read last-trade-at. 0 if unset. */
  getLastTradeAt(): Promise<number>;
}

/**
 * Build a `StrategySharedState` for `strategy`. All Redis keys are prefixed
 * with `ai-scalper:<strategy>:` so each strategy's state is isolated.
 */
export function createStrategySharedState(deps: {
  strategy: string;
  redis: RedisLike;
  manageQueue: ActivePositionCounterQueue;
}): StrategySharedState {
  const { strategy, redis, manageQueue } = deps;
  if (!strategy || /[^a-z0-9-]/.test(strategy)) {
    throw new Error(
      `createStrategySharedState: invalid strategy name '${strategy}' (must match /^[a-z0-9-]+$/)`,
    );
  }
  const keys = sharedStateKeys(strategy);

  return {
    async hasActivePosition() {
      const count = await this.getActivePositionCount();
      return count > 0;
    },
    async getActivePositionCount() {
      const [active, waiting, delayed] = await Promise.all([
        manageQueue.getActiveCount(),
        manageQueue.getWaitingCount(),
        manageQueue.getDelayedCount(),
      ]);
      return active + waiting + delayed;
    },
    async setLastCutLossAt(now: number) {
      await redis.set(keys.lastCutLossAt, String(now));
    },
    async getLastCutLossAt() {
      const raw = await redis.get(keys.lastCutLossAt);
      if (raw === null) return 0;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : 0;
    },
    async getCooldownRemainingMs(now: number, cooldownMs: number) {
      const last = await this.getLastCutLossAt();
      if (last <= 0) return 0;
      const remaining = last + cooldownMs - now;
      return remaining > 0 ? remaining : 0;
    },
    async setLastTradeAt(now: number) {
      await redis.set(keys.lastTradeAt, String(now));
    },
    async getLastTradeAt() {
      const raw = await redis.get(keys.lastTradeAt);
      if (raw === null) return 0;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : 0;
    },
  };
}

/** Compute the Redis key set used by a given strategy. Exposed for tests. */
export function sharedStateKeys(strategy: string): {
  lastCutLossAt: string;
  lastTradeAt: string;
} {
  const prefix = `ai-scalper:${strategy}`;
  return {
    lastCutLossAt: `${prefix}:last-cut-loss-at`,
    lastTradeAt: `${prefix}:last-trade-at`,
  };
}

export const __INTERNAL = { sharedStateKeys };
