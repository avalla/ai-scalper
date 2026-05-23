/**
 * Helpers that build the regime + performance snapshots consumed by the
 * advisor. All collectors degrade gracefully on network / persistence
 * errors (returning empty / zero defaults).
 */

import { readFile } from "node:fs/promises";
import { resolveProjectPath } from "@ai-scalper/trading-core";
import type { createBybitClient } from "@ai-scalper/bybit-client";
import type {
  MarketRegimeSnapshot,
  RecentStrategyPerformance,
} from "./strategy-advisor";

type BybitClient = ReturnType<typeof createBybitClient>;

interface RedisLike {
  lrange(key: string, start: number, stop: number): Promise<string[]>;
}

const CLOSED_POSITIONS_KEY = "ai-scalper:trader:positions:closed";
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function safeNumber(s: string | undefined): number {
  if (!s) return 0;
  const v = Number(s);
  return Number.isFinite(v) ? v : 0;
}

export async function collectRegime(deps: {
  client: BybitClient;
  scanLatestPath?: string;
  observedAt?: string;
}): Promise<MarketRegimeSnapshot> {
  const observedAt = deps.observedAt ?? new Date().toISOString();
  let btcPrice = 0;
  let btcTrendBps4h = 0;
  let btcRealizedVol1h = 0;
  let avgFundingRateBps = 0;
  let spotPerpBasisBps = 0;
  let topRankedSetups: MarketRegimeSnapshot["topRankedSetups"] = [];

  // BTC perp ticker (also gives prevPrice1h).
  try {
    const btcPerp = await deps.client.getTicker({ category: "linear", symbol: "BTCUSDT" });
    btcPrice = safeNumber(btcPerp.lastPrice);
    const prev1h = safeNumber(btcPerp.prevPrice1h);
    if (prev1h > 0 && btcPrice > 0) {
      btcRealizedVol1h = Math.abs((btcPrice - prev1h) / prev1h) * 100;
    }
    // BTC spot for basis.
    try {
      const btcSpot = await deps.client.getTicker({ category: "spot", symbol: "BTCUSDT" });
      const spotPrice = safeNumber(btcSpot.lastPrice);
      if (spotPrice > 0) {
        spotPerpBasisBps = ((btcPrice - spotPrice) / spotPrice) * 10_000;
      }
    } catch { /* ignore */ }
  } catch { /* ignore */ }

  // 4h trend via klines.
  try {
    const klines = await deps.client.getKlines({
      category: "linear",
      symbol: "BTCUSDT",
      interval: "60",
      limit: 5,
    });
    if (klines.length >= 4) {
      // Bybit returns newest-first; oldest at index length-1.
      const newest = safeNumber(klines[0]?.closePrice);
      const fourAgo = safeNumber(klines[Math.min(klines.length - 1, 3)]?.closePrice);
      if (fourAgo > 0 && newest > 0) {
        btcTrendBps4h = ((newest - fourAgo) / fourAgo) * 10_000;
      }
    }
  } catch { /* ignore */ }

  // Avg funding across top tickers by turnover.
  try {
    const tickers = await deps.client.getTickers({ category: "linear" });
    const sorted = [...tickers].sort((a, b) => safeNumber(b.turnover24h) - safeNumber(a.turnover24h));
    const top = sorted.slice(0, 10);
    if (top.length > 0) {
      const sum = top.reduce((acc, t) => acc + safeNumber(t.fundingRate) * 10_000, 0);
      avgFundingRateBps = sum / top.length;
    }
  } catch { /* ignore */ }

  // Top-ranked setups from scan artifact.
  try {
    const path = deps.scanLatestPath ?? resolveProjectPath("apps/trader/data/scan-latest.json");
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as {
      candidates?: Array<{ symbol: string; score: number; netEdgeBps: number; action: string }>;
      setups?: Array<{ symbol: string; score: number; netEdgeBps: number; action: string }>;
    };
    const list = parsed.candidates ?? parsed.setups;
    if (list) {
      topRankedSetups = list.slice(0, 5).map((s) => ({
        symbol: s.symbol,
        score: s.score,
        netEdgeBps: s.netEdgeBps,
        action: s.action,
      }));
    }
  } catch { /* ignore */ }

  return {
    observedAt,
    btcPrice,
    btcTrendBps4h,
    btcRealizedVol1h,
    avgFundingRateBps,
    spotPerpBasisBps,
    topRankedSetups,
  };
}

interface ClosedEntry {
  closedAt?: string;
  openedAt?: string;
  realizedPnlUsd?: number;
  strategyType?: string;
}

function holdMinutes(entry: ClosedEntry): number {
  if (!entry.openedAt || !entry.closedAt) return 0;
  const o = Date.parse(entry.openedAt);
  const c = Date.parse(entry.closedAt);
  if (!Number.isFinite(o) || !Number.isFinite(c) || c <= o) return 0;
  return (c - o) / 60_000;
}

export async function collectPerformance(deps: {
  redis: RedisLike | null;
  now?: number;
}): Promise<RecentStrategyPerformance[]> {
  if (!deps.redis) return [];
  const now = deps.now ?? Date.now();
  const cutoff = now - TWENTY_FOUR_HOURS_MS;

  let raw: string[] = [];
  try {
    raw = await deps.redis.lrange(CLOSED_POSITIONS_KEY, 0, 999);
  } catch {
    return [];
  }

  const parsed: ClosedEntry[] = [];
  for (const item of raw) {
    try {
      const entry = JSON.parse(item) as ClosedEntry;
      const closedTs = entry.closedAt ? Date.parse(entry.closedAt) : NaN;
      if (Number.isFinite(closedTs) && closedTs >= cutoff) {
        parsed.push(entry);
      }
    } catch { /* skip malformed */ }
  }

  const byStrategy = new Map<string, ClosedEntry[]>();
  for (const e of parsed) {
    const key = e.strategyType ?? "ma-crossover";
    const arr = byStrategy.get(key) ?? [];
    arr.push(e);
    byStrategy.set(key, arr);
  }

  const out: RecentStrategyPerformance[] = [];
  for (const [strategyType, entries] of byStrategy) {
    const wins = entries.filter((e) => (e.realizedPnlUsd ?? 0) > 0).length;
    const netPnlUsd = entries.reduce((s, e) => s + (e.realizedPnlUsd ?? 0), 0);
    const avgHoldMinutes = entries.length
      ? entries.reduce((s, e) => s + holdMinutes(e), 0) / entries.length
      : 0;
    out.push({
      strategyType,
      tradesLast24h: entries.length,
      winRate: entries.length > 0 ? wins / entries.length : 0,
      netPnlUsd,
      avgHoldMinutes,
    });
  }
  return out;
}
