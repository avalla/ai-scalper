/**
 * Redis-backed shared ticker cache.
 *
 * One process (the ws-feeder) maintains a single WS connection and publishes
 * normalized ticker updates here. Other processes (scanner, future tick
 * handlers) read the latest snapshot or subscribe to live updates via Redis
 * pub/sub.
 *
 * Storage layout:
 *   - `<prefix>:ticker:<symbol>`  HASH  — all ticker fields + `_updatedAt`
 *   - `<prefix>:ticker-updates`   CHAN  — pub/sub of JSON-encoded MarketTicker
 *
 * Entries get a TTL (default 60s) so stale data is auto-evicted.
 */
import type IORedis from "ioredis";
import type { MarketTicker } from "./index";

export interface SharedTickerCacheOptions {
  keyPrefix?: string;
  ttlMs?: number;
}

export interface SharedTickerCache {
  publishTicker(ticker: MarketTicker): Promise<void>;
  getTicker(symbol: string): Promise<MarketTicker | null>;
  getAge(symbol: string): Promise<number | null>;
  subscribe(handler: (ticker: MarketTicker) => void): () => void;
  close(): Promise<void>;
}

const DEFAULT_PREFIX = "ws";
const DEFAULT_TTL_MS = 60_000;
const UPDATED_AT_FIELD = "_updatedAt";

const TICKER_FIELDS: (keyof MarketTicker)[] = [
  "symbol",
  "lastPrice",
  "markPrice",
  "indexPrice",
  "prevPrice1h",
  "prevPrice24h",
  "price24hPcnt",
  "turnover24h",
  "volume24h",
  "openInterestValue",
  "fundingRate",
  "nextFundingTime",
  "bid1Price",
  "ask1Price",
  "bid1Size",
  "ask1Size",
];

function tickerKey(prefix: string, symbol: string): string {
  return `${prefix}:ticker:${symbol.toUpperCase()}`;
}

function channelName(prefix: string): string {
  return `${prefix}:ticker-updates`;
}

function hashToTicker(hash: Record<string, string>): MarketTicker {
  const out = {} as MarketTicker;
  for (const field of TICKER_FIELDS) {
    out[field] = hash[field] ?? "";
  }
  return out;
}

export function createRedisTickerCache(
  redis: IORedis,
  opts: SharedTickerCacheOptions = {},
): SharedTickerCache {
  const prefix = opts.keyPrefix ?? DEFAULT_PREFIX;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const channel = channelName(prefix);

  let subscriberClient: IORedis | null = null;
  const handlers = new Set<(t: MarketTicker) => void>();

  async function ensureSubscriber(): Promise<void> {
    if (subscriberClient) return;
    // Use the underlying connection's duplicate() to inherit URL / options.
    // ioredis exposes `duplicate()` returning a fresh IORedis instance.
    const dup = (redis as unknown as { duplicate: () => IORedis }).duplicate();
    subscriberClient = dup;
    await dup.subscribe(channel);
    dup.on("message", (_ch: string, payload: string) => {
      try {
        const ticker = JSON.parse(payload) as MarketTicker;
        for (const h of handlers) {
          try { h(ticker); } catch { /* swallow handler errors */ }
        }
      } catch {
        /* ignore malformed payloads */
      }
    });
  }

  return {
    async publishTicker(ticker) {
      const key = tickerKey(prefix, ticker.symbol);
      const now = Date.now();
      const flat: Record<string, string> = { [UPDATED_AT_FIELD]: String(now) };
      for (const field of TICKER_FIELDS) {
        flat[field] = ticker[field] ?? "";
      }
      // Atomically write + set TTL.
      const pipeline = redis.multi();
      pipeline.hset(key, flat);
      pipeline.pexpire(key, ttlMs);
      pipeline.publish(channel, JSON.stringify(ticker));
      await pipeline.exec();
    },

    async getTicker(symbol) {
      const key = tickerKey(prefix, symbol);
      const hash = await redis.hgetall(key);
      if (!hash || Object.keys(hash).length === 0) return null;
      return hashToTicker(hash);
    },

    async getAge(symbol) {
      const key = tickerKey(prefix, symbol);
      const updatedAt = await redis.hget(key, UPDATED_AT_FIELD);
      if (!updatedAt) return null;
      const ts = Number(updatedAt);
      if (!Number.isFinite(ts)) return null;
      return Math.max(0, Date.now() - ts);
    },

    subscribe(handler) {
      handlers.add(handler);
      void ensureSubscriber();
      return () => {
        handlers.delete(handler);
      };
    },

    async close() {
      handlers.clear();
      if (subscriberClient) {
        try { await subscriberClient.unsubscribe(channel); } catch { /* ignore */ }
        try { await subscriberClient.quit(); } catch { /* ignore */ }
        subscriberClient = null;
      }
    },
  };
}
