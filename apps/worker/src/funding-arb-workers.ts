/**
 * funding-arb Worker stack (Phase 2 BullMQ migration).
 * Mirrors `llm-managed-workers.ts`. Gated by `config.fundingArbUseBullmqJobs`.
 */

import { Queue, Worker } from "bullmq";
import type IORedisType from "ioredis";

import {
  JOB_NAMES,
  QUEUE_NAMES,
  STRATEGY_JOB_POLICY,
  type FundingArbManageJobData,
  type FundingArbOpenTickJobData,
} from "@ai-scalper/queueing";

import { createBybitClient } from "@ai-scalper/bybit-client";
import { createRestTickerSource, createCachedTickerSource } from "@ai-scalper/bybit-client/ticker-source";
import { createRedisTickerCache } from "@ai-scalper/bybit-client/ws-redis-cache";
import type { TraderConfig } from "../../trader/src/config";
import { createWebhookAlerter } from "../../trader/src/alerts/webhook";
import { createStrategySharedState, type StrategySharedState } from "../../trader/src/strategies/shared/bullmq-shared-state";
import { processFundingArbOpenTick } from "../../trader/src/strategies/funding-arb-open-processor";
import { processFundingArbManageTick } from "../../trader/src/strategies/funding-arb-manage-processor";
import { createPositionLedger } from "../../trader/src/trading/position-ledger";
import { safeRemoveRepeatable, makeOpenTickJobId } from "../../trader/src/strategies/shared/trade-job-helpers";

export interface FundingArbWorkerStack {
  openQueue: Queue<FundingArbOpenTickJobData>;
  manageQueue: Queue<FundingArbManageJobData>;
  openWorker: Worker<FundingArbOpenTickJobData>;
  manageWorker: Worker<FundingArbManageJobData>;
  sharedState: StrategySharedState;
  shutdown(): Promise<void>;
}

export async function startFundingArbWorkerStack(deps: {
  connection: IORedisType;
  config: TraderConfig;
}): Promise<FundingArbWorkerStack> {
  const { connection, config } = deps;

  const openQueue = new Queue<FundingArbOpenTickJobData>(
    QUEUE_NAMES.fundingArbOpenDecision,
    { connection, defaultJobOptions: STRATEGY_JOB_POLICY },
  );
  const manageQueue = new Queue<FundingArbManageJobData>(
    QUEUE_NAMES.fundingArbTradeManagement,
    { connection, defaultJobOptions: STRATEGY_JOB_POLICY },
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
  const sharedState = createStrategySharedState({
    strategy: "funding-arb",
    redis: connection,
    manageQueue,
  });

  const openWorker = new Worker<FundingArbOpenTickJobData>(
    QUEUE_NAMES.fundingArbOpenDecision,
    async (job) => {
      if (job.name !== JOB_NAMES.fundingArbOpenTick) {
        throw new Error(`Unsupported job name: ${job.name}`);
      }
      return processFundingArbOpenTick(job.data, {
        config, client, tickerSource, alerter, manageQueue, sharedState,
      });
    },
    { connection, concurrency: 1 },
  );

  const manageWorker = new Worker<FundingArbManageJobData>(
    QUEUE_NAMES.fundingArbTradeManagement,
    async (job) => {
      if (job.name !== JOB_NAMES.fundingArbManageTick) {
        throw new Error(`Unsupported job name: ${job.name}`);
      }
      const result = await processFundingArbManageTick(job.data, {
        config, client, tickerSource, alerter, sharedState, positionLedger,
      });
      if (result.status === "continue") {
        try { await job.updateData(result.updatedData); }
        catch (err) {
          console.warn(JSON.stringify({
            event: "funding-arb-update-data-failed",
            error: err instanceof Error ? err.message : String(err),
          }));
        }
        return result;
      }
      await safeRemoveRepeatable({
        queue: manageQueue,
        repeatKey: job.repeatJobKey,
        event: "funding-arb-repeat-cleanup-failed",
      });
      return result;
    },
    { connection, concurrency: 5 },
  );

  // Upsert recurring open-tick.
  const openIntervalMs = Math.max(5_000, config.pollMs);
  await openQueue.add(
    JOB_NAMES.fundingArbOpenTick,
    { triggeredAt: new Date().toISOString(), configFile: process.env.CONFIG_FILE ?? "config.funding-arb.json" },
    {
      ...STRATEGY_JOB_POLICY,
      jobId: makeOpenTickJobId("funding-arb"),
      repeat: { every: openIntervalMs },
    },
  );

  console.log(JSON.stringify({
    event: "funding-arb-bullmq-stack-ready",
    openIntervalMs,
  }));

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
