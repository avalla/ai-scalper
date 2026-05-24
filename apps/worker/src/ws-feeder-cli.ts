/**
 * Standalone entry point for the WS feeder.
 *
 *   bun --env-file ../../.env src/ws-feeder-cli.ts
 *
 * Subscribes to the symbols listed in `WS_FEEDER_SYMBOLS` (comma-separated),
 * or a sensible default top-liquid set. Publishes ticker updates to Redis
 * for any process that reads via `SharedTickerCache`.
 */
import { createRedisConnection } from "./redis";
import { createWsFeeder } from "./ws-feeder";

const DEFAULT_SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "BNBUSDT",
];

function readSymbols(): string[] {
  const raw = process.env.WS_FEEDER_SYMBOLS;
  if (!raw || raw.trim() === "") return DEFAULT_SYMBOLS;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const redis = createRedisConnection();
  const baseUrl = process.env.BYBIT_WS_BASE_URL || "wss://stream.bybit.com/v5/public";
  const category = (process.env.BYBIT_WS_CATEGORY as "linear" | "spot" | "inverse") || "linear";
  const symbols = readSymbols();

  const feeder = createWsFeeder({
    redis,
    symbols,
    baseUrl,
    category,
    keyPrefix: process.env.WS_FEEDER_KEY_PREFIX || "ws",
    ttlMs: process.env.WS_FEEDER_TTL_MS ? Number(process.env.WS_FEEDER_TTL_MS) : undefined,
  });

  const shutdown = async (signal: string) => {
    process.stdout.write(JSON.stringify({
      ts: new Date().toISOString(),
      event: "ws-feeder-signal",
      signal,
    }) + "\n");
    try { await feeder.stop(); } catch { /* ignore */ }
    try { await redis.quit(); } catch { /* ignore */ }
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await feeder.start();
}

await main();
