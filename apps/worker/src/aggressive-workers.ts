/**
 * Aggressive trader worker stack.
 *
 * SEPARATE from the conservative pipeline (pipeline-workers.ts). Different
 * queues, different ledger namespace, different one-position semantics. Gated
 * by the aggressive subsystem config (apps/trader/config.aggressive.json).
 *
 * Pipeline:
 *   evaluate tick (every N s) → events reader → buildLiquidationMap →
 *     equity → selectActiveTier → liquidationHunterDecide → guards →
 *     placeAggressiveEntry (if allowed and no active position)
 *
 *   manage tick (every M s, per-position) → processAggressiveManageTick →
 *     stop/TP/maxHold check → close + ledger + dailyState on trigger
 */

import { Queue, Worker } from "bullmq";
import type IORedisType from "ioredis";

import { createBybitClient } from "@ai-scalper/bybit-client";
import { createRestTickerSource, createCachedTickerSource } from "@ai-scalper/bybit-client/ticker-source";
import { createRedisTickerCache } from "@ai-scalper/bybit-client/ws-redis-cache";
import type { TraderConfig } from "../../trader/src/config";
import { createWebhookAlerter } from "../../trader/src/alerts/webhook";
import {
  placeAggressiveEntry,
  type AggressiveManageJobData,
} from "../../trader/src/aggressive/adapter";
import { processAggressiveManageTick, type AggressiveLedgerLike } from "../../trader/src/aggressive/manage-processor";
import { createRedisAggressiveEventsReader } from "../../trader/src/aggressive/events-reader";
import { buildLiquidationMap } from "../../trader/src/aggressive/liquidation-map";
import { liquidationHunterDecide } from "../../trader/src/aggressive/liquidation-hunter";
import { selectActiveTier } from "../../trader/src/aggressive/tier-engine";
import {
  DEFAULT_AGGRESSIVE_GUARDS,
  runAggressiveGuards,
} from "../../trader/src/aggressive/guards";
import { createRedisDailyStateStore } from "../../trader/src/aggressive/daily-state";
import { createPaperEquityTracker } from "../../trader/src/aggressive/equity-tracker";
import type { AggressiveSubsystemConfig } from "../../trader/src/aggressive/config";
import { safeRemoveRepeatable, type RepeatableQueueLike } from "../../trader/src/strategies/shared/trade-job-helpers";
import type { ClosedPositionLedgerEntry } from "../../trader/src/trading/position-ledger";

const EVAL_QUEUE = "aggressive-evaluate";
const MANAGE_QUEUE = "aggressive-manage";
const EVAL_JOB = "aggressive-evaluate.tick";
const MANAGE_JOB = "aggressive-manage.tick";
const AGGRESSIVE_LEDGER_KEY = "ai-scalper:aggressive:positions:closed";
const AGGRESSIVE_LEDGER_LIMIT = 200;

interface EvaluateJobData { triggeredAt: string }

export interface AggressiveWorkerStack {
  evalQueue: Queue<EvaluateJobData>;
  manageQueue: Queue<AggressiveManageJobData>;
  evalWorker: Worker<EvaluateJobData>;
  manageWorker: Worker<AggressiveManageJobData>;
  shutdown(): Promise<void>;
}

/** Inline aggressive ledger writer — separate namespace from the conservative ledger. */
function createAggressiveLedger(redis: IORedisType): AggressiveLedgerLike & { close(): Promise<void> } {
  return {
    async appendClosedPosition(entry: ClosedPositionLedgerEntry) {
      const pipeline = redis.multi();
      pipeline.lpush(AGGRESSIVE_LEDGER_KEY, JSON.stringify(entry));
      pipeline.ltrim(AGGRESSIVE_LEDGER_KEY, 0, AGGRESSIVE_LEDGER_LIMIT - 1);
      await pipeline.exec();
    },
    async close() { /* shared Redis; nothing to release */ },
  };
}

