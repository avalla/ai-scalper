/**
 * Pump-scanner worker — assembles universe-fetcher + rolling-window +
 * scanner + LLM analyzer + aggressive trading-agent into a single recurring
 * tick.
 *
 * Lives ALONGSIDE the aggressive subsystem (shares the manage queue + ledger
 * + daily state). Single-position invariant is honored by checking the SAME
 * manage queue used by liquidation-hunter — so the two never trade concurrently.
 *
 * Tick flow (every pumpScanner.evaluateTickMs):
 *   1. Refresh universe (cached for universeRefreshMs).
 *   2. For each universe symbol: push current ticker → rolling window store.
 *   3. For symbols with enough history: scanSymbol → on anomaly, analyzePump
 *      (LLM Claude, gated by llm.enabled). On enter signal w/ confidence ≥
 *      minConfidence: run guards, call placeAggressiveEntry.
 *
 * The LLM is OFF by default (llm.enabled=false) → scanner runs in dry-run:
 * logs anomalies, no trades. Set llm.enabled=true after the universe + scan
 * baseline looks healthy.
 */

import { Queue, Worker } from "bullmq";
import type IORedisType from "ioredis";

import { createBybitClient } from "@ai-scalper/bybit-client";
import type { TraderConfig } from "../../trader/src/config";
import { createWebhookAlerter } from "../../trader/src/alerts/webhook";
import type { AggressiveSubsystemConfig, PumpScannerSubsystemConfig } from "../../trader/src/aggressive/config";
import { createUniverseFetcher, type UniverseEntry } from "../../trader/src/aggressive/universe-fetcher";
import { createRollingWindowStore } from "../../trader/src/aggressive/rolling-window";
import { scanSymbol, type PumpAnomaly } from "../../trader/src/aggressive/pump-scanner";
import { analyzePump, type PumpAnalysisContext, type PumpAnalyzerProvider } from "../../trader/src/aggressive/pump-analyzer";
import { createAnthropicProvider } from "../../trader/src/aggressive/anthropic-provider";
import { DEFAULT_AGGRESSIVE_GUARDS, runAggressiveGuards } from "../../trader/src/aggressive/guards";
import { createRedisDailyStateStore } from "../../trader/src/aggressive/daily-state";
import { createPaperEquityTracker } from "../../trader/src/aggressive/equity-tracker";
import { placeAggressiveEntry, type AggressiveManageJobData } from "../../trader/src/aggressive/adapter";
import type { AggressiveIntent } from "../../trader/src/aggressive/types";

type BybitClient = ReturnType<typeof createBybitClient>;

const EVAL_QUEUE = "pump-scanner-evaluate";
const MANAGE_QUEUE = "aggressive-manage"; // SHARED with liquidation-hunter
const EVAL_JOB = "pump-scanner-evaluate.tick";
const AGGRESSIVE_LEDGER_KEY = "ai-scalper:aggressive:positions:closed";

interface EvalJobData { triggeredAt: string }

export interface PumpScannerWorkerStack {
  evalQueue: Queue<EvalJobData>;
  evalWorker: Worker<EvalJobData>;
  shutdown(): Promise<void>;
}

