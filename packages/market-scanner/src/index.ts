import { createBybitClient } from "@ai-scalper/bybit-client";
import type { MarketKline } from "@ai-scalper/bybit-client";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  resolveProjectPath,
  scoreScalpCandidate,
  type ScalpCandidate,
  type StrategySignal,
} from "@ai-scalper/trading-core";

export interface ScanConfig {
  category: string;
  scanLimit: number;
  scanPrefilterLimit: number;
  scanKlineInterval: string;
  scanKlineLimit: number;
  scanSignalThresholdBps: number;
  scanOutputDir: string;
  scanBaseUrl: string;
  scanTakerFeeBps: number;
  scanEstimatedSlippageBps: number;
  scanMinNetEdgeBps: number;
  scanMaxFundingBps: number;
  scanMinOpenInterestUsd?: number;
  scanMinListingAgeDays?: number;
  scanExcludedSymbols?: string[];
}

export interface ScanArtifacts {
  generatedAt: string;
  latestPath: string;
  snapshotPath: string;
}

export interface RankedTradeSetup extends ScalpCandidate {
  action: StrategySignal;
  trendBps: number;
}

export interface MarketScanResult {
  ts: string;
  mode: "scan";
  category: string;
  candidates: RankedTradeSetup[];
  artifacts: ScanArtifacts;
}

export function readScanConfig(env: NodeJS.ProcessEnv = process.env): ScanConfig {
  return {
    category: env.BYBIT_CATEGORY || "linear",
    scanLimit: Number(env.SCAN_LIMIT || "10"),
    scanPrefilterLimit: Number(env.SCAN_PREFILTER_LIMIT || "25"),
    scanKlineInterval: env.SCAN_KLINE_INTERVAL || "1",
    scanKlineLimit: Number(env.SCAN_KLINE_LIMIT || "15"),
    scanSignalThresholdBps: Number(env.SCAN_SIGNAL_THRESHOLD_BPS || "3"),
    scanOutputDir: env.SCAN_OUTPUT_DIR || "apps/trader/data",
    scanBaseUrl: env.BYBIT_SCAN_BASE_URL || "https://api.bybit.com",
    scanTakerFeeBps: Number(env.SCAN_TAKER_FEE_BPS || "5.5"),
    scanEstimatedSlippageBps: Number(env.SCAN_ESTIMATED_SLIPPAGE_BPS || "4"),
    scanMinNetEdgeBps: Number(env.SCAN_MIN_NET_EDGE_BPS || "4"),
    scanMaxFundingBps: Number(env.SCAN_MAX_FUNDING_BPS || "10"),
    scanMinOpenInterestUsd: env.SCAN_MIN_OPEN_INTEREST_USD ? Number(env.SCAN_MIN_OPEN_INTEREST_USD) : 0,
    scanMinListingAgeDays: env.SCAN_MIN_LISTING_AGE_DAYS ? Number(env.SCAN_MIN_LISTING_AGE_DAYS) : 0,
    scanExcludedSymbols: env.SCAN_EXCLUDED_SYMBOLS
      ? env.SCAN_EXCLUDED_SYMBOLS.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
  };
}

// ---------- Phase 1A: auto-tune setup gate ----------

export interface ScanHistoryEntry {
  ts: string;
  netEdgeBpsPercentiles: { p50: number; p75: number; p90: number };
}

export function percentile(sortedAsc: number[], pct: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const rank = (pct / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = rank - lo;
  return sortedAsc[lo]! * (1 - frac) + sortedAsc[hi]! * frac;
}

export function autoTuneSetupGate(params: {
  scanHistory: Array<{ ts: string; netEdgeBpsPercentiles: { p50: number; p75: number; p90: number } }>;
  targetPercentile: 50 | 75 | 90;
  fallbackBps: number;
}): number {
  if (params.scanHistory.length === 0) {
    return params.fallbackBps;
  }
  const key: "p50" | "p75" | "p90" =
    params.targetPercentile === 50 ? "p50" : params.targetPercentile === 75 ? "p75" : "p90";
  const values = params.scanHistory
    .map((e) => e.netEdgeBpsPercentiles[key])
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (values.length === 0) return params.fallbackBps;
  // return the median of historical percentile values
  return percentile(values, 50);
}

function scanHistoryPath(): string {
  return resolveProjectPath("apps/trader/data/scan-history.json");
}

export async function loadScanHistory(): Promise<ScanHistoryEntry[]> {
  try {
    const file = Bun.file(scanHistoryPath());
    if (!(await file.exists())) return [];
    const parsed = (await file.json()) as ScanHistoryEntry[] | { entries?: ScanHistoryEntry[] };
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.entries)) return parsed.entries;
    return [];
  } catch {
    return [];
  }
}

