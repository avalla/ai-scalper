/**
 * Aggressive subsystem — read-only reader of price-tagged liquidation events.
 *
 * Reuses the shared Redis ZSET written by ws-feeder
 * (apps/worker/src/liquidations-cache.ts). The conservative subsystem reads
 * the same ZSET without the `price` field; this reader requires it and skips
 * legacy entries that don't carry it.
 *
 * Storage layout (must match worker liquidations-cache.ts):
 *   ZSET key: `<prefix>:liquidations:<SYMBOL>`
 *   score:    timestamp (ms)
 *   member:   JSON {ts, side, sizeUsd, price?, _r}
 */

import type IORedis from "ioredis";
import type { LiquidationEvent } from "./types";

export interface AggressiveEventsReader {
  /** Recent events with price (entries without price are silently dropped). */
  getRecentWithPrice(symbol: string, sinceMs: number): Promise<LiquidationEvent[]>;
}

export interface AggressiveEventsReaderOptions {
  /** Match the prefix used by the ws-feeder. Default "ws". */
  keyPrefix?: string;
}

const DEFAULT_PREFIX = "ws";

function zsetKey(prefix: string, symbol: string): string {
  return `${prefix}:liquidations:${symbol.toUpperCase()}`;
}

export function createRedisAggressiveEventsReader(
  redis: IORedis,
  opts: AggressiveEventsReaderOptions = {},
): AggressiveEventsReader {
  const prefix = opts.keyPrefix ?? DEFAULT_PREFIX;
  return {
    async getRecentWithPrice(symbol, sinceMs) {
      const raw = await redis.zrangebyscore(zsetKey(prefix, symbol), sinceMs, "+inf");
      const out: LiquidationEvent[] = [];
      for (const member of raw) {
        try {
          const parsed = JSON.parse(member) as Record<string, unknown>;
          const ts = parsed.ts; const side = parsed.side;
          const sizeUsd = parsed.sizeUsd; const price = parsed.price;
          if (
            typeof ts === "number"
            && (side === "Buy" || side === "Sell")
            && typeof sizeUsd === "number" && sizeUsd > 0
            && typeof price === "number" && price > 0
          ) {
            out.push({ ts, side, sizeUsd, price });
          }
        } catch { /* malformed → skip */ }
      }
      return out;
    },
  };
}

/** Tiny in-memory stub for tests / paper-mode without Redis. */
export function createInMemoryAggressiveEventsReader(seed: LiquidationEvent[] = []): AggressiveEventsReader & { push(e: LiquidationEvent): void; clear(): void } {
  const store: LiquidationEvent[] = seed.slice();
  return {
    async getRecentWithPrice(_symbol, sinceMs) { return store.filter((e) => e.ts >= sinceMs); },
    push(e) { store.push(e); },
    clear() { store.length = 0; },
  };
}
