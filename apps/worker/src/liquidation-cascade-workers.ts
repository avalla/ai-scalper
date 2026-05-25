/**
 * liquidation-cascade Worker stack (Phase 2 BullMQ migration).
 * Mirrors `funding-arb-workers.ts`. Gated by:
 *   `config.strategyType === "liquidation-cascade" && config.useBullmqJobs`.
 *
 * Requires `config.useWebSocket=true` because the open processor reads
 * the Redis-backed liquidations cache populated by the ws-feeder.
 */

import { Queue, Worker } from "bullmq";
import type IORedisType from "ioredis";

import {
  JOB_NAMES,
  QUEUE_NAMES,
  STRATEGY_JOB_POLICY,
  type LiquidationCascadeManageJobData,
  type LiquidationCascadeOpenTickJobData,
} from "@ai-scalper/queueing";

import { createBybitClient } from "@ai-scalper/bybit-client";
import {
  createCachedTickerSource,
  createRestTickerSource,
} from "@ai-scalper/bybit-client/ticker-source";
import { createRedisTickerCache } from "@ai-scalper/bybit-client/ws-redis-cache";
import type { TraderConfig } from "../../trader/src/config";
import { createWebhookAlerter } from "../../trader/src/alerts/webhook";
import {
  createStrategySharedState,
  type StrategySharedState,
} from "../../trader/src/strategies/shared/bullmq-shared-state";
import { processLiquidationCascadeOpenTick } from "../../trader/src/strategies/liquidation-cascade-open-processor";
import { processLiquidationCascadeManageTick } from "../../trader/src/strategies/liquidation-cascade-manage-processor";
import { createPositionLedger } from "../../trader/src/trading/position-ledger";
import { createRedisLiquidationsReader } from "../../trader/src/strategies/liquidations-cache-reader";
import {
  safeRemoveRepeatable,
  makeOpenTickJobId,
} from "../../trader/src/strategies/shared/trade-job-helpers";

export interface LiquidationCascadeWorkerStack {
  openQueue: Queue<LiquidationCascadeOpenTickJobData>;
  manageQueue: Queue<LiquidationCascadeManageJobData>;
  openWorker: Worker<LiquidationCascadeOpenTickJobData>;
  manageWorker: Worker<LiquidationCascadeManageJobData>;
  sharedState: StrategySharedState;
  shutdown(): Promise<void>;
}

export async function startLiquidationCascadeWorkerStack(deps: {
  connection: IORedisType;
  config: TraderConfig;
}): Promise<LiquidationCascadeWorkerStack> {
  const { connection, config } = deps;

  const openQueue = new Queue<LiquidationCascadeOpenTickJobData>(
    QUEUE_NAMES.liquidationCascadeOpenDecision,
    { connection, defaultJobOptions: STRATEGY_JOB_POLICY },
  );
  const manageQueue = new Queue<LiquidationCascadeManageJobData>(
    QUEUE_NAMES.liquidationCascadeTradeManagement,
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
  const liquidationsReader = createRedisLiquidationsReader(connection);
  const sharedState = createStrategySharedState({
    strategy: "liquidation-cascade",
    redis: connection,
    manageQueue,
  });

  const openWorker = new Worker<LiquidationCascadeOpenTickJobData>(
    QUEUE_NAMES.liquidationCascadeOpenDecision,
    async (job) => {
      if (job.name !== JOB_NAMES.liquidationCascadeOpenTick) {
        throw new Error(`Unsupported job name: ${job.name}`);
      }
      return processLiquidationCascadeOpenTick(job.data, {
        config,
        client,
        tickerSource,
        alerter,
        liquidationsReader,
        manageQueue,
        sharedState,
      });
    },
    { connection, concurrency: 1 },
  );

  const manageWorker = new Worker<LiquidationCascadeManageJobData>(
    QUEUE_NAMES.liquidationCascadeTradeManagement,
    async (job) => {
      if (job.name !== JOB_NAMES.liquidationCascadeManageTick) {
        throw new Error(`Unsupported job name: ${job.name}`);
      }
      const result = await processLiquidationCascadeManageTick(job.data, {
        config,
        client,
        tickerSource,
        alerter,
        sharedState,
        positionLedger,
      });
      if (result.status === "continue") {
        try {
          await job.updateData(result.updatedData);
        } catch (err) {
          console.warn(JSON.stringify({
            event: "liquidation-cascade-update-data-failed",
            error: err instanceof Error ? err.message : String(err),
          }));
        }
        return result;
      }
      await safeRemoveRepeatable({
        queue: manageQueue,
        repeatKey: job.repeatJobKey,
        event: "liquidation-cascade-repeat-cleanup-failed",
      });
      return result;
    },
    { connection, concurrency: 5 },
  );

  // Upsert recurring open-tick.
  const openIntervalMs = Math.max(
    config.liquidationCheckIntervalMs,
    config.pollMs,
    5_000,
  );
  await openQueue.add(
    JOB_NAMES.liquidationCascadeOpenTick,
    {
      triggeredAt: new Date().toISOString(),
      configFile: process.env.CONFIG_FILE ?? "config.liquidation-cascade.json",
    },
    {
      ...STRATEGY_JOB_POLICY,
      jobId: makeOpenTickJobId("liquidation-cascade"),
      repeat: { every: openIntervalMs },
    },
  );

  console.log(JSON.stringify({
    event: "liquidation-cascade-bullmq-stack-ready",
    openIntervalMs,
  }));

  return {
    openQueue,
    manageQueue,
    openWorker,
    manageWorker,
    sharedState,
    async shutdown() {
      await openWorker.close();
      await manageWorker.close();
      await openQueue.close();
      await manageQueue.close();
      await positionLedger.close();
    },
  };
}