export async function persistScanHistory(entries: ScanHistoryEntry[]): Promise<string> {
  const path = scanHistoryPath();
  try {
    const dir = resolveProjectPath("apps/trader/data");
    await mkdir(dir, { recursive: true });
    await Bun.write(path, `${JSON.stringify(entries, null, 2)}\n`);
  } catch {
    // best-effort
  }
  return path;
}

export function computeScanPercentiles(netEdgeBpsValues: number[]): {
  p50: number;
  p75: number;
  p90: number;
} {
  const sorted = [...netEdgeBpsValues].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p90: percentile(sorted, 90),
  };
}

function parseTickerNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function averageMinuteRangeBps(
  klines: Awaited<ReturnType<ReturnType<typeof createBybitClient>["getKlines"]>>,
): number {
  if (klines.length === 0) {
    return 0;
  }

  const total = klines.reduce((sum, kline) => {
    const high = Number(kline.highPrice);
    const low = Number(kline.lowPrice);
    const close = Number(kline.closePrice);

    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close) || close <= 0) {
      return sum;
    }

    return sum + (((high - low) / close) * 10_000);
  }, 0);

  return total / klines.length;
}

function sortKlinesAscending(klines: MarketKline[]): MarketKline[] {
  return [...klines].sort((left, right) => Number(left.startTime) - Number(right.startTime));
}

export function deriveTrendBpsFromKlines(klines: MarketKline[]): number {
  if (klines.length === 0) {
    return 0;
  }

  const ordered = sortKlinesAscending(klines);
  const firstOpen = Number(ordered[0]?.openPrice);
  const lastClose = Number(ordered.at(-1)?.closePrice);

  if (!Number.isFinite(firstOpen) || !Number.isFinite(lastClose) || firstOpen <= 0) {
    return 0;
  }

  return ((lastClose - firstOpen) / firstOpen) * 10_000;
}

export function deriveTradeActionFromTrend(trendBps: number, thresholdBps: number): StrategySignal {
  if (trendBps >= thresholdBps) {
    return "long";
  }

  if (trendBps <= -thresholdBps) {
    return "short";
  }

  return "flat";
}

async function persistScanArtifacts(params: {
  candidates: RankedTradeSetup[];
  config: ScanConfig;
}): Promise<ScanArtifacts> {
  const outputDir = resolveOutputDir(params.config.scanOutputDir);
  const scansDir = join(outputDir, "scans");
  await mkdir(scansDir, { recursive: true });

  const generatedAt = new Date().toISOString();
  const timestamp = generatedAt.replaceAll(":", "-");
  const latestPayload = {
    generatedAt,
    category: params.config.category,
    scanConfig: {
      prefilterLimit: params.config.scanPrefilterLimit,
      limit: params.config.scanLimit,
      klineInterval: params.config.scanKlineInterval,
      klineLimit: params.config.scanKlineLimit,
      takerFeeBps: params.config.scanTakerFeeBps,
      estimatedSlippageBps: params.config.scanEstimatedSlippageBps,
      minNetEdgeBps: params.config.scanMinNetEdgeBps,
      maxFundingBps: params.config.scanMaxFundingBps,
    },
    candidates: params.candidates,
  };

  const latestPath = join(outputDir, "scan-latest.json");
  const snapshotPath = join(scansDir, `scan-${timestamp}.json`);

  await Bun.write(latestPath, `${JSON.stringify(latestPayload, null, 2)}\n`);
  await Bun.write(snapshotPath, `${JSON.stringify(latestPayload, null, 2)}\n`);

  return {
    generatedAt,
    latestPath,
    snapshotPath,
  };
}

function resolveOutputDir(scanOutputDir: string): string {
  if (isAbsolute(scanOutputDir)) {
    return scanOutputDir;
  }

  const cwd = process.cwd();
  if (cwd.endsWith("/apps/trader") || cwd.endsWith("/apps/worker")) {
    return join(cwd, "..", "..", scanOutputDir);
  }

  return join(cwd, scanOutputDir);
}

