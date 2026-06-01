/**
 * Universe fetcher — fetches all linear-perp instruments from Bybit + the
 * latest tickers, applies the liquidity filter from the pump scanner, and
 * returns the active universe (symbols + their ticker snapshots).
 *
 * Refreshes are caller-driven (e.g. every 5 min) — Bybit's getTickers is
 * cheap (single REST call returns all linear perps).
 */

import type { createBybitClient } from "@ai-scalper/bybit-client";
import {
  qualifiesByLiquidity,
  type PumpScannerLiquidityCriteria,
  type SymbolTickerSnapshot,
} from "./pump-scanner";

type BybitClient = ReturnType<typeof createBybitClient>;

export interface UniverseEntry {
  symbol: string;
  ticker: SymbolTickerSnapshot;
}

export interface UniverseFetcherOptions {
  /** Defaults to "linear" (USDT-margined perps). */
  category?: string;
  /**
   * Optional symbol whitelist — when set, only symbols in this list are
   * considered (useful to scope the scanner to e.g. top-30 by your own list).
   */
  symbolWhitelist?: readonly string[];
  /**
   * Optional symbol blacklist — exclude known-problematic symbols (illiquid,
   * recently listed, etc.). Applied AFTER whitelist.
   */
  symbolBlacklist?: readonly string[];
}

export interface UniverseFetcher {
  /** Fetch the current active universe (filtered by liquidity). */
  fetchActive(criteria: PumpScannerLiquidityCriteria): Promise<UniverseEntry[]>;
}

export function createUniverseFetcher(
  client: BybitClient,
  opts: UniverseFetcherOptions = {},
): UniverseFetcher {
  const category = opts.category ?? "linear";
  const wl = opts.symbolWhitelist ? new Set(opts.symbolWhitelist.map((s) => s.toUpperCase())) : null;
  const bl = opts.symbolBlacklist ? new Set(opts.symbolBlacklist.map((s) => s.toUpperCase())) : null;

  return {
    async fetchActive(criteria) {
      const tickers = await client.getTickers({ category } as Parameters<BybitClient["getTickers"]>[0]);
      const out: UniverseEntry[] = [];
      for (const t of tickers) {
        const symbol = String(t.symbol ?? "").toUpperCase();
        if (!symbol) continue;
        if (wl && !wl.has(symbol)) continue;
        if (bl && bl.has(symbol)) continue;
        // The Bybit ticker carries the fields we need; we adapt the shape.
        const snap: SymbolTickerSnapshot = {
          symbol,
          lastPrice: Number(t.lastPrice ?? 0),
          turnover24hUsd: Number((t as { turnover24h?: string }).turnover24h ?? 0),
          bid1Price: Number(t.bid1Price ?? 0),
          ask1Price: Number(t.ask1Price ?? 0),
        };
        const liq = qualifiesByLiquidity(snap, criteria);
        if (!liq.ok) continue;
        out.push({ symbol, ticker: snap });
      }
      return out;
    },
  };
}
