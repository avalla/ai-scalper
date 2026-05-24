/**
 * Redis-backed shared orderbook cache.
 *
 * The ws-feeder publishes orderbook snapshots here; trader / scanner read.
 *
 * Storage layout:
 *   - `<prefix>:orderbook:<symbol>`  HASH  — bids+asks (JSON), updateId, seq, _updatedAt
 *   - `<prefix>:orderbook-updates`   CHAN  — pub/sub JSON-encoded OrderbookSnapshot
 *
 * Entries get a TTL (default 60s).
 */
import type IORedis from "ioredis";
import type { OrderbookLevel, OrderbookSnapshot } from "./ws";

export interface SharedOrderbookCacheOptions {
  keyPrefix?: string;
  ttlMs?: number;
}

export interface SharedOrderbookCache {
  publishOrderbook(book: OrderbookSnapshot): Promise<void>;
  getOrderbook(symbol: string): Promise<OrderbookSnapshot | null>;
  getAge(symbol: string): Promise<number | null>;
  subscribe(handler: (book: OrderbookSnapshot) => void): () => void;
  close(): Promise<void>;
}

const DEFAULT_PREFIX = "ws";
const DEFAULT_TTL_MS = 60_000;

function key(prefix: string, symbol: string): string {
  return `${prefix}:orderbook:${symbol.toUpperCase()}`;
}

function channelName(prefix: string): string {
  return `${prefix}:orderbook-updates`;
}

export function createRedisOrderbookCache(
  redis: IORedis,
  opts: SharedOrderbookCacheOptions = {},
): SharedOrderbookCache {
  const prefix = opts.keyPrefix ?? DEFAULT_PREFIX;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const channel = channelName(prefix);

  let subscriberClient: IORedis | null = null;
  const handlers = new Set<(b: OrderbookSnapshot) => void>();

  async function ensureSubscriber(): Promise<void> {
    if (subscriberClient) return;
    const dup = (redis as unknown as { duplicate: () => IORedis }).duplicate();
    subscriberClient = dup;
    await dup.subscribe(channel);
    dup.on("message", (_ch: string, payload: string) => {
      try {
        const book = JSON.parse(payload) as OrderbookSnapshot;
        for (const h of handlers) {
          try { h(book); } catch { /* ignore */ }
        }
      } catch {
        /* ignore malformed */
      }
    });
  }

  return {
    async publishOrderbook(book) {
      const k = key(prefix, book.symbol);
      const flat: Record<string, string> = {
        symbol: book.symbol,
        bids: JSON.stringify(book.bids),
        asks: JSON.stringify(book.asks),
        updateId: String(book.updateId),
        seq: String(book.seq),
        _updatedAt: String(Date.now()),
      };
      const pipeline = redis.multi();
      pipeline.hset(k, flat);
      pipeline.pexpire(k, ttlMs);
      pipeline.publish(channel, JSON.stringify(book));
      await pipeline.exec();
    },

    async getOrderbook(symbol) {
      const hash = await redis.hgetall(key(prefix, symbol));
      if (!hash || Object.keys(hash).length === 0) return null;
      let bids: OrderbookLevel[] = [];
      let asks: OrderbookLevel[] = [];
      try { bids = JSON.parse(hash.bids ?? "[]") as OrderbookLevel[]; } catch { /* ignore */ }
      try { asks = JSON.parse(hash.asks ?? "[]") as OrderbookLevel[]; } catch { /* ignore */ }
      return {
        symbol: hash.symbol ?? symbol.toUpperCase(),
        bids,
        asks,
        updateId: Number(hash.updateId ?? 0),
        seq: Number(hash.seq ?? 0),
        updatedAt: Number(hash._updatedAt ?? 0),
      };
    },

    async getAge(symbol) {
      const u = await redis.hget(key(prefix, symbol), "_updatedAt");
      if (!u) return null;
      const ts = Number(u);
      if (!Number.isFinite(ts)) return null;
      return Math.max(0, Date.now() - ts);
    },

    subscribe(handler) {
      handlers.add(handler);
      void ensureSubscriber();
      return () => { handlers.delete(handler); };
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
