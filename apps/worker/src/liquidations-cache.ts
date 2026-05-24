/**
 * Redis-backed rolling-window cache of liquidation prints (Bybit V5
 * publicTrade with BT=true). The ws-feeder pushes; trader strategies
 * (liquidation-cascade) read.
 *
 * Storage layout:
 *   - `<prefix>:liquidations:<symbol>`  ZSET — score=ts(ms), member=JSON{ts,side,sizeUsd,id}
 *   - `<prefix>:liquidation-updates`    CHAN — pub/sub JSON-encoded entry
 *
 * Members include a small random suffix to guarantee uniqueness when
 * multiple prints share a millisecond timestamp.
 */
import type IORedis from "ioredis";

export interface LiquidationEntry {
  ts: number;
  side: "Buy" | "Sell";
  sizeUsd: number;
}

export interface LiquidationsCacheOptions {
  keyPrefix?: string;
  /** ZSET TTL (refreshed on each push). Default 10 min. */
  ttlMs?: number;
}

export interface LiquidationsCache {
  push(symbol: string, trade: LiquidationEntry): Promise<void>;
  getRecent(symbol: string, sinceMs: number): Promise<LiquidationEntry[]>;
  /** Removes entries with score < beforeMs. Returns number of entries removed. */
  trim(symbol: string, beforeMs: number): Promise<number>;
  close(): Promise<void>;
}

const DEFAULT_PREFIX = "ws";
const DEFAULT_TTL_MS = 10 * 60 * 1000;

function zsetKey(prefix: string, symbol: string): string {
  return `${prefix}:liquidations:${symbol.toUpperCase()}`;
}

function channelName(prefix: string): string {
  return `${prefix}:liquidation-updates`;
}

export function createRedisLiquidationsCache(
  redis: IORedis,
  opts: LiquidationsCacheOptions = {},
): LiquidationsCache {
  const prefix = opts.keyPrefix ?? DEFAULT_PREFIX;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

  return {
    async push(symbol, trade) {
      const key = zsetKey(prefix, symbol);
      // Unique-ish member to avoid ZSET dedup collisions when two prints share ts.
      const member = JSON.stringify({
        ts: trade.ts,
        side: trade.side,
        sizeUsd: trade.sizeUsd,
        _r: Math.random().toString(36).slice(2, 8),
      });
      const pipeline = redis.multi();
      pipeline.zadd(key, trade.ts, member);
      pipeline.pexpire(key, ttlMs);
      pipeline.publish(channelName(prefix), JSON.stringify({ symbol: symbol.toUpperCase(), ...trade }));
      await pipeline.exec();
    },

    async getRecent(symbol, sinceMs) {
      const key = zsetKey(prefix, symbol);
      const raw = await redis.zrangebyscore(key, sinceMs, "+inf");
      const out: LiquidationEntry[] = [];
      for (const member of raw) {
        try {
          const parsed = JSON.parse(member) as LiquidationEntry & { _r?: string };
          if (
            typeof parsed.ts === "number"
            && (parsed.side === "Buy" || parsed.side === "Sell")
            && typeof parsed.sizeUsd === "number"
          ) {
            out.push({ ts: parsed.ts, side: parsed.side, sizeUsd: parsed.sizeUsd });
          }
        } catch {
          /* skip malformed */
        }
      }
      return out;
    },

    async trim(symbol, beforeMs) {
      const key = zsetKey(prefix, symbol);
      // zremrangebyscore is inclusive; we want strict "<" so subtract 1ms.
      const removed = await redis.zremrangebyscore(key, "-inf", beforeMs - 1);
      return Number(removed) || 0;
    },

    async close() {
      /* no persistent subscriber yet; nothing to clean up */
    },
  };
}
