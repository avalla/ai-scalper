/**
 * Phase 3 pipeline Worker stack — scan → evaluate → trading-agent.
 *
 * Gated by `config.usePipeline`. Replaces the legacy open-processors for the
 * piloted strategies with two new stages:
 *   - one evaluate worker (stateless, fan-out per strategy via job data)
 *   - one trading-agent worker (single executor, per-strategy adapters)
 * The per-strategy MANAGE workers are unchanged — reused verbatim here so the
 * position lifecycle stays identical to the Phase 2 path.
 *
 * The agent's one-position invariant counts across ALL piloted manage queues
 * (a single global "one open position" gate), via an aggregate counter.
 */

import { Queue, Worker } from "bullmq";
import type IORedisType from "ioredis";

import {
  JOB_NAMES,
  QUEUE_NAMES,
  STRATEGY_JOB_POLICY,
  type StrategyEvaluateJobData,
  type TradingAgentJobData,
} from "@ai-scalper/queueing";

import { createBybitClient } from "@ai-scalper/bybit-client";
import { createRestTickerSource, createCachedTickerSource } from "@ai-scalper/bybit-client/ticker-source";
import { createRedisTickerCache } from "@ai-scalper/bybit-client/ws-redis-cache";
import type { TraderConfig } from "../../trader/src/config";
import { createWebhookAlerter } from "../../trader/src/alerts/webhook";
import {
  createStrategySharedState,
  type ActivePositionCounterQueue,
  type StrategySharedState,
} from "../../trader/src/strategies/shared/bullmq-shared-state";
import { createPositionLedger } from "../../trader/src/trading/position-ledger";
import { safeRemoveRepeatable, type RepeatableQueueLike } from "../../trader/src/strategies/shared/trade-job-helpers";
import { processStrategyEvaluateTick } from "../../trader/src/pipeline/strategy-evaluate-processor";
import { createCalendarRotator } from "../../trader/src/pipeline/calendar-rotator";
import { processTradingAgentExecute } from "../../trader/src/pipeline/trading-agent-processor";
import { PILOT_ADAPTERS, PILOT_EVALUATORS } from "../../trader/src/pipeline/pilots";
import type { QueueLike } from "../../trader/src/pipeline/types";
import { processFundingArbManageTick } from "../../trader/src/strategies/funding-arb-manage-processor";
import { processBasisArbManageTick } from "../../trader/src/strategies/basis-arb-manage-processor";
import { processLongerTfManageTick } from "../../trader/src/strategies/longer-tf-manage-processor";
import { processBollingerAdxManageTick } from "../../trader/src/strategies/bollinger-adx-manage-processor";
import { processCalendarSpreadManageTick } from "../../trader/src/strategies/calendar-spread-manage-processor";
import { processPairsTradingManageTick } from "../../trader/src/strategies/pairs-trading-manage-processor";
import { createInMemoryPairsCacheStore } from "../../trader/src/strategies/pairs-trading-open-processor";

/** Strategies driven by the pipeline pilot. */
const ALL_PILOT_STRATEGIES = ["funding-arb", "basis-arb", "longer-tf", "bollinger-adx", "calendar-spread", "pairs-trading"] as const;
type PilotStrategy = typeof ALL_PILOT_STRATEGIES[number];
// Optional scope: env PIPELINE_STRATEGIES="calendar-spread,basis-arb" → only those run.
// Empty/missing → all six. Used by the live unit to start with calendar-spread only.
function selectStrategies(): readonly PilotStrategy[] {
  const raw = process.env.PIPELINE_STRATEGIES?.trim();
  if (!raw) return ALL_PILOT_STRATEGIES;
  const requested = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  const filtered = ALL_PILOT_STRATEGIES.filter((s) => requested.has(s));
  if (filtered.length === 0) {
    console.warn(JSON.stringify({ event: "pipeline-strategies-env-invalid", raw, falling_back_to: "all" }));
    return ALL_PILOT_STRATEGIES;
  }
  return filtered;
}
const PILOT_STRATEGIES = selectStrategies();

export interface PipelineWorkerStack {
  evaluateQueue: Queue<StrategyEvaluateJobData>;
  agentQueue: Queue<TradingAgentJobData>;
  evaluateWorker: Worker<StrategyEvaluateJobData>;
  agentWorker: Worker<TradingAgentJobData>;
  manageWorkers: Worker[];
  shutdown(): Promise<void>;
}

