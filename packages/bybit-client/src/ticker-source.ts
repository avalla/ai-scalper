/**
 * TickerSource — unified abstraction for fetching the latest market ticker.
 *
 * Consumers should depend on this interface (not BybitClient directly) so the
 * underlying transport (REST vs WS-cache-with-REST-fallback) can be swapped
 * via configuration without touching call sites.
 *
 * Two implementations are provided:
 *   - `createRestTickerSource(client)` — pure REST passthrough. Used when
 *     `useWebSocket=false` for backward compatibility.
 *   - `createCachedTickerSource({cache, fallback, defaultMaxAgeMs})` — reads
 *     the WS-fed Redis cache. If the cached entry is missing or older than
 *     `maxAgeMs` (default 5 s), falls back to a REST call against `fallback`.
 *     The feeder owns cache writes; this source does NOT write back.
 */
import type { MarketTicker, createBybitClient } from "./index";
import type { SharedTickerCache } from "./ws-redis-cache";

export type BybitClient = ReturnType<typeof createBybitClient>;

export interface TickerSource {
  /** Get latest ticker. May use cache + REST fallback per implementation. */
  getTicker(symbol: string, opts?: { category?: string; maxAgeMs?: number }): Promise<MarketTicker>;
  /** Sync access to last value previously seen via getTicker (null if unknown). */
  peek(symbol: string): MarketTicker | null;
}

const DEFAULT_CATEGORY = "linear";
const DEFAULT_MAX_AGE_MS = 5_000;

interface RestTickerSourceOptions {
  defaultCategory?: string;
}

export function createRestTickerSource(
  client: BybitClient,
  opts: RestTickerSourceOptions = {},
): TickerSource {
  const defaultCategory = opts.defaultCategory ?? DEFAULT_CATEGORY;
  const lastSeen = new Map<string, MarketTicker>();
  return {
    async getTicker(symbol, callOpts) {
      const ticker = await client.getTicker({
        category: callOpts?.category ?? defaultCategory,
        symbol,
      });
      lastSeen.set(symbol.toUpperCase(), ticker);
      return ticker;
    },
    peek(symbol) {
      return lastSeen.get(symbol.toUpperCase()) ?? null;
    },
  };
}

export interface CachedTickerSourceDeps {
  cache: SharedTickerCache;
  fallback: BybitClient;
  defaultMaxAgeMs?: number;
  defaultCategory?: string;
  logger?: { info: (o: Record<string, unknown>) => void; warn: (o: Record<string, unknown>) => void };
  now?: () => number;
}

export function createCachedTickerSource(deps: CachedTickerSourceDeps): TickerSource {
  const defaultMaxAgeMs = deps.defaultMaxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const defaultCategory = deps.defaultCategory ?? DEFAULT_CATEGORY;
  const now = deps.now ?? (() => Date.now());
  const logger = deps.logger;
  const lastSeen = new Map<string, MarketTicker>();
  const lastWarnAt = new Map<string, number>();

  function warnOncePerMinute(symbol: string, event: string, extra: Record<string, unknown> = {}): void {
    if (!logger) return;
    const t = now();
    const key = `${event}:${symbol}`;
    const last = lastWarnAt.get(key);
    if (last !== undefined && t - last < 60_000) return;
    lastWarnAt.set(key, t);
    logger.warn({ event, symbol, ...extra });
  }

  return {
    async getTicker(symbol, callOpts) {
      const maxAgeMs = callOpts?.maxAgeMs ?? defaultMaxAgeMs;
      const cached = await deps.cache.getTicker(symbol);
      if (cached) {
        const age = await deps.cache.getAge(symbol);
        if (age !== null && age < maxAgeMs) {
          lastSeen.set(symbol.toUpperCase(), cached);
          return cached;
        }
        warnOncePerMinute(symbol, "ws-cache-stale-fallback-rest", { ageMs: age, maxAgeMs });
      } else {
        warnOncePerMinute(symbol, "ws-cache-miss-fallback-rest", {});
      }
      const ticker = await deps.fallback.getTicker({
        category: callOpts?.category ?? defaultCategory,
        symbol,
      });
      lastSeen.set(symbol.toUpperCase(), ticker);
      return ticker;
    },
    peek(symbol) {
      return lastSeen.get(symbol.toUpperCase()) ?? null;
    },
  };
}