export async function startAggressiveWorkerStack(deps: {
  connection: IORedisType;
  traderConfig: TraderConfig;
  aggressiveConfig: AggressiveSubsystemConfig;
}): Promise<AggressiveWorkerStack> {
  const { connection, traderConfig, aggressiveConfig: cfg } = deps;

  const evalQueue = new Queue<EvaluateJobData>(EVAL_QUEUE, { connection, defaultJobOptions: { attempts: 1, removeOnComplete: 20, removeOnFail: 20 } });
  const manageQueue = new Queue<AggressiveManageJobData>(MANAGE_QUEUE, { connection, defaultJobOptions: { attempts: 1, removeOnComplete: 50, removeOnFail: 50 } });

  const client = createBybitClient();
  const tickerSource = traderConfig.useWebSocket
    ? createCachedTickerSource({ cache: createRedisTickerCache(connection), fallback: client, defaultMaxAgeMs: 5_000 })
    : createRestTickerSource(client);
  const alerter = createWebhookAlerter(traderConfig.alertWebhookUrl);

  const eventsReader = createRedisAggressiveEventsReader(connection);
  const ledger = createAggressiveLedger(connection);
  const dailyState = createRedisDailyStateStore(connection);
  const equityTracker = createPaperEquityTracker(connection, {
    startingEquityUsd: cfg.startingEquityUsd,
    ledgerKey: AGGRESSIVE_LEDGER_KEY,
  });

  // ── evaluate worker ─────────────────────────────────────────────────────
  const evalWorker = new Worker<EvaluateJobData>(EVAL_QUEUE, async (job) => {
    if (job.name !== EVAL_JOB) throw new Error(`unsupported job: ${job.name}`);
    const observedAt = new Date().toISOString();
    const log = (p: Record<string, unknown>) => console.log(JSON.stringify(p));

    // One-position invariant for the aggressive subsystem.
    const live = await manageQueue.getDelayedCount() + await manageQueue.getActiveCount() + await manageQueue.getWaitingCount();
    if (live > 0) return { status: "skipped", reason: "active-position-exists" };

    // Current price (refPrice for the map).
    let refPrice = 0;
    try {
      const t = await tickerSource.getTicker(cfg.symbol, { category: "linear" });
      refPrice = Number(t.lastPrice);
    } catch (err) {
      log({ ts: observedAt, event: "aggressive-eval-skip", reason: "ticker-unavailable" });
      return { status: "skipped", reason: "ticker-unavailable" };
    }
    if (!Number.isFinite(refPrice) || refPrice <= 0) return { status: "skipped", reason: "ticker-invalid" };

    // Build map.
    const sinceMs = Date.now() - cfg.liquidationLookbackMs;
    const events = await eventsReader.getRecentWithPrice(cfg.symbol, sinceMs);
    const map = buildLiquidationMap(events, refPrice, {
      bandBps: cfg.mapBandBps, minMagnetSizeUsd: cfg.mapMinMagnetSizeUsd,
      maxAgeMs: cfg.liquidationLookbackMs, nowMs: Date.now(),
    });

    // Equity → tier.
    const equity = await equityTracker.getCurrentEquityUsd();
    const { tier } = selectActiveTier(cfg.tierLadder, equity);

    // Decide.
    const intent = liquidationHunterDecide(map, tier);
    if (intent.kind !== "enter") {
      log({ ts: observedAt, event: "aggressive-decide-skip", reason: intent.reason });
      return { status: "skipped", reason: intent.reason };
    }

    // Guards.
    const guardState = await dailyState.buildGuardState(equity);
    const guards = runAggressiveGuards(DEFAULT_AGGRESSIVE_GUARDS, intent, guardState, {
      dailyLossCapFraction: cfg.dailyLossCapFraction,
      maxTradesPerDay: cfg.maxTradesPerDay,
      maxTotalCapitalUsd: cfg.maxCapitalUsd,
    });
    if (!guards.allowed) {
      log({ ts: observedAt, event: "aggressive-guard-block", reason: guards.reason });
      return { status: "skipped", reason: guards.reason };
    }

    // Instrument info for qty step.
    let instrument;
    try { instrument = await client.getInstrumentInfo({ category: "linear", symbol: cfg.symbol }); }
    catch { return { status: "skipped", reason: "instrument-info-unavailable" }; }

    // Open.
    const result = await placeAggressiveEntry(intent, cfg.symbol, instrument, {
      config: traderConfig, client, alerter, manageQueue, dailyState,
      manageTickMs: cfg.manageTickMs, manageJobName: MANAGE_JOB,
      log, now: () => Date.now(),
    });
    return result;
  }, { connection, concurrency: 1 });

  // ── manage worker ───────────────────────────────────────────────────────
  const manageWorker = new Worker<AggressiveManageJobData>(MANAGE_QUEUE, async (job) => {
    if (job.name !== MANAGE_JOB) throw new Error(`unsupported job: ${job.name}`);
    const result = await processAggressiveManageTick(job.data, {
      config: traderConfig, client, tickerSource, alerter, ledger, dailyState,
      maxHoldSec: cfg.maxHoldSec,
    });
    if (result.status === "continue") {
      try { await job.updateData(result.updatedData); }
      catch (err) { console.warn(JSON.stringify({ event: "aggressive-update-data-failed", error: err instanceof Error ? err.message : String(err) })); }
      return result;
    }
    await safeRemoveRepeatable({ queue: manageQueue as unknown as RepeatableQueueLike, repeatKey: job.repeatJobKey, event: "aggressive-repeat-cleanup-failed" });
    return result;
  }, { connection, concurrency: 1 });

  // Schedule recurring evaluate tick.
  await evalQueue.add(EVAL_JOB, { triggeredAt: new Date().toISOString() }, {
    jobId: "aggressive-evaluate:recurring",
    repeat: { every: Math.max(2_000, cfg.evaluateTickMs) },
    attempts: 1, removeOnComplete: 20, removeOnFail: 20,
  });

  console.log(JSON.stringify({
    event: "aggressive-stack-ready",
    symbol: cfg.symbol, evaluateTickMs: cfg.evaluateTickMs, manageTickMs: cfg.manageTickMs,
    startingEquityUsd: cfg.startingEquityUsd, maxCapitalUsd: cfg.maxCapitalUsd,
    tierCount: cfg.tierLadder.length,
  }));

  return {
    evalQueue, manageQueue, evalWorker, manageWorker,
    async shutdown() {
      await evalWorker.close();
      await manageWorker.close();
      await evalQueue.close();
      await manageQueue.close();
      await ledger.close();
    },
  };
}