export async function rankTradeSetups(config: ScanConfig): Promise<RankedTradeSetup[]> {
  const client = createBybitClient({
    baseUrl: config.scanBaseUrl,
  });
  const tickers = await client.getTickers({ category: config.category });
  const excluded = new Set(config.scanExcludedSymbols ?? []);
  const shortlist = tickers
    .filter((ticker) => ticker.symbol.endsWith("USDT") && !excluded.has(ticker.symbol))
    .sort((left, right) => parseTickerNumber(right.turnover24h) - parseTickerNumber(left.turnover24h))
    .slice(0, config.scanPrefilterLimit);

  const minOiUsd = config.scanMinOpenInterestUsd ?? 0;
  const minListingDays = config.scanMinListingAgeDays ?? 0;

  const candidates = await Promise.all(shortlist.map(async (ticker): Promise<RankedTradeSetup | null> => {
    try {
      // Pre-filter: open interest gate before kline fetches.
      const oiValue = parseTickerNumber(ticker.openInterestValue);
      if (minOiUsd > 0 && oiValue < minOiUsd) {
        return null;
      }

      const [instrument, klines] = await Promise.all([
        client.getInstrumentInfo({
          category: config.category,
          symbol: ticker.symbol,
        }),
        client.getKlines({
          category: config.category,
          symbol: ticker.symbol,
          interval: config.scanKlineInterval,
          limit: config.scanKlineLimit,
        }),
      ]);

      // Listing-age gate: fetch daily klines & require >= N candles.
      if (minListingDays > 0) {
        const dailyKlines = await client.getKlines({
          category: config.category,
          symbol: ticker.symbol,
          interval: "D",
          limit: Math.max(minListingDays, 1),
        });
        if (dailyKlines.length < minListingDays) {
          return null;
        }
      }

      const candidate = scoreScalpCandidate({
        symbol: ticker.symbol,
        lastPrice: parseTickerNumber(ticker.lastPrice),
        bidPrice: parseTickerNumber(ticker.bid1Price),
        askPrice: parseTickerNumber(ticker.ask1Price),
        turnover24h: parseTickerNumber(ticker.turnover24h),
        openInterestValue: parseTickerNumber(ticker.openInterestValue),
        price24hPcnt: parseTickerNumber(ticker.price24hPcnt),
        prevPrice1h: parseTickerNumber(ticker.prevPrice1h),
        fundingRate: parseTickerNumber(ticker.fundingRate),
        maxLeverage: Number(instrument.leverageFilter.maxLeverage),
        minuteRangeBps: averageMinuteRangeBps(klines),
        estimatedRoundTripCostBps: (config.scanTakerFeeBps * 2) + config.scanEstimatedSlippageBps,
        minNetEdgeBps: config.scanMinNetEdgeBps,
      });

      if (!candidate) {
        return null;
      }

      const trendBps = deriveTrendBpsFromKlines(klines);

      return {
        ...candidate,
        action: deriveTradeActionFromTrend(trendBps, config.scanSignalThresholdBps),
        trendBps: Number(trendBps.toFixed(2)),
      };
    } catch {
      return null;
    }
  }));

  return candidates
    .filter((candidate): candidate is RankedTradeSetup => candidate !== null)
    .filter((candidate) => Math.abs(candidate.fundingRateBps) <= config.scanMaxFundingBps)
    .sort((left, right) => right.score - left.score)
    .slice(0, config.scanLimit);
}

export async function scanMarket(config: ScanConfig): Promise<MarketScanResult> {
  const ranked = await rankTradeSetups(config);

  const artifacts = await persistScanArtifacts({
    candidates: ranked,
    config,
  });

  // Append percentile snapshot to scan-history.json (cap at 50 entries).
  try {
    const netEdges = ranked.map((c) => c.netEdgeBps);
    if (netEdges.length > 0) {
      const history = await loadScanHistory();
      history.push({
        ts: artifacts.generatedAt,
        netEdgeBpsPercentiles: computeScanPercentiles(netEdges),
      });
      while (history.length > 50) history.shift();
      await persistScanHistory(history);
    }
  } catch {
    // best-effort; never fail the scan on history I/O.
  }

  return {
    ts: new Date().toISOString(),
    mode: "scan",
    category: config.category,
    candidates: ranked,
    artifacts,
  };
}
