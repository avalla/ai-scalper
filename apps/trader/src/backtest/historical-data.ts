/**
 * Historical kline fetcher with disk cache. Backtests reuse the same kline
 * ranges constantly — caching keeps Bybit rate limits happy and makes repeated
 * runs near-instant.
 *
 * Cache layout:
 *   apps/trader/data/backtest-cache/<symbol>__<interval>__<startMs>__<endMs>.json
 *
 * Each file holds the raw `MarketKline[]` JSON. Cache is read-through: a
 * file matching the exact key short-circuits the fetch.
 *
 * Bybit kline API caps `limit` at 1000, so for ranges spanning >1000 bars the
 * caller must paginate. v1 accepts a single fetch — if the range is wider than
 * the API can return, only the most-recent `limit` bars are returned (matching
 * the Bybit default). Pagination is a follow-up.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MarketKline } from "@ai-scalper/bybit-client";

export interface HistoricalFetchParams {
  symbol: string;
  interval: string;
  start: number; // ms epoch
  end: number;   // ms epoch
}

export interface HistoricalDataDeps {
  fetchKlinesFromApi: (params: HistoricalFetchParams) => Promise<MarketKline[]>;
  cacheDir?: string;
  now?: () => number;
}

function cacheKeyPath(dir: string, p: HistoricalFetchParams): string {
  return join(
    dir,
    `${p.symbol}__${p.interval}__${p.start}__${p.end}.json`,
  );
}

/**
 * Read-through cache. If the cache file exists and is valid JSON, returns it
 * without hitting the API. Otherwise fetches, persists, and returns.
 */
export async function fetchHistoricalKlines(
  params: HistoricalFetchParams,
  deps: HistoricalDataDeps,
): Promise<MarketKline[]> {
  const cacheDir = deps.cacheDir
    ?? join(process.cwd(), "apps", "trader", "data", "backtest-cache");
  mkdirSync(cacheDir, { recursive: true });

  const cachePath = cacheKeyPath(cacheDir, params);
  if (existsSync(cachePath)) {
    try {
      const raw = readFileSync(cachePath, "utf8");
      const parsed = JSON.parse(raw) as MarketKline[];
      if (Array.isArray(parsed)) return parsed;
    } catch { /* fall through to refetch */ }
  }

  const fresh = await deps.fetchKlinesFromApi(params);
  try {
    writeFileSync(cachePath, JSON.stringify(fresh));
  } catch { /* best-effort cache */ }
  return fresh;
}
