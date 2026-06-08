/**
 * Helpers that build the regime + performance snapshots consumed by the
 * advisor. All collectors degrade gracefully on network / persistence
 * errors (returning empty / zero defaults).
 */

import { readFile } from "node:fs/promises";
import { resolveProjectPath } from "@ai-scalper/trading-core";
import type { createBybitClient } from "@ai-scalper/bybit-client";
import type { TickerSource } from "@ai-scalper/bybit-client/ticker-source";
import type {
  ChartContext,
  KlineSummary,
  MarketRegimeSnapshot,
  RecentEventSummary,
  RecentStrategyPerformance,
} from "./strategy-advisor";

type BybitClient = ReturnType<typeof createBybitClient>;

interface RedisLike {
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  zrangebyscore?(key: string, min: number | string, max: number | string, withscores?: "WITHSCORES"): Promise<string[]>;
}

interface FeederEvent {
  source?: string;
  signal?: "high" | "medium" | "low";
  sentiment?: "bullish" | "bearish" | "neutral";
  symbols?: string[];
  title?: string;
  observedAt?: string;
}

/**
 * Fetch recent high-signal events from Redis sorted set populated by the
 * event-feeder. Returns most recent first, rank-deduped by source+signal
 * priority. Returns empty array on any failure or absent feeder.
 */
export async function collectRecentEvents(
  redis: RedisLike | null,
  now: number = Date.now(),
): Promise<RecentEventSummary[]> {
  if (!redis || !redis.zrangebyscore) return [];
  let raw: string[] = [];
  try {
    raw = await redis.zrangebyscore(EVENTS_RECENT_KEY, now - EVENTS_LOOKBACK_MS, now);
  } catch { return []; }
  const parsed: Array<{ ts: number; ev: FeederEvent }> = [];
  for (const item of raw) {
    try {
      const ev = JSON.parse(item) as FeederEvent;
      const ts = ev.observedAt ? Date.parse(ev.observedAt) : NaN;
      if (!Number.isFinite(ts)) continue;
      parsed.push({ ts, ev });
    } catch { /* skip */ }
  }
  // Sort newest-first; rank-cap to MAX so prompt stays compact.
  parsed.sort((a, b) => b.ts - a.ts);
  // Prefer high-signal events when truncating.
  const signalRank: Record<string, number> = { high: 3, medium: 2, low: 1 };
  parsed.sort((a, b) => {
    const sa = signalRank[a.ev.signal ?? "low"] ?? 0;
    const sb = signalRank[b.ev.signal ?? "low"] ?? 0;
    if (sb !== sa) return sb - sa;
    return b.ts - a.ts;
  });
  const top = parsed.slice(0, EVENTS_MAX_RETURNED);
  return top.map(({ ts, ev }) => ({
    source: ev.source ?? "unknown",
    signal: ev.signal ?? "low",
    sentiment: ev.sentiment ?? "neutral",
    symbols: ev.symbols ?? [],
    title: ev.title ?? "",
    ageMinutes: Math.max(0, Math.floor((now - ts) / 60_000)),
  }));
}

const CLOSED_POSITIONS_KEY = "ai-scalper:trader:positions:closed";
const EVENTS_RECENT_KEY = "ai-scalper:events:recent";
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const EVENTS_LOOKBACK_MS = 4 * 60 * 60 * 1000;
const EVENTS_MAX_RETURNED = 8;

