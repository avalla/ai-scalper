/**
 * CLI entrypoint for the strategy-advisor background process. Spawned by the
 * worker start-stack when ANTHROPIC_API_KEY is set. The advisor is intentionally
 * separate from the trader loop — it only writes a recommendation file +
 * webhook. The operator decides whether to act on it.
 */

import IORedis from "ioredis";
import { createBybitClient } from "@ai-scalper/bybit-client";
import {
  createCachedTickerSource,
  createRestTickerSource,
  type TickerSource,
} from "@ai-scalper/bybit-client/ticker-source";
import { createRedisTickerCache } from "@ai-scalper/bybit-client/ws-redis-cache";
import { resolveProjectPath } from "@ai-scalper/trading-core";
import { createWebhookAlerter } from "../alerts/webhook";
import { readTraderConfig } from "../config";
import {
  collectPerformance,
  collectRegime,
} from "./strategy-advisor-collectors";
import { runStrategyAdvisorLoop } from "./strategy-advisor-runner";

async function main(): Promise<void> {
  const config = readTraderConfig(process.env);
  const apiKey = process.env.ANTHROPIC_API_KEY ?? null;

  if (!apiKey) {
    console.warn(JSON.stringify({
      ts: new Date().toISOString(),
      event: "advisor-cli-disabled",
      reason: "ANTHROPIC_API_KEY not set",
    }));
    return;
  }

  // Use mainnet scan base URL — we want real market data for the regime.
  const baseUrl = process.env.BYBIT_SCAN_BASE_URL ?? process.env.BYBIT_BASE_URL ?? "https://api.bybit.com";
  const client = createBybitClient({ baseUrl });

  const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  let redis: IORedis | null = null;
  try {
    redis = new IORedis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
    await redis.connect();
  } catch (err) {
    console.warn(JSON.stringify({
      ts: new Date().toISOString(),
      event: "advisor-cli-redis-unavailable",
      error: err instanceof Error ? err.message : String(err),
    }));
    redis = null;
  }

  const tickerSource: TickerSource = config.useWebSocket && redis
    ? createCachedTickerSource({
        cache: createRedisTickerCache(redis),
        fallback: client,
        defaultMaxAgeMs: 5_000,
      })
    : createRestTickerSource(client);

  const webhook = createWebhookAlerter(config.alertWebhookUrl);
  const outputPath = resolveProjectPath("apps/trader/data/runtime/strategy-advisor.json");

  let stopRequested = false;
  const onSignal = () => {
    stopRequested = true;
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  await runStrategyAdvisorLoop({
    config: {
      apiKey,
      model: config.advisorModel,
      intervalMinutes: config.advisorIntervalMinutes,
      alertWebhookUrl: config.alertWebhookUrl,
      outputPath,
    },
    collectRegime: () => collectRegime({ client, tickerSource }),
    collectPerformance: () => collectPerformance({ redis }),
    postWebhook: (msg, ctx) => webhook.send(msg, ctx),
    shouldStop: () => stopRequested,
  });

  if (redis) {
    try { await redis.quit(); } catch { /* ignore */ }
  }
}

await main();
