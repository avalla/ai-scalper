import { describe, expect, test } from "bun:test";
import {
  COST_KEY_ANTHROPIC_CALLS,
  COST_KEY_BYBIT_FEES,
  COST_RETENTION_MS,
  createCostTracker,
  createInMemoryCostRedis,
  estimateAnthropicCostUsd,
} from "./cost-tracker";

const FIXED_PRICING = { input: 1, cached: 0.1, output: 5 };

describe("cost-tracker", () => {
  test("records bybit fees and sums them in a window", async () => {
    let t = 1_000_000_000_000;
    const redis = createInMemoryCostRedis();
    const tracker = createCostTracker(redis, { now: () => t, pricing: FIXED_PRICING });

    await tracker.recordBybitFee(0.1);
    t += 1000;
    await tracker.recordBybitFee(0.25);
    t += 1000;
    await tracker.recordBybitFee(0.4);
    t += 1000;

    const snap = await tracker.getSnapshot(t - 60_000);
    expect(snap.bybitFeesUsd).toBeCloseTo(0.75, 6);
    expect(snap.totalCostUsd).toBeCloseTo(0.75, 6);
    expect(snap.anthropicCalls).toBe(0);
  });

  test("ignores non-finite or non-positive bybit fees", async () => {
    let t = 2_000_000_000_000;
    const redis = createInMemoryCostRedis();
    const tracker = createCostTracker(redis, { now: () => t, pricing: FIXED_PRICING });
    await tracker.recordBybitFee(NaN);
    await tracker.recordBybitFee(-1);
    await tracker.recordBybitFee(0);
    const snap = await tracker.getSnapshot(0);
    expect(snap.bybitFeesUsd).toBe(0);
  });

  test("records anthropic call usage and estimates cost using Haiku 4.5 pricing", async () => {
    let t = 1_700_000_000_000;
    const redis = createInMemoryCostRedis();
    const tracker = createCostTracker(redis, { now: () => t, pricing: FIXED_PRICING });

    await tracker.recordAnthropicCall({
      inputTokens: 100_000,
      cachedTokens: 50_000,
      outputTokens: 10_000,
      model: "claude-haiku-4-5-20251001",
    });
    t += 1000;
    await tracker.recordAnthropicCall({
      inputTokens: 200_000,
      cachedTokens: 100_000,
      outputTokens: 5_000,
      model: "claude-haiku-4-5-20251001",
    });

    const snap = await tracker.getSnapshot(t - 60_000);
    expect(snap.anthropicCalls).toBe(2);
    expect(snap.anthropicInputTokens).toBe(300_000);
    expect(snap.anthropicCachedTokens).toBe(150_000);
    expect(snap.anthropicOutputTokens).toBe(15_000);
    // 0.3 * 1 + 0.15 * 0.1 + 0.015 * 5 = 0.3 + 0.015 + 0.075 = 0.39
    expect(snap.anthropicCostUsd).toBeCloseTo(0.39, 6);
    expect(snap.totalCostUsd).toBeCloseTo(0.39, 6);
  });

  test("getSnapshot honours the time window — excludes entries older than 24h", async () => {
    let t = 1_500_000_000_000;
    const redis = createInMemoryCostRedis();
    const tracker = createCostTracker(redis, { now: () => t, pricing: FIXED_PRICING });

    // 48h ago
    t -= 48 * 60 * 60 * 1000;
    await tracker.recordBybitFee(100); // OLD
    // 12h ago
    t += 36 * 60 * 60 * 1000;
    await tracker.recordBybitFee(2.5); // RECENT
    // back to "now"
    t += 12 * 60 * 60 * 1000;

    const daily = await tracker.getDaily();
    expect(daily.bybitFeesUsd).toBeCloseTo(2.5, 6); // OLD excluded
    expect(daily.windowEnd - daily.windowStart).toBe(24 * 60 * 60 * 1000);
  });

  test("trims entries older than 7 days on write", async () => {
    let t = 1_900_000_000_000;
    const redis = createInMemoryCostRedis();
    const tracker = createCostTracker(redis, { now: () => t, pricing: FIXED_PRICING });

    // 10 days ago
    t -= 10 * 24 * 60 * 60 * 1000;
    await tracker.recordBybitFee(99); // OLD — will be trimmed on next write
    // back to "now" → write triggers trim
    t += 10 * 24 * 60 * 60 * 1000;
    await tracker.recordBybitFee(0.5);

    const all = await redis.zrangebyscore(COST_KEY_BYBIT_FEES, 0, t);
    expect(all.length).toBe(1);
    const parsed = JSON.parse(all[0]!) as { feeUsd: number };
    expect(parsed.feeUsd).toBe(0.5);
    expect(COST_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test("Bybit fees + Anthropic cost roll into totalCostUsd", async () => {
    let t = 1_800_000_000_000;
    const redis = createInMemoryCostRedis();
    const tracker = createCostTracker(redis, { now: () => t, pricing: FIXED_PRICING });
    await tracker.recordBybitFee(0.2);
    await tracker.recordAnthropicCall({
      inputTokens: 1_000_000,
      cachedTokens: 0,
      outputTokens: 0,
      model: "claude-haiku-4-5-20251001",
    });
    const snap = await tracker.getSnapshot(t - 60_000);
    expect(snap.bybitFeesUsd).toBeCloseTo(0.2, 6);
    expect(snap.anthropicCostUsd).toBeCloseTo(1.0, 6);
    expect(snap.totalCostUsd).toBeCloseTo(1.2, 6);
  });

  test("pure estimateAnthropicCostUsd", () => {
    expect(estimateAnthropicCostUsd(
      { inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 0 },
      FIXED_PRICING,
    )).toBeCloseTo(1, 6);
    expect(estimateAnthropicCostUsd(
      { inputTokens: 0, cachedTokens: 10_000_000, outputTokens: 0 },
      FIXED_PRICING,
    )).toBeCloseTo(1, 6);
    expect(estimateAnthropicCostUsd(
      { inputTokens: 0, cachedTokens: 0, outputTokens: 200_000 },
      FIXED_PRICING,
    )).toBeCloseTo(1, 6);
    // Bybit fee key constant is exported for /health + consumers
    expect(COST_KEY_BYBIT_FEES).toBe("ai-scalper:cost:bybit:fees");
    expect(COST_KEY_ANTHROPIC_CALLS).toBe("ai-scalper:cost:anthropic:calls");
  });
});