function safeNumber(s: string | undefined): number {
  if (!s) return 0;
  const v = Number(s);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Summarize a Bybit kline list (newest-first) into a compact descriptor for
 * the LLM. Returns zeros if input is empty/malformed.
 */
export function summarizeKlines(klines: ReadonlyArray<{
  highPrice?: string; lowPrice?: string; closePrice?: string; volume?: string;
}>): KlineSummary {
  if (klines.length === 0) {
    return { barsSampled: 0, rangeHigh: 0, rangeLow: 0, rangePct: 0, trendBps: 0, volumeRatioVsAvg: 0, lastClose: 0 };
  }
  // Bybit is newest-first; reverse to oldest-first for trend calc.
  const oldestFirst = [...klines].reverse();
  const highs = oldestFirst.map((k) => safeNumber(k.highPrice)).filter((n) => n > 0);
  const lows = oldestFirst.map((k) => safeNumber(k.lowPrice)).filter((n) => n > 0);
  const closes = oldestFirst.map((k) => safeNumber(k.closePrice)).filter((n) => n > 0);
  const volumes = oldestFirst.map((k) => safeNumber(k.volume));
  if (highs.length === 0 || lows.length === 0 || closes.length === 0) {
    return { barsSampled: 0, rangeHigh: 0, rangeLow: 0, rangePct: 0, trendBps: 0, volumeRatioVsAvg: 0, lastClose: 0 };
  }
  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);
  const firstClose = closes[0]!;
  const lastClose = closes[closes.length - 1]!;
  const trendBps = firstClose > 0 ? ((lastClose - firstClose) / firstClose) * 10_000 : 0;
  const rangePct = rangeLow > 0 ? ((rangeHigh - rangeLow) / rangeLow) * 100 : 0;
  const lastVol = volumes[volumes.length - 1] ?? 0;
  const priorVols = volumes.slice(0, -1).filter((v) => v > 0);
  const avgPriorVol = priorVols.length > 0
    ? priorVols.reduce((s, v) => s + v, 0) / priorVols.length
    : 0;
  const volumeRatioVsAvg = avgPriorVol > 0 ? lastVol / avgPriorVol : 0;
  return {
    barsSampled: oldestFirst.length,
    rangeHigh, rangeLow, rangePct,
    trendBps, volumeRatioVsAvg, lastClose,
  };
}

async function collectChartContext(deps: {
  client: BybitClient;
  tickerSource: TickerSource;
  redis?: RedisLike | null;
}): Promise<ChartContext | undefined> {
  try {
    const [k5, k60, k240, ticker, recentEvents] = await Promise.all([
      deps.client.getKlines({ category: "linear", symbol: "BTCUSDT", interval: "5", limit: 24 }),
      deps.client.getKlines({ category: "linear", symbol: "BTCUSDT", interval: "60", limit: 24 }),
      deps.client.getKlines({ category: "linear", symbol: "BTCUSDT", interval: "240", limit: 24 }),
      deps.tickerSource.getTicker("BTCUSDT", { category: "linear" }),
      collectRecentEvents(deps.redis ?? null),
    ]);
    const bid = safeNumber(ticker.bid1Price);
    const ask = safeNumber(ticker.ask1Price);
    const mid = (bid + ask) / 2;
    const spreadBps = mid > 0 ? ((ask - bid) / mid) * 10_000 : 0;
    return {
      klines5m: summarizeKlines(k5),
      klines1h: summarizeKlines(k60),
      klines4h: summarizeKlines(k240),
      orderbook: { bid1Price: bid, ask1Price: ask, spreadBps },
      ...(recentEvents.length > 0 ? { recentEvents } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function collectRegime(deps: {
  client: BybitClient;
  tickerSource: TickerSource;
  scanLatestPath?: string;
  observedAt?: string;
  /** Optional Redis client used to pull recent events from the event-feeder
   *  via collectRecentEvents. */
  redis?: RedisLike | null;
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
    const btcPerp = await deps.tickerSource.getTicker("BTCUSDT", { category: "linear" });
    btcPrice = safeNumber(btcPerp.lastPrice);
    const prev1h = safeNumber(btcPerp.prevPrice1h);
    if (prev1h > 0 && btcPrice > 0) {
      btcRealizedVol1h = Math.abs((btcPrice - prev1h) / prev1h) * 100;
    }
    // BTC spot for basis.
    try {
      const btcSpot = await deps.tickerSource.getTicker("BTCUSDT", { category: "spot" });
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

  // Chart context (multi-TF + L1 OB + recent events) — best-effort.
  const chartContext = await collectChartContext({
    client: deps.client, tickerSource: deps.tickerSource, redis: deps.redis ?? null,
  });

  return {
    observedAt,
    btcPrice,
    btcTrendBps4h,
    btcRealizedVol1h,
    avgFundingRateBps,
    spotPerpBasisBps,
    topRankedSetups,
    ...(chartContext ? { chartContext } : {}),
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
