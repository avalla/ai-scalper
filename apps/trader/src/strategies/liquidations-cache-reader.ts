/**
 * Read-only mirror of `apps/worker/src/liquidations-cache.ts.getRecent`.
 *
 * The cache is populated cross-process by the ws-feeder (worker subprocess)
 * and consumed by the trader subprocess running the liquidation-cascade
 * strategy tick. This module deliberately exposes ONLY `getRecent` — pushes
 * are owned by the feeder.
 *
 * Storage layout (must match worker liquidations-cache.ts exactly):
 *   - ZSET key:  `<prefix>:liquidations:<SYMBOL>`
 *   - Score:     timestamp (ms)
 *   - Member:    JSON-encoded `{ ts, side, sizeUsd, _r }` (with a small
 *                random `_r` suffix to avoid ZSET dedup on identical prints).
 */
import type IORedis from "ioredis";

export interface LiquidationEntry {
  ts: number;
  side: "Buy" | "Sell";
  sizeUsd: number;
}

export interface LiquidationsReader {
  getRecent(symbol: string, sinceMs: number): Promise<LiquidationEntry[]>;
}

export interface LiquidationsReaderOptions {
  keyPrefix?: string;
}

const DEFAULT_PREFIX = "ws";

function zsetKey(prefix: string, symbol: string): string {
  return `${prefix}:liquidations:${symbol.toUpperCase()}`;
}

export function createRedisLiquidationsReader(
  redis: IORedis,
  opts: LiquidationsReaderOptions = {},
): LiquidationsReader {
  const prefix = opts.keyPrefix ?? DEFAULT_PREFIX;

  return {
    async getRecent(symbol, sinceMs) {
      const key = zsetKey(prefix, symbol);
      // Use score range (sinceMs..+inf). ZRANGEBYSCORE returns members
      // ordered by score ascending which gives us ts-ascending output.
      const raw = await redis.zrangebyscore(key, sinceMs, "+inf");
      const out: LiquidationEntry[] = [];
      for (const member of raw) {
        try {
          const parsed = JSON.parse(member) as Partial<LiquidationEntry> & { _r?: string };
          if (
            typeof parsed.ts === "number"
            && (parsed.side === "Buy" || parsed.side === "Sell")
            && typeof parsed.sizeUsd === "number"
          ) {
            out.push({ ts: parsed.ts, side: parsed.side, sizeUsd: parsed.sizeUsd });
          }
        } catch {
          /* skip malformed entries — feeder writes JSON; only corruption would land here */
        }
      }
      // Defensive: re-sort by ts ascending in case Redis impl differs.
      out.sort((a, b) => a.ts - b.ts);
      return out;
    },
  };
}
