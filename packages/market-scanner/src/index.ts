import { createBybitClient } from "@ai-scalper/bybit-client";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  scoreScalpCandidate,
  type ScalpCandidate,
} from "@ai-scalper/trading-core";

export interface ScanConfig {
  category: string;
  scanLimit: number;
  scanPrefilterLimit: number;
  scanKlineInterval: string;
  scanKlineLimit: number;
  scanOutputDir: string;
  scanBaseUrl: string;
  scanTakerFeeBps: number;
  scanEstimatedSlippageBps: number;
  scanMinNetEdgeBps: number;
  scanMaxFundingBps: number;
  backtestCandidateLimit: number;
}

export interface ScanArtifacts {
  generatedAt: string;
  latestPath: string;
  snapshotPath: string;
  backtestCandidatesPath: string;
}

export interface MarketScanResult {
  ts: string;
  mode: "scan";
  category: string;
  candidates: ScalpCandidate[];
  artifacts: ScanArtifacts;
}

export function readScanConfig(env: NodeJS.ProcessEnv = process.env): ScanConfig {
  return {
    category: env.BYBIT_CATEGORY || "linear",
    scanLimit: Number(env.SCAN_LIMIT || "10"),
    scanPrefilterLimit: Number(env.SCAN_PREFILTER_LIMIT || "25"),
    scanKlineInterval: env.SCAN_KLINE_INTERVAL || "1",
    scanKlineLimit: Number(env.SCAN_KLINE_LIMIT || "15"),
    scanOutputDir: env.SCAN_OUTPUT_DIR || "apps/trader/data",
    scanBaseUrl: env.BYBIT_SCAN_BASE_URL || "https://api.bybit.com",
    scanTakerFeeBps: Number(env.SCAN_TAKER_FEE_BPS || "5.5"),
    scanEstimatedSlippageBps: Number(env.SCAN_ESTIMATED_SLIPPAGE_BPS || "4"),
    scanMinNetEdgeBps: Number(env.SCAN_MIN_NET_EDGE_BPS || "4"),
    scanMaxFundingBps: Number(env.SCAN_MAX_FUNDING_BPS || "10"),
    backtestCandidateLimit: Number(env.BACKTEST_CANDIDATE_LIMIT || "5"),
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

async function persistScanArtifacts(params: {
  candidates: ScalpCandidate[];
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
  const backtestCandidates = {
    generatedAt,
    status: "pending",
    candidates: params.candidates.slice(0, params.config.backtestCandidateLimit).map((candidate) => ({
      symbol: candidate.symbol,
      score: candidate.score,
      netEdgeBps: candidate.netEdgeBps,
      turnover24h: candidate.turnover24h,
      minuteRangeBps: candidate.minuteRangeBps,
      spreadBps: candidate.spreadBps,
      estimatedRoundTripCostBps: candidate.estimatedRoundTripCostBps,
      priorityBucket: candidate.turnover24h >= 100_000_000
        ? "high-liquidity"
        : candidate.minuteRangeBps >= 40
          ? "high-volatility"
          : "standard",
      nextStep: "run fee-aware backtest",
    })),
  };

  const latestPath = join(outputDir, "scan-latest.json");
  const snapshotPath = join(scansDir, `scan-${timestamp}.json`);
  const backtestCandidatesPath = join(outputDir, "backtest-candidates.json");

  await Bun.write(latestPath, `${JSON.stringify(latestPayload, null, 2)}\n`);
  await Bun.write(snapshotPath, `${JSON.stringify(latestPayload, null, 2)}\n`);
  await Bun.write(backtestCandidatesPath, `${JSON.stringify(backtestCandidates, null, 2)}\n`);

  return {
    generatedAt,
    latestPath,
    snapshotPath,
    backtestCandidatesPath,
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

export async function scanMarket(config: ScanConfig): Promise<MarketScanResult> {
  const client = createBybitClient({
    baseUrl: config.scanBaseUrl,
  });
  const tickers = await client.getTickers({ category: config.category });
  const shortlist = tickers
    .filter((ticker) => ticker.symbol.endsWith("USDT"))
    .sort((left, right) => parseTickerNumber(right.turnover24h) - parseTickerNumber(left.turnover24h))
    .slice(0, config.scanPrefilterLimit);

  const candidates = await Promise.all(shortlist.map(async (ticker): Promise<ScalpCandidate | null> => {
    try {
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

      return scoreScalpCandidate({
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
    } catch {
      return null;
    }
  }));

  const ranked = candidates
    .filter((candidate): candidate is ScalpCandidate => candidate !== null)
    .filter((candidate) => Math.abs(candidate.fundingRateBps) <= config.scanMaxFundingBps)
    .sort((left, right) => right.score - left.score)
    .slice(0, config.scanLimit);

  const artifacts = await persistScanArtifacts({
    candidates: ranked,
    config,
  });

  return {
    ts: new Date().toISOString(),
    mode: "scan",
    category: config.category,
    candidates: ranked,
    artifacts,
  };
}
