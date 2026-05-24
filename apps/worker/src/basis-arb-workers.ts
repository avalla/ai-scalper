import { Queue, Worker } from "bullmq";
import type IORedisType from "ioredis";

import {
  JOB_NAMES, QUEUE_NAMES, STRATEGY_JOB_POLICY,
  type BasisArbManageJobData, type BasisArbOpenTickJobData,
} from "@ai-scalper/queueing";

import { createBybitClient } from "@ai-scalper/bybit-client";
import { createRestTickerSource, createCachedTickerSource } from "@ai-scalper/bybit-client/ticker-source";
import { createRedisTickerCache } from "@ai-scalper/bybit-client/ws-redis-cache";
import type { TraderConfig } from "../../trader/src/config";
import { createWebhookAlerter } from "../../trader/src/alerts/webhook";
import { createStrategySharedState, type StrategySharedState } from "../../trader/src/strategies/shared/bullmq-shared-state";
import { processBasisArbOpenTick } from "../../trader/src/strategies/basis-arb-open-processor";
import { processBasisArbManageTick } from "../../trader/src/strategies/basis-arb-manage-processor";
import { createPositionLedger } from "../../trader/src/trading/position-ledger";
import { makeOpenTickJobId, safeRemoveRepeatable } from "../../trader/src/strategies/shared/trade-job-helpers";

export interface BasisArbWorkerStack {
  openQueue: Queue<BasisArbOpenTickJobData>;
  manageQueue: Queue<BasisArbManageJobData>;
  openWorker: Worker<BasisArbOpenTickJobData>;
  manageWorker: Worker<BasisArbManageJobData>;
  sharedState: StrategySharedState;
  shutdown(): Promise<void>;
}

export async function startBasisArbWorkerStack(deps: {
  connection: IORedisType;
  config: TraderConfig;
}): Promise<BasisArbWorkerStack> {
  const { connection, config } = deps;
  const openQueue = new Queue<BasisArbOpenTickJobData>(
    QUEUE_NAMES.basisArbOpenDecision, { connection, defaultJobOptions: STRATEGY_JOB_POLICY },
  );
  const manageQueue = new Queue<BasisArbManageJobData>(
    QUEUE_NAMES.basisArbTradeManagement, { connection, defaultJobOptions: STRATEGY_JOB_POLICY },
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
  const sharedState = createStrategySharedState({ strategy: "basis-arb", redis: connection, manageQueue });

  const openWorker = new Worker<BasisArbOpenTickJobData>(
    QUEUE_NAMES.basisArbOpenDecision,
    async (job) => {
      if (job.name !== JOB_NAMES.basisArbOpenTick) throw new Error(`Unsupported job name: ${job.name}`);
      return processBasisArbOpenTick(job.data, { config, client, tickerSource, alerter, manageQueue, sharedState });
    },
    { connection, concurrency: 1 },
  );

  const manageWorker = new Worker<BasisArbManageJobData>(
    QUEUE_NAMES.basisArbTradeManagement,
    async (job) => {
      if (job.name !== JOB_NAMES.basisArbManageTick) throw new Error(`Unsupported job name: ${job.name}`);
      const result = await processBasisArbManageTick(job.data, { config, client, tickerSource, alerter, sharedState, positionLedger });
      if (result.status === "continue") {
        try { await job.updateData(result.updatedData); } catch (err) {
          console.warn(JSON.stringify({ event: "basis-arb-update-data-failed", error: err instanceof Error ? err.message : String(err) }));
        }
        return result;
      }
      await safeRemoveRepeatable({ queue: manageQueue, repeatKey: job.repeatJobKey, event: "basis-arb-repeat-cleanup-failed" });
      return result;
    },
    { connection, concurrency: 5 },
  );

  const openIntervalMs = Math.max(5_000, config.pollMs);
  await openQueue.add(
    JOB_NAMES.basisArbOpenTick,
    { triggeredAt: new Date().toISOString(), configFile: process.env.CONFIG_FILE ?? "config.basis-arb.json" },
    { ...STRATEGY_JOB_POLICY, jobId: makeOpenTickJobId("basis-arb"), repeat: { every: openIntervalMs } },
  );

  console.log(JSON.stringify({ event: "basis-arb-bullmq-stack-ready", openIntervalMs }));
  return {
    openQueue, manageQueue, openWorker, manageWorker, sharedState,
    async shutdown() {
      await openWorker.close(); await manageWorker.close();
      await openQueue.close(); await manageQueue.close();
      await positionLedger.close();
    },
  };
}
