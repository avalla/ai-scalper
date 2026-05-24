import { Queue, Worker } from "bullmq";
import type IORedisType from "ioredis";

import {
  JOB_NAMES, QUEUE_NAMES, STRATEGY_JOB_POLICY,
  type PairsTradingManageJobData, type PairsTradingOpenTickJobData,
} from "@ai-scalper/queueing";

import { createBybitClient } from "@ai-scalper/bybit-client";
import type { TraderConfig } from "../../trader/src/config";
import { createWebhookAlerter } from "../../trader/src/alerts/webhook";
import { createStrategySharedState, type StrategySharedState } from "../../trader/src/strategies/shared/bullmq-shared-state";
import {
  createInMemoryPairsCacheStore,
  processPairsTradingOpenTick,
} from "../../trader/src/strategies/pairs-trading-open-processor";
import { processPairsTradingManageTick } from "../../trader/src/strategies/pairs-trading-manage-processor";
import { createPositionLedger } from "../../trader/src/trading/position-ledger";
import { makeOpenTickJobId, safeRemoveRepeatable } from "../../trader/src/strategies/shared/trade-job-helpers";

export interface PairsTradingWorkerStack {
  openQueue: Queue<PairsTradingOpenTickJobData>;
  manageQueue: Queue<PairsTradingManageJobData>;
  openWorker: Worker<PairsTradingOpenTickJobData>;
  manageWorker: Worker<PairsTradingManageJobData>;
  sharedState: StrategySharedState;
  shutdown(): Promise<void>;
}

export async function startPairsTradingWorkerStack(deps: {
  connection: IORedisType;
  config: TraderConfig;
}): Promise<PairsTradingWorkerStack> {
  const { connection, config } = deps;
  const openQueue = new Queue<PairsTradingOpenTickJobData>(
    QUEUE_NAMES.pairsTradingOpenDecision, { connection, defaultJobOptions: STRATEGY_JOB_POLICY },
  );
  const manageQueue = new Queue<PairsTradingManageJobData>(
    QUEUE_NAMES.pairsTradingTradeManagement, { connection, defaultJobOptions: STRATEGY_JOB_POLICY },
  );
  const client = createBybitClient();
  const alerter = createWebhookAlerter(config.alertWebhookUrl);
  const positionLedger = createPositionLedger();
  const sharedState = createStrategySharedState({ strategy: "pairs-trading", redis: connection, manageQueue });
  const pairsCacheStore = createInMemoryPairsCacheStore();

  const openWorker = new Worker<PairsTradingOpenTickJobData>(
    QUEUE_NAMES.pairsTradingOpenDecision,
    async (job) => {
      if (job.name !== JOB_NAMES.pairsTradingOpenTick) throw new Error(`Unsupported job name: ${job.name}`);
      return processPairsTradingOpenTick(job.data, { config, client, alerter, manageQueue, sharedState, pairsCacheStore });
    },
    { connection, concurrency: 1 },
  );

  const manageWorker = new Worker<PairsTradingManageJobData>(
    QUEUE_NAMES.pairsTradingTradeManagement,
    async (job) => {
      if (job.name !== JOB_NAMES.pairsTradingManageTick) throw new Error(`Unsupported job name: ${job.name}`);
      const result = await processPairsTradingManageTick(job.data, { config, client, alerter, sharedState, positionLedger, pairsCacheStore });
      if (result.status === "continue") {
        try { await job.updateData(result.updatedData); } catch (err) {
          console.warn(JSON.stringify({ event: "pairs-trading-update-data-failed", error: err instanceof Error ? err.message : String(err) }));
        }
        return result;
      }
      await safeRemoveRepeatable({ queue: manageQueue, repeatKey: job.repeatJobKey, event: "pairs-trading-repeat-cleanup-failed" });
      return result;
    },
    { connection, concurrency: 5 },
  );

  const openIntervalMs = Math.max(5_000, config.pollMs);
  await openQueue.add(
    JOB_NAMES.pairsTradingOpenTick,
    { triggeredAt: new Date().toISOString(), configFile: process.env.CONFIG_FILE ?? "config.pairs-trading.json" },
    { ...STRATEGY_JOB_POLICY, jobId: makeOpenTickJobId("pairs-trading"), repeat: { every: openIntervalMs } },
  );

  console.log(JSON.stringify({ event: "pairs-trading-bullmq-stack-ready", openIntervalMs }));
  return {
    openQueue, manageQueue, openWorker, manageWorker, sharedState,
    async shutdown() {
      await openWorker.close(); await manageWorker.close();
      await openQueue.close(); await manageQueue.close();
      await positionLedger.close();
    },
  };
}
