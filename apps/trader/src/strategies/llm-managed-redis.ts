/**
 * llm-managed shared state — Phase 1 (BullMQ migration), refactored in
 * Phase 2 to delegate to the generic `createStrategySharedState` factory.
 *
 * Backward-compat surface (unchanged):
 *   - `RedisLike`, `ActivePositionCounterQueue` re-exported.
 *   - `LlmManagedSharedState` keeps its old shape (subset of the generic
 *     `StrategySharedState`).
 *   - `createLlmManagedSharedState` keeps its old signature.
 *   - `__INTERNAL.LAST_CUT_LOSS_KEY` keeps the SAME literal Redis key string
 *     it had in Phase 1 ("ai-scalper:llm-managed:last-cut-loss-at"). This
 *     means existing Redis state survives the refactor and the original 5
 *     llm-managed-redis tests still pass without modification.
 */

import {
  createStrategySharedState,
  sharedStateKeys,
  type ActivePositionCounterQueue,
  type RedisLike,
  type StrategySharedState,
} from "./shared/bullmq-shared-state";

export type { RedisLike, ActivePositionCounterQueue } from "./shared/bullmq-shared-state";

const STRATEGY_NAME = "llm-managed";
const LAST_CUT_LOSS_KEY = sharedStateKeys(STRATEGY_NAME).lastCutLossAt;

export interface LlmManagedSharedState {
  hasActivePosition(): Promise<boolean>;
  getActivePositionCount(): Promise<number>;
  setLastCutLossAt(now: number): Promise<void>;
  getLastCutLossAt(): Promise<number>;
  getCooldownRemainingMs(now: number, cooldownMs: number): Promise<number>;
}

export function createLlmManagedSharedState(deps: {
  redis: RedisLike;
  manageQueue: ActivePositionCounterQueue;
}): LlmManagedSharedState {
  const generic: StrategySharedState = createStrategySharedState({
    strategy: STRATEGY_NAME,
    redis: deps.redis,
    manageQueue: deps.manageQueue,
  });
  return generic;
}

/** Exposed so tests can assert exact key strings. */
export const __INTERNAL = { LAST_CUT_LOSS_KEY };
