import { Queue, Worker } from "bullmq";
import type IORedisType from "ioredis";

import {
  JOB_NAMES,
  QUEUE_NAMES,
  STRATEGY_JOB_POLICY,
  type LongerTfManageJobData,
  type LongerTfOpenTickJobData,
} from "@ai-scalper/queueing";

import { createBybitClient } from "@ai-scalper/bybit-client";
import { createRestTickerSource, createCachedTickerSource } from "@ai-scalper/bybit-client/ticker-source";
import { createRedisTickerCache } from "@ai-scalper/bybit-client/ws-redis-cache";
import type { TraderConfig } from "../../trader/src/config";
import { createWebhookAlerter } from "../../trader/src/alerts/webhook";
import { createStrategySharedState, type StrategySharedState } from "../../trader/src/strategies/shared/bullmq-shared-state";
import {
  createInMemoryKlineCacheStore,
  processLongerTfOpenTick,
} from "../../trader/src/strategies/longer-tf-open-processor";
import { processLongerTfManageTick } from "../../trader/src/strategies/longer-tf-manage-processor";
import { createPositionLedger } from "../../trader/src/trading/position-ledger";
import { makeOpenTickJobId, safeRemoveRepeatable } from "../../trader/src/strategies/shared/trade-job-helpers";

export interface LongerTfWorkerStack {
  openQueue: Queue<LongerTfOpenTickJobData>;
  manageQueue: Queue<LongerTfManageJobData>;
  openWorker: Worker<LongerTfOpenTickJobData>;
  manageWorker: Worker<LongerTfManageJobData>;
  sharedState: StrategySharedState;
  shutdown(): Promise<void>;
}

export async function startLongerTfWorkerStack(deps: {
  connection: IORedisType;
  config: TraderConfig;
}): Promise<LongerTfWorkerStack> {
  const { connection, config } = deps;
  const openQueue = new Queue<LongerTfOpenTickJobData>(
    QUEUE_NAMES.longerTfOpenDecision, { connection, defaultJobOptions: STRATEGY_JOB_POLICY },
  );
  const manageQueue = new Queue<LongerTfManageJobData>(
    QUEUE_NAMES.longerTfTradeManagement, { connection, defaultJobOptions: STRATEGY_JOB_POLICY },
  );
  const client = createBybitClient();
  const tickerSource = config.useWebSocket
    ? createCachedTickerSource({
        cache: createRedisTickerCache(connection),
        fallback: client,
        defaultMaxAgeMs: 5_000,
      })
    : createRestTickerSource(client);
  const alerter = createWebhookAlerter(config.alertWebhookUrl);
  const positionLedger = createPositionLedger();
  const sharedState = createStrategySharedState({ strategy: "longer-tf", redis: connection, manageQueue });
  const klineCacheStore = createInMemoryKlineCacheStore();

  const openWorker = new Worker<LongerTfOpenTickJobData>(
    QUEUE_NAMES.longerTfOpenDecision,
    async (job) => {
      if (job.name !== JOB_NAMES.longerTfOpenTick) throw new Error(`Unsupported job name: ${job.name}`);
      return processLongerTfOpenTick(job.data, {
        config, client, tickerSource, alerter, manageQueue, sharedState, klineCacheStore,
      });
    },
    { connection, concurrency: 1 },
  );

  const manageWorker = new Worker<LongerTfManageJobData>(
    QUEUE_NAMES.longerTfTradeManagement,
    async (job) => {
      if (job.name !== JOB_NAMES.longerTfManageTick) throw new Error(`Unsupported job name: ${job.name}`);
      const result = await processLongerTfManageTick(job.data, {
        config, client, tickerSource, alerter, sharedState, positionLedger,
      });
      if (result.status === "continue") {
        try { await job.updateData(result.updatedData); } catch (err) {
          console.warn(JSON.stringify({ event: "longer-tf-update-data-failed", error: err instanceof Error ? err.message : String(err) }));
        }
        return result;
      }
      await safeRemoveRepeatable({ queue: manageQueue, repeatKey: job.repeatJobKey, event: "longer-tf-repeat-cleanup-failed" });
      return result;
    },
    { connection, concurrency: 5 },
  );

  const openIntervalMs = Math.max(5_000, config.pollMs);
  await openQueue.add(
    JOB_NAMES.longerTfOpenTick,
    { triggeredAt: new Date().toISOString(), configFile: process.env.CONFIG_FILE ?? "config.longer-tf.json" },
    { ...STRATEGY_JOB_POLICY, jobId: makeOpenTickJobId("longer-tf"), repeat: { every: openIntervalMs } },
  );

  console.log(JSON.stringify({ event: "longer-tf-bullmq-stack-ready", openIntervalMs }));

  return {
    openQueue, manageQueue, openWorker, manageWorker, sharedState,
    async shutdown() {
      await openWorker.close();
      await manageWorker.close();
      await openQueue.close();
      await manageQueue.close();
      await positionLedger.close();
    },
  };
}