export async function startPumpScannerWorkerStack(deps: {
  connection: IORedisType;
  traderConfig: TraderConfig;
  aggressive: AggressiveSubsystemConfig;
}): Promise<PumpScannerWorkerStack> {
  const ps = deps.aggressive.pumpScanner;
  if (!ps || !ps.enabled) throw new Error("pumpScanner not enabled in config");

  const client = createBybitClient();
  const alerter = createWebhookAlerter(deps.traderConfig.alertWebhookUrl);
  const universeFetcher = createUniverseFetcher(client, {
    symbolWhitelist: ps.symbolWhitelist ?? undefined,
    symbolBlacklist: ps.symbolBlacklist,
  });
  const windowStore = createRollingWindowStore({ windowMs: ps.windowMs });
  const dailyState = createRedisDailyStateStore(deps.connection);
  const equityTracker = createPaperEquityTracker(deps.connection, {
    startingEquityUsd: deps.aggressive.startingEquityUsd,
    ledgerKey: AGGRESSIVE_LEDGER_KEY,
  });

  // SHARED manage queue with liquidation-hunter — same one-position invariant.
  const manageQueue = new Queue<AggressiveManageJobData>(MANAGE_QUEUE, {
    connection: deps.connection,
    defaultJobOptions: { attempts: 1, removeOnComplete: 50, removeOnFail: 50 },
  });

  let provider: PumpAnalyzerProvider | null = null;
  if (ps.llm.enabled) provider = createAnthropicProvider({ model: ps.llm.model });

  let cachedUniverse: UniverseEntry[] = [];
  let universeRefreshedAt = 0;

  const refreshUniverseIfStale = async (now: number) => {
    if (now - universeRefreshedAt >= ps.universeRefreshMs) {
      try {
        cachedUniverse = await universeFetcher.fetchActive(ps.liquidity);
        universeRefreshedAt = now;
        console.log(JSON.stringify({ event: "pump-scanner-universe-refreshed", count: cachedUniverse.length }));
      } catch (err) {
        console.warn(JSON.stringify({ event: "pump-scanner-universe-refresh-failed", err: err instanceof Error ? err.message : String(err) }));
      }
    }
  };

  // ─── Evaluate worker ────────────────────────────────────────────────────
  const evalQueue = new Queue<EvalJobData>(EVAL_QUEUE, {
    connection: deps.connection,
    defaultJobOptions: { attempts: 1, removeOnComplete: 20, removeOnFail: 20 },
  });

  const evalWorker = new Worker<EvalJobData>(EVAL_QUEUE, async (job) => {
    if (job.name !== EVAL_JOB) throw new Error(`unsupported job: ${job.name}`);
    const now = Date.now();
    await refreshUniverseIfStale(now);

    // One-position invariant (shared with liquidation-hunter).
    const live = await manageQueue.getDelayedCount() + await manageQueue.getActiveCount() + await manageQueue.getWaitingCount();
    if (live > 0) return { status: "skipped", reason: "active-position-exists", universe: cachedUniverse.length };

    // Refresh universe tickers in one batch — push into rolling windows.
    let freshUniverse: UniverseEntry[] = cachedUniverse;
    if (cachedUniverse.length === 0) return { status: "skipped", reason: "empty-universe" };

    // Push each ticker as a sample (price = lastPrice; volume baseline grows
    // from cumulativeVolume diffs by symbol).
    try {
      const tickers = await client.getTickers({ category: "linear" } as Parameters<BybitClient["getTickers"]>[0]);
      const byUniverse = new Set(cachedUniverse.map((u) => u.symbol));
      for (const t of tickers) {
        const symbol = String(t.symbol ?? "").toUpperCase();
        if (!byUniverse.has(symbol)) continue;
        const price = Number(t.lastPrice ?? 0);
        const cumVol = Number((t as { turnover24h?: string }).turnover24h ?? 0);
        if (price > 0) windowStore.push(symbol, { ts: now, price, cumulativeVolumeUsd: cumVol });
      }
      // Update cached snapshots' last/bid/ask too (for the scanner).
      freshUniverse = cachedUniverse.map((u) => {
        const t = tickers.find((x) => String(x.symbol).toUpperCase() === u.symbol);
        if (!t) return u;
        return {
          ...u,
          ticker: {
            ...u.ticker,
            lastPrice: Number(t.lastPrice ?? u.ticker.lastPrice),
            bid1Price: Number(t.bid1Price ?? u.ticker.bid1Price),
            ask1Price: Number(t.ask1Price ?? u.ticker.ask1Price),
            turnover24hUsd: Number((t as { turnover24h?: string }).turnover24h ?? u.ticker.turnover24hUsd),
          },
        };
      });
    } catch (err) {
      console.warn(JSON.stringify({ event: "pump-scanner-tickers-failed", err: err instanceof Error ? err.message : String(err) }));
      return { status: "skipped", reason: "tickers-failed" };
    }

    // Scan each symbol; collect first anomaly (one-position gate enforces serial).
    let chosen: { entry: UniverseEntry; anomaly: PumpAnomaly } | null = null;
    for (const entry of freshUniverse) {
      const window = windowStore.snapshot(entry.symbol);
      if (!window) continue;
      const r = scanSymbol({
        ticker: entry.ticker, window,
        liquidity: ps.liquidity,
        anomaly: { ...ps.anomaly, priceChangeWindowMs: ps.windowMs },
      });
      if (r.kind === "anomaly") {
        chosen = { entry, anomaly: r.anomaly };
        break; // first-match wins; could rank by magnitude later
      }
    }
    if (!chosen) return { status: "no-anomaly", universe: freshUniverse.length };

    console.log(JSON.stringify({
      event: "pump-scanner-anomaly-detected",
      symbol: chosen.anomaly.symbol, direction: chosen.anomaly.direction,
      priceChangeBps: chosen.anomaly.priceChangeBps, volumeMultiple: chosen.anomaly.volumeMultiple,
    }));

    // LLM analysis (if enabled).
    if (!provider) {
      return { status: "dry-run-anomaly", anomaly: chosen.anomaly };
    }
    let klines: any[] = [];
    try {
      const raw = await client.getKlines({ category: "linear", symbol: chosen.anomaly.symbol, interval: "1", limit: 50 });
      klines = (raw as { list?: string[][] }).list ?? [];
    } catch { /* tolerate; analyzer can still reason without kline detail */ }
    const ctx: PumpAnalysisContext = {
      anomaly: chosen.anomaly,
      book: { bid1Price: chosen.entry.ticker.bid1Price, ask1Price: chosen.entry.ticker.ask1Price },
      recentKlines: klines.slice().reverse().map((r) => ({
        ts: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volumeUsd: Number(r[5]) * Number(r[4]),
      })),
    };
    const signal = await analyzePump(ctx, provider);
    if (signal.kind === "skip") {
      console.log(JSON.stringify({ event: "pump-scanner-llm-skip", symbol: chosen.anomaly.symbol, rationale: signal.rationale }));
      return { status: "llm-skip", reason: signal.rationale };
    }
    if (signal.confidence < ps.llm.minConfidence) {
      console.log(JSON.stringify({ event: "pump-scanner-llm-low-confidence", symbol: chosen.anomaly.symbol, confidence: signal.confidence }));
      return { status: "llm-low-confidence", confidence: signal.confidence };
    }

    // Build AggressiveIntent + guards + execute.
    const refPrice = chosen.entry.ticker.lastPrice;
    const stopDistance = refPrice * (signal.stopBps / 10_000);
    const tpDistance = refPrice * (signal.tpBps / 10_000);
    const intent: AggressiveIntent = {
      kind: "enter", side: signal.side, notionalUsd: ps.sizing.maxNotionalUsdPerTrade, leverage: ps.sizing.leverage,
      refPrice, stopPrice: signal.side === "long" ? refPrice - stopDistance : refPrice + stopDistance,
      takeProfitPrice: signal.side === "long" ? refPrice + tpDistance : refPrice - tpDistance,
      reason: `pump-llm:${signal.rationale.slice(0, 80)}`,
    };
    const equity = await equityTracker.getCurrentEquityUsd();
    const guardState = await dailyState.buildGuardState(equity);
    const guards = runAggressiveGuards(DEFAULT_AGGRESSIVE_GUARDS, intent, guardState, {
      dailyLossCapFraction: deps.aggressive.dailyLossCapFraction,
      maxTradesPerDay: deps.aggressive.maxTradesPerDay,
      maxTotalCapitalUsd: deps.aggressive.maxCapitalUsd,
    });
    if (!guards.allowed) {
      console.log(JSON.stringify({ event: "pump-scanner-guard-block", reason: guards.reason }));
      return { status: "guard-block", reason: guards.reason };
    }

    let instrument;
    try { instrument = await client.getInstrumentInfo({ category: "linear", symbol: chosen.anomaly.symbol }); }
    catch { return { status: "skipped", reason: "instrument-info-unavailable" }; }

    const result = await placeAggressiveEntry(intent, chosen.anomaly.symbol, instrument, {
      config: deps.traderConfig, client, alerter, manageQueue, dailyState,
      manageTickMs: 2000, manageJobName: "aggressive-manage.tick",
    });
    return { status: "executed", result, symbol: chosen.anomaly.symbol, side: signal.side };
  }, { connection: deps.connection, concurrency: 1 });

  // Schedule recurring tick.
  await evalQueue.add(EVAL_JOB, { triggeredAt: new Date().toISOString() }, {
    jobId: "pump-scanner-evaluate:recurring",
    repeat: { every: Math.max(2_000, ps.evaluateTickMs) },
    attempts: 1, removeOnComplete: 20, removeOnFail: 20,
  });

  console.log(JSON.stringify({
    event: "pump-scanner-stack-ready",
    evaluateTickMs: ps.evaluateTickMs, universeRefreshMs: ps.universeRefreshMs,
    llmEnabled: ps.llm.enabled, sizing: ps.sizing,
  }));

  return {
    evalQueue, evalWorker,
    async shutdown() {
      await evalWorker.close();
      await evalQueue.close();
      await manageQueue.close();
    },
  };
}
