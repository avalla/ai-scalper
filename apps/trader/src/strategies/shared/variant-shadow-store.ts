/**
 * Redis-backed per-variant `TraderState` store for ma-crossover shadow learning
 * in BullMQ mode. Without this, only the champion's actual trades feed the
 * bandit and non-champion variants never accumulate experience.
 *
 * Wire format: single JSON blob `{ [variantId]: TraderState }` under
 * `ai-scalper:ma-crossover:variant-shadow-states`.
 */

import type { TraderState } from "@ai-scalper/trading-core";

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, val: string): Promise<unknown>;
}

const SHADOW_KEY = "ai-scalper:ma-crossover:variant-shadow-states";

export type VariantShadowMap = Record<string, TraderState>;

export interface VariantShadowStore {
  load(): Promise<VariantShadowMap>;
  save(states: VariantShadowMap): Promise<void>;
}

export function emptyVariantState(): TraderState {
  return {
    lastTradeAt: null,
    realizedPnlUsd: 0,
    position: null,
    dayStartedAt: null,
  };
}

export function createVariantShadowStore(redis: RedisLike): VariantShadowStore {
  return {
    async load() {
      try {
        const raw = await redis.get(SHADOW_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as VariantShadowMap;
        if (!parsed || typeof parsed !== "object") return {};
        return parsed;
      } catch {
        return {};
      }
    },
    async save(states) {
      await redis.set(SHADOW_KEY, JSON.stringify(states));
    },
  };
}

export const __INTERNAL = { SHADOW_KEY };