/** Sum active/waiting/delayed across several queues for a global position gate. */
function aggregateCounter(queues: ActivePositionCounterQueue[]): ActivePositionCounterQueue {
  const sum = async (pick: (q: ActivePositionCounterQueue) => Promise<number>) =>
    (await Promise.all(queues.map(pick))).reduce((a, b) => a + b, 0);
  return {
    getActiveCount: () => sum((q) => q.getActiveCount()),
    getWaitingCount: () => sum((q) => q.getWaitingCount()),
    getDelayedCount: () => sum((q) => q.getDelayedCount()),
  };
}

interface ManageTickResult<TData> { status: string; updatedData?: TData }

export async function startPipelineWorkerStack(deps: {
  connection: IORedisType;
  config: TraderConfig;
}): Promise<PipelineWorkerStack> {
  const { connection, config } = deps;

  // Stage queues.
  const evaluateQueue = new Queue<StrategyEvaluateJobData>(
    QUEUE_NAMES.strategyEvaluate, { connection, defaultJobOptions: STRATEGY_JOB_POLICY },
  );
  const agentQueue = new Queue<TradingAgentJobData>(
    QUEUE_NAMES.tradingAgent, { connection, defaultJobOptions: STRATEGY_JOB_POLICY },
  );

  const client = createBybitClient();
  const tickerSource = config.useWebSocket
    ? createCachedTickerSource({ cache: createRedisTickerCache(connection), fallback: client, defaultMaxAgeMs: 5_000 })
    : createRestTickerSource(client);
  const alerter = createWebhookAlerter(config.alertWebhookUrl);
  const positionLedger = createPositionLedger();
  // Auto-rotates the dated leg as quarterlies settle. baseCoin inferred from
  // the perp symbol (BTCUSDT → BTC). Refresh hourly; the REST call is cheap.
  const rotatorBaseCoin = (config.calendarPerpSymbol || "BTCUSDT").replace(/USDT$|USDC$/, "") || "BTC";
  const calendarRotator = createCalendarRotator(client, { baseCoin: rotatorBaseCoin, refreshMs: 60 * 60_000 });

  // Per-strategy manage queues + their shared state (reused from Phase 2).
  const manageQueueByStrategy: Record<string, Queue> = {};
  const sharedByStrategy: Record<string, StrategySharedState> = {};
  const manageQueueName: Record<string, string> = {
    "funding-arb": QUEUE_NAMES.fundingArbTradeManagement,
    "basis-arb": QUEUE_NAMES.basisArbTradeManagement,
    "longer-tf": QUEUE_NAMES.longerTfTradeManagement,
    "bollinger-adx": QUEUE_NAMES.bollingerAdxTradeManagement,
    "calendar-spread": QUEUE_NAMES.calendarSpreadTradeManagement,
    "pairs-trading": QUEUE_NAMES.pairsTradingTradeManagement,
  };
  for (const strategy of PILOT_STRATEGIES) {
    const q = new Queue(manageQueueName[strategy]!, { connection, defaultJobOptions: STRATEGY_JOB_POLICY });
    manageQueueByStrategy[strategy] = q;
    sharedByStrategy[strategy] = createStrategySharedState({ strategy, redis: connection, manageQueue: q });
  }

  // Global one-position gate for the agent: counts across all pilot queues.
  const agentShared = createStrategySharedState({
    strategy: "pipeline",
    redis: connection,
    manageQueue: aggregateCounter(PILOT_STRATEGIES.map((s) => manageQueueByStrategy[s]!)),
  });

  const manageQueues: Record<string, QueueLike<Record<string, unknown>>> = {};
  for (const s of PILOT_STRATEGIES) manageQueues[s] = manageQueueByStrategy[s] as unknown as QueueLike<Record<string, unknown>>;

  // Stage 2 — evaluate worker.
  const evaluateWorker = new Worker<StrategyEvaluateJobData>(
    QUEUE_NAMES.strategyEvaluate,
    async (job) => {
      if (job.name !== JOB_NAMES.strategyEvaluateTick) throw new Error(`Unsupported job name: ${job.name}`);
      return processStrategyEvaluateTick(job.data, {
        config, client, tickerSource,
        registry: PILOT_EVALUATORS as any,
        intentQueue: agentQueue,
        calendarRotator,
      });
    },
    { connection, concurrency: 1 },
  );

  // Stage 3 — trading-agent worker.
  const agentWorker = new Worker<TradingAgentJobData>(
    QUEUE_NAMES.tradingAgent,
    async (job) => {
      if (job.name !== JOB_NAMES.tradingAgentExecute) throw new Error(`Unsupported job name: ${job.name}`);
      return processTradingAgentExecute(job.data, {
        config, client, tickerSource, alerter, sharedState: agentShared,
        registry: PILOT_ADAPTERS as any,
        manageQueues,
      });
    },
    { connection, concurrency: 1 },
  );

  // Manage workers (reused processors). One per pilot strategy.
  const makeManageWorker = <TData>(opts: {
    strategy: string;
    jobName: string;
    run: (data: TData) => Promise<ManageTickResult<TData>>;
  }): Worker<TData> => {
    const queue = manageQueueByStrategy[opts.strategy]!;
    return new Worker<TData>(
      manageQueueName[opts.strategy]!,
      async (job) => {
        if (job.name !== opts.jobName) throw new Error(`Unsupported job name: ${job.name}`);
        const result = await opts.run(job.data);
        if (result.status === "continue") {
          try { await job.updateData(result.updatedData as TData); }
          catch (err) { console.warn(JSON.stringify({ event: `${opts.strategy}-update-data-failed`, error: err instanceof Error ? err.message : String(err) })); }
          return result;
        }
        await safeRemoveRepeatable({ queue: queue as unknown as RepeatableQueueLike, repeatKey: job.repeatJobKey, event: `${opts.strategy}-repeat-cleanup-failed` });
        return result;
      },
      { connection, concurrency: 5 },
    );
  };

  const pairsCacheStore = createInMemoryPairsCacheStore();
  const manageWorkers: Worker[] = [
    makeManageWorker({ strategy: "funding-arb", jobName: JOB_NAMES.fundingArbManageTick, run: (d) => processFundingArbManageTick(d as any, { config, client, tickerSource, alerter, sharedState: sharedByStrategy["funding-arb"]!, positionLedger }) }),
    makeManageWorker({ strategy: "basis-arb", jobName: JOB_NAMES.basisArbManageTick, run: (d) => processBasisArbManageTick(d as any, { config, client, tickerSource, alerter, sharedState: sharedByStrategy["basis-arb"]!, positionLedger }) }),
    makeManageWorker({ strategy: "longer-tf", jobName: JOB_NAMES.longerTfManageTick, run: (d) => processLongerTfManageTick(d as any, { config, client, tickerSource, alerter, sharedState: sharedByStrategy["longer-tf"]!, positionLedger }) }),
    makeManageWorker({ strategy: "bollinger-adx", jobName: JOB_NAMES.bollingerAdxManageTick, run: (d) => processBollingerAdxManageTick(d as any, { config, client, tickerSource, alerter, sharedState: sharedByStrategy["bollinger-adx"]!, positionLedger }) }),
    makeManageWorker({ strategy: "calendar-spread", jobName: JOB_NAMES.calendarSpreadManageTick, run: (d) => processCalendarSpreadManageTick(d as any, { config, client, tickerSource, alerter, sharedState: sharedByStrategy["calendar-spread"]!, positionLedger }) }),
    makeManageWorker({ strategy: "pairs-trading", jobName: JOB_NAMES.pairsTradingManageTick, run: (d) => processPairsTradingManageTick(d as any, { config, client, tickerSource, alerter, sharedState: sharedByStrategy["pairs-trading"]!, positionLedger, pairsCacheStore }) }),
  ];

  // Recurring evaluate ticks — one per pilot strategy.
  const evaluateIntervalMs = Math.max(5_000, config.pollMs);
  for (const strategy of PILOT_STRATEGIES) {
    await evaluateQueue.add(
      JOB_NAMES.strategyEvaluateTick,
      { strategy, triggeredAt: new Date().toISOString(), configFile: process.env.CONFIG_FILE ?? `config.${strategy}.json` },
      { ...STRATEGY_JOB_POLICY, jobId: `evaluate:${strategy}`, repeat: { every: evaluateIntervalMs } },
    );
  }

  console.log(JSON.stringify({ event: "pipeline-bullmq-stack-ready", evaluateIntervalMs, strategies: PILOT_STRATEGIES }));

  return {
    evaluateQueue, agentQueue, evaluateWorker, agentWorker, manageWorkers,
    async shutdown() {
      await evaluateWorker.close();
      await agentWorker.close();
      for (const w of manageWorkers) await w.close();
      await evaluateQueue.close();
      await agentQueue.close();
      for (const s of PILOT_STRATEGIES) await manageQueueByStrategy[s]!.close();
      await positionLedger.close();
    },
  };
}
