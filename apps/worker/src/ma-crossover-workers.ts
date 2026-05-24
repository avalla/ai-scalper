import { Queue, Worker } from "bullmq";
import type IORedisType from "ioredis";

import {
  JOB_NAMES, QUEUE_NAMES, STRATEGY_JOB_POLICY,
  type MaCrossoverManageJobData, type MaCrossoverOpenTickJobData,
} from "@ai-scalper/queueing";

import { createBybitClient } from "@ai-scalper/bybit-client";
import { createRestTickerSource, createCachedTickerSource } from "@ai-scalper/bybit-client/ticker-source";
import { createRedisTickerCache } from "@ai-scalper/bybit-client/ws-redis-cache";
import type { TraderConfig } from "../../trader/src/config";
import { createWebhookAlerter } from "../../trader/src/alerts/webhook";
import { createStrategySharedState, type StrategySharedState } from "../../trader/src/strategies/shared/bullmq-shared-state";
import {
  createInMemoryPriceHistoryStore,
  processMaCrossoverOpenTick,
} from "../../trader/src/strategies/ma-crossover-open-processor";
import { processMaCrossoverManageTick } from "../../trader/src/strategies/ma-crossover-manage-processor";
import { createPositionLedger } from "../../trader/src/trading/position-ledger";
import { createAllocatorRedisStore } from "../../trader/src/strategies/shared/allocator-redis";
import { makeOpenTickJobId, safeRemoveRepeatable } from "../../trader/src/strategies/shared/trade-job-helpers";

export interface MaCrossoverWorkerStack {
  openQueue: Queue<MaCrossoverOpenTickJobData>;
  manageQueue: Queue<MaCrossoverManageJobData>;
  openWorker: Worker<MaCrossoverOpenTickJobData>;
  manageWorker: Worker<MaCrossoverManageJobData>;
  sharedState: StrategySharedState;
  shutdown(): Promise<void>;
}

export async function startMaCrossoverWorkerStack(deps: {
  connection: IORedisType;
  config: TraderConfig;
}): Promise<MaCrossoverWorkerStack> {
  const { connection, config } = deps;
  const openQueue = new Queue<MaCrossoverOpenTickJobData>(
    QUEUE_NAMES.maCrossoverOpenDecision, { connection, defaultJobOptions: STRATEGY_JOB_POLICY },
  );
  const manageQueue = new Queue<MaCrossoverManageJobData>(
    QUEUE_NAMES.maCrossoverTradeManagement, { connection, defaultJobOptions: STRATEGY_JOB_POLICY },
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
  const sharedState = createStrategySharedState({ strategy: "ma-crossover", redis: connection, manageQueue });
  const allocatorStore = createAllocatorRedisStore(connection);
  const priceHistoryStore = createInMemoryPriceHistoryStore();

  const openWorker = new Worker<MaCrossoverOpenTickJobData>(
    QUEUE_NAMES.maCrossoverOpenDecision,
    async (job) => {
      if (job.name !== JOB_NAMES.maCrossoverOpenTick) throw new Error(`Unsupported job name: ${job.name}`);
      return processMaCrossoverOpenTick(job.data, {
        config, client, tickerSource, alerter, manageQueue, sharedState,
        allocatorStore, priceHistoryStore,
      });
    },
    { connection, concurrency: 1 },
  );

  const manageWorker = new Worker<MaCrossoverManageJobData>(
    QUEUE_NAMES.maCrossoverTradeManagement,
    async (job) => {
      if (job.name !== JOB_NAMES.maCrossoverManageTick) throw new Error(`Unsupported job name: ${job.name}`);
      const result = await processMaCrossoverManageTick(job.data, {
        config, client, tickerSource, alerter, sharedState, positionLedger, allocatorStore,
      });
      if (result.status === "continue") {
        try { await job.updateData(result.updatedData); } catch (err) {
          console.warn(JSON.stringify({ event: "ma-crossover-update-data-failed", error: err instanceof Error ? err.message : String(err) }));
        }
        return result;
      }
      await safeRemoveRepeatable({ queue: manageQueue, repeatKey: job.repeatJobKey, event: "ma-crossover-repeat-cleanup-failed" });
      return result;
    },
    { connection, concurrency: 5 },
  );

  const openIntervalMs = Math.max(5_000, config.pollMs);
  await openQueue.add(
    JOB_NAMES.maCrossoverOpenTick,
    { triggeredAt: new Date().toISOString(), configFile: process.env.CONFIG_FILE ?? "config.json" },
    { ...STRATEGY_JOB_POLICY, jobId: makeOpenTickJobId("ma-crossover"), repeat: { every: openIntervalMs } },
  );

  console.log(JSON.stringify({ event: "ma-crossover-bullmq-stack-ready", openIntervalMs }));

  return {
    openQueue, manageQueue, openWorker, manageWorker, sharedState,
    async shutdown() {
      await openWorker.close(); await manageWorker.close();
      await openQueue.close(); await manageQueue.close();
      await positionLedger.close();
    },
  };
}
