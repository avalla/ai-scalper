import { Queue, Worker } from "bullmq";
import type IORedisType from "ioredis";

import {
  JOB_NAMES, QUEUE_NAMES, STRATEGY_JOB_POLICY,
  type BollingerAdxManageJobData, type BollingerAdxOpenTickJobData,
} from "@ai-scalper/queueing";

import { createBybitClient } from "@ai-scalper/bybit-client";
import type { TraderConfig } from "../../trader/src/config";
import { createWebhookAlerter } from "../../trader/src/alerts/webhook";
import { createStrategySharedState, type StrategySharedState } from "../../trader/src/strategies/shared/bullmq-shared-state";
import {
  createInMemoryBollingerAdxKlineCacheStore,
  processBollingerAdxOpenTick,
} from "../../trader/src/strategies/bollinger-adx-open-processor";
import { processBollingerAdxManageTick } from "../../trader/src/strategies/bollinger-adx-manage-processor";
import { createPositionLedger } from "../../trader/src/trading/position-ledger";
import { makeOpenTickJobId, safeRemoveRepeatable } from "../../trader/src/strategies/shared/trade-job-helpers";

export interface BollingerAdxWorkerStack {
  openQueue: Queue<BollingerAdxOpenTickJobData>;
  manageQueue: Queue<BollingerAdxManageJobData>;
  openWorker: Worker<BollingerAdxOpenTickJobData>;
  manageWorker: Worker<BollingerAdxManageJobData>;
  sharedState: StrategySharedState;
  shutdown(): Promise<void>;
}

export async function startBollingerAdxWorkerStack(deps: {
  connection: IORedisType;
  config: TraderConfig;
}): Promise<BollingerAdxWorkerStack> {
  const { connection, config } = deps;
  const openQueue = new Queue<BollingerAdxOpenTickJobData>(
    QUEUE_NAMES.bollingerAdxOpenDecision, { connection, defaultJobOptions: STRATEGY_JOB_POLICY },
  );
  const manageQueue = new Queue<BollingerAdxManageJobData>(
    QUEUE_NAMES.bollingerAdxTradeManagement, { connection, defaultJobOptions: STRATEGY_JOB_POLICY },
  );
  const client = createBybitClient();
  const alerter = createWebhookAlerter(config.alertWebhookUrl);
  const positionLedger = createPositionLedger();
  const sharedState = createStrategySharedState({ strategy: "bollinger-adx", redis: connection, manageQueue });
  const klineCacheStore = createInMemoryBollingerAdxKlineCacheStore();

  const openWorker = new Worker<BollingerAdxOpenTickJobData>(
    QUEUE_NAMES.bollingerAdxOpenDecision,
    async (job) => {
      if (job.name !== JOB_NAMES.bollingerAdxOpenTick) throw new Error(`Unsupported job name: ${job.name}`);
      return processBollingerAdxOpenTick(job.data, {
        config, client, alerter, manageQueue, sharedState, klineCacheStore,
      });
    },
    { connection, concurrency: 1 },
  );

  const manageWorker = new Worker<BollingerAdxManageJobData>(
    QUEUE_NAMES.bollingerAdxTradeManagement,
    async (job) => {
      if (job.name !== JOB_NAMES.bollingerAdxManageTick) throw new Error(`Unsupported job name: ${job.name}`);
      const result = await processBollingerAdxManageTick(job.data, {
        config, client, alerter, sharedState, positionLedger,
      });
      if (result.status === "continue") {
        try { await job.updateData(result.updatedData); } catch (err) {
          console.warn(JSON.stringify({ event: "bollinger-adx-update-data-failed", error: err instanceof Error ? err.message : String(err) }));
        }
        return result;
      }
      await safeRemoveRepeatable({ queue: manageQueue, repeatKey: job.repeatJobKey, event: "bollinger-adx-repeat-cleanup-failed" });
      return result;
    },
    { connection, concurrency: 5 },
  );

  const openIntervalMs = Math.max(5_000, config.pollMs);
  await openQueue.add(
    JOB_NAMES.bollingerAdxOpenTick,
    { triggeredAt: new Date().toISOString(), configFile: process.env.CONFIG_FILE ?? "config.bollinger-adx.json" },
    { ...STRATEGY_JOB_POLICY, jobId: makeOpenTickJobId("bollinger-adx"), repeat: { every: openIntervalMs } },
  );

  console.log(JSON.stringify({ event: "bollinger-adx-bullmq-stack-ready", openIntervalMs }));

  return {
    openQueue, manageQueue, openWorker, manageWorker, sharedState,
    async shutdown() {
      await openWorker.close(); await manageWorker.close();
      await openQueue.close(); await manageQueue.close();
      await positionLedger.close();
    },
  };
}
