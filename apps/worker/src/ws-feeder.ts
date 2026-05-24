/**
 * Long-running Bybit V5 WebSocket feeder.
 *
 * Maintains one WS connection (linear perps by default), subscribes to a
 * configured symbol set, and publishes every snapshot/delta update to the
 * Redis-backed SharedTickerCache. Other processes (scanner, future tick
 * handlers) read live tickers from that cache.
 *
 * Phase 1 scope: tickers only. Cost: ~1KB/sec, one persistent connection.
 */
import { createBybitWsClient, type BybitWsClient } from "@ai-scalper/bybit-client/ws";
import {
  createRedisTickerCache,
  type SharedTickerCache,
} from "@ai-scalper/bybit-client/ws-redis-cache";
import type IORedis from "ioredis";

export interface WsFeederOptions {
  symbols: string[];
  redis: IORedis;
  baseUrl?: string;
  category?: "linear" | "spot" | "inverse";
  keyPrefix?: string;
  ttlMs?: number;
  pingIntervalMs?: number;
  /** Optional custom logger; defaults to console.log JSON line. */
  log?: (row: Record<string, unknown>) => void;
}

export interface WsFeederHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly client: BybitWsClient;
  readonly cache: SharedTickerCache;
}

const defaultLog = (row: Record<string, unknown>) => {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n");
};

export function createWsFeeder(opts: WsFeederOptions): WsFeederHandle {
  const log = opts.log ?? defaultLog;
  const cache = createRedisTickerCache(opts.redis, {
    keyPrefix: opts.keyPrefix,
    ttlMs: opts.ttlMs,
  });
  const client = createBybitWsClient({
    baseUrl: opts.baseUrl,
    category: opts.category,
    pingIntervalMs: opts.pingIntervalMs,
  });

  // Pipe every ticker update into Redis. Errors are logged but never throw —
  // we never want a publish failure to kill the feeder process.
  client.onTicker((ticker) => {
    void cache.publishTicker(ticker).catch((err) => {
      log({ event: "ws-feeder-publish-failed", symbol: ticker.symbol, err: String(err) });
    });
  });

  return {
    client,
    cache,
    async start() {
      log({ event: "ws-feeder-starting", symbols: opts.symbols, category: opts.category ?? "linear" });
      await client.start();
      for (const symbol of opts.symbols) {
        await client.subscribeTicker(symbol);
      }
      log({ event: "ws-feeder-ready", subscriptions: client.getSubscriptions() });
    },
    async stop() {
      log({ event: "ws-feeder-stopping" });
      await client.stop();
      await cache.close();
      log({ event: "ws-feeder-stopped", stats: client.getStats() });
    },
  };
}
