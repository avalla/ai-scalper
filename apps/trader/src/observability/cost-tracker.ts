/**
 * Cost tracker: persists Bybit trading fees + Anthropic token usage to Redis,
 * exposes time-windowed snapshots for the `bun run report` command and the
 * `/health` endpoint.
 *
 * Storage: two Redis sorted sets keyed by timestamp:
 *   ai-scalper:cost:bybit:fees       — score=ts ms, member=JSON({feeUsd, ts})
 *   ai-scalper:cost:anthropic:calls  — score=ts ms, member=JSON({usage..., ts})
 *
 * Entries older than 7 days are trimmed on every write.
 *
 * Pricing constants for Haiku 4.5 are sourced from env (sensible defaults) so
 * Anthropic price changes don't require a redeploy.
 */

export const COST_KEY_BYBIT_FEES = "ai-scalper:cost:bybit:fees";
export const COST_KEY_ANTHROPIC_CALLS = "ai-scalper:cost:anthropic:calls";
export const COST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface AnthropicUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  model: string;
}

export interface AnthropicPricingPer1M {
  input: number;
  cached: number;
  output: number;
}

export const DEFAULT_ANTHROPIC_PRICING_HAIKU_4_5: AnthropicPricingPer1M = {
  input: Number(process.env.ANTHROPIC_INPUT_PRICE_PER_1M ?? 1),
  cached: Number(process.env.ANTHROPIC_CACHED_PRICE_PER_1M ?? 0.1),
  output: Number(process.env.ANTHROPIC_OUTPUT_PRICE_PER_1M ?? 5),
};

export function estimateAnthropicCostUsd(
  usage: { inputTokens: number; cachedTokens: number; outputTokens: number },
  pricing: AnthropicPricingPer1M = DEFAULT_ANTHROPIC_PRICING_HAIKU_4_5,
): number {
  return (
    (usage.inputTokens / 1_000_000) * pricing.input
    + (usage.cachedTokens / 1_000_000) * pricing.cached
    + (usage.outputTokens / 1_000_000) * pricing.output
  );
}

export interface CostSnapshot {
  windowStart: number;
  windowEnd: number;
  bybitFeesUsd: number;
  anthropicCalls: number;
  anthropicInputTokens: number;
  anthropicCachedTokens: number;
  anthropicOutputTokens: number;
  anthropicCostUsd: number;
  totalCostUsd: number;
}

export interface CostTracker {
  recordBybitFee(feeUsd: number): Promise<void>;
  recordAnthropicCall(usage: AnthropicUsage): Promise<void>;
  getSnapshot(sinceMs: number): Promise<CostSnapshot>;
  getDaily(): Promise<CostSnapshot>;
}

/** Minimal Redis surface area we need — keeps testing trivial. */
export interface CostRedisLike {
  zadd(key: string, score: number, member: string): Promise<number | string>;
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number>;
}

export function createCostTracker(
  redis: CostRedisLike,
  options: {
    now?: () => number;
    pricing?: AnthropicPricingPer1M;
  } = {},
): CostTracker {
  const now = options.now ?? (() => Date.now());
  const pricing = options.pricing ?? DEFAULT_ANTHROPIC_PRICING_HAIKU_4_5;

  async function trim(key: string): Promise<void> {
    const cutoff = now() - COST_RETENTION_MS;
    await redis.zremrangebyscore(key, "-inf", cutoff);
  }

  return {
    async recordBybitFee(feeUsd: number): Promise<void> {
      if (!Number.isFinite(feeUsd) || feeUsd <= 0) return;
      const ts = now();
      // Append a tie-breaker so ties don't collapse via the sorted-set member uniqueness.
      const member = JSON.stringify({ feeUsd, ts, n: Math.random() });
      await redis.zadd(COST_KEY_BYBIT_FEES, ts, member);
      await trim(COST_KEY_BYBIT_FEES);
    },

    async recordAnthropicCall(usage: AnthropicUsage): Promise<void> {
      const ts = now();
      const member = JSON.stringify({ ...usage, ts, n: Math.random() });
      await redis.zadd(COST_KEY_ANTHROPIC_CALLS, ts, member);
      await trim(COST_KEY_ANTHROPIC_CALLS);
    },

    async getSnapshot(sinceMs: number): Promise<CostSnapshot> {
      const windowEnd = now();
      const windowStart = sinceMs;
      const [feeMembers, anthMembers] = await Promise.all([
        redis.zrangebyscore(COST_KEY_BYBIT_FEES, windowStart, windowEnd),
        redis.zrangebyscore(COST_KEY_ANTHROPIC_CALLS, windowStart, windowEnd),
      ]);

      let bybitFeesUsd = 0;
      for (const raw of feeMembers) {
        try {
          const parsed = JSON.parse(raw) as { feeUsd?: number };
          if (typeof parsed.feeUsd === "number" && Number.isFinite(parsed.feeUsd)) {
            bybitFeesUsd += parsed.feeUsd;
          }
        } catch { /* skip malformed */ }
      }

      let anthropicCalls = 0;
      let anthropicInputTokens = 0;
      let anthropicCachedTokens = 0;
      let anthropicOutputTokens = 0;
      for (const raw of anthMembers) {
        try {
          const parsed = JSON.parse(raw) as Partial<AnthropicUsage>;
          anthropicCalls += 1;
          anthropicInputTokens += parsed.inputTokens ?? 0;
          anthropicCachedTokens += parsed.cachedTokens ?? 0;
          anthropicOutputTokens += parsed.outputTokens ?? 0;
        } catch { /* skip */ }
      }

      const anthropicCostUsd = estimateAnthropicCostUsd(
        {
          inputTokens: anthropicInputTokens,
          cachedTokens: anthropicCachedTokens,
          outputTokens: anthropicOutputTokens,
        },
        pricing,
      );

      return {
        windowStart,
        windowEnd,
        bybitFeesUsd,
        anthropicCalls,
        anthropicInputTokens,
        anthropicCachedTokens,
        anthropicOutputTokens,
        anthropicCostUsd,
        totalCostUsd: bybitFeesUsd + anthropicCostUsd,
      };
    },

    async getDaily(): Promise<CostSnapshot> {
      return this.getSnapshot(now() - 24 * 60 * 60 * 1000);
    },
  };
}

/** In-memory implementation of CostRedisLike — useful for tests + dev. */
export function createInMemoryCostRedis(): CostRedisLike {
  const sets = new Map<string, Array<{ score: number; member: string }>>();
  const get = (key: string) => {
    let s = sets.get(key);
    if (!s) { s = []; sets.set(key, s); }
    return s;
  };
  return {
    async zadd(key, score, member) {
      get(key).push({ score, member });
      return 1;
    },
    async zrangebyscore(key, min, max) {
      const minN = min === "-inf" ? -Infinity : Number(min);
      const maxN = max === "+inf" ? Infinity : Number(max);
      return get(key)
        .filter((e) => e.score >= minN && e.score <= maxN)
        .sort((a, b) => a.score - b.score)
        .map((e) => e.member);
    },
    async zremrangebyscore(key, min, max) {
      const minN = min === "-inf" ? -Infinity : Number(min);
      const maxN = max === "+inf" ? Infinity : Number(max);
      const arr = get(key);
      const before = arr.length;
      const kept = arr.filter((e) => !(e.score >= minN && e.score <= maxN));
      sets.set(key, kept);
      return before - kept.length;
    },
  };
}
