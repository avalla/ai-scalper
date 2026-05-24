import { Queue, Worker } from "bullmq";
import type IORedisType from "ioredis";

import {
  JOB_NAMES, QUEUE_NAMES, STRATEGY_JOB_POLICY,
  type CalendarSpreadManageJobData, type CalendarSpreadOpenTickJobData,
} from "@ai-scalper/queueing";

import { createBybitClient } from "@ai-scalper/bybit-client";
import { createRestTickerSource, createCachedTickerSource } from "@ai-scalper/bybit-client/ticker-source";
import { createRedisTickerCache } from "@ai-scalper/bybit-client/ws-redis-cache";
import type { TraderConfig } from "../../trader/src/config";
import { createWebhookAlerter } from "../../trader/src/alerts/webhook";
import { createStrategySharedState, type StrategySharedState } from "../../trader/src/strategies/shared/bullmq-shared-state";
import { processCalendarSpreadOpenTick } from "../../trader/src/strategies/calendar-spread-open-processor";
import { processCalendarSpreadManageTick } from "../../trader/src/strategies/calendar-spread-manage-processor";
import { createPositionLedger } from "../../trader/src/trading/position-ledger";
import { makeOpenTickJobId, safeRemoveRepeatable } from "../../trader/src/strategies/shared/trade-job-helpers";

export interface CalendarSpreadWorkerStack {
  openQueue: Queue<CalendarSpreadOpenTickJobData>;
  manageQueue: Queue<CalendarSpreadManageJobData>;
  openWorker: Worker<CalendarSpreadOpenTickJobData>;
  manageWorker: Worker<CalendarSpreadManageJobData>;
  sharedState: StrategySharedState;
  shutdown(): Promise<void>;
}

export async function startCalendarSpreadWorkerStack(deps: {
  connection: IORedisType;
  config: TraderConfig;
}): Promise<CalendarSpreadWorkerStack> {
  const { connection, config } = deps;
  const openQueue = new Queue<CalendarSpreadOpenTickJobData>(
    QUEUE_NAMES.calendarSpreadOpenDecision, { connection, defaultJobOptions: STRATEGY_JOB_POLICY },
  );
  const manageQueue = new Queue<CalendarSpreadManageJobData>(
    QUEUE_NAMES.calendarSpreadTradeManagement, { connection, defaultJobOptions: STRATEGY_JOB_POLICY },
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
  const sharedState = createStrategySharedState({ strategy: "calendar-spread", redis: connection, manageQueue });

  const openWorker = new Worker<CalendarSpreadOpenTickJobData>(
    QUEUE_NAMES.calendarSpreadOpenDecision,
    async (job) => {
      if (job.name !== JOB_NAMES.calendarSpreadOpenTick) throw new Error(`Unsupported job name: ${job.name}`);
      return processCalendarSpreadOpenTick(job.data, { config, client, tickerSource, alerter, manageQueue, sharedState });
    },
    { connection, concurrency: 1 },
  );

  const manageWorker = new Worker<CalendarSpreadManageJobData>(
    QUEUE_NAMES.calendarSpreadTradeManagement,
    async (job) => {
      if (job.name !== JOB_NAMES.calendarSpreadManageTick) throw new Error(`Unsupported job name: ${job.name}`);
      const result = await processCalendarSpreadManageTick(job.data, { config, client, tickerSource, alerter, sharedState, positionLedger });
      if (result.status === "continue") {
        try { await job.updateData(result.updatedData); } catch (err) {
          console.warn(JSON.stringify({ event: "calendar-spread-update-data-failed", error: err instanceof Error ? err.message : String(err) }));
        }
        return result;
      }
      await safeRemoveRepeatable({ queue: manageQueue, repeatKey: job.repeatJobKey, event: "calendar-spread-repeat-cleanup-failed" });
      return result;
    },
    { connection, concurrency: 5 },
  );

  const openIntervalMs = Math.max(5_000, config.calendarPollSec * 1000);
  await openQueue.add(
    JOB_NAMES.calendarSpreadOpenTick,
    { triggeredAt: new Date().toISOString(), configFile: process.env.CONFIG_FILE ?? "config.calendar-spread.json" },
    { ...STRATEGY_JOB_POLICY, jobId: makeOpenTickJobId("calendar-spread"), repeat: { every: openIntervalMs } },
  );

  console.log(JSON.stringify({ event: "calendar-spread-bullmq-stack-ready", openIntervalMs }));

  return {
    openQueue, manageQueue, openWorker, manageWorker, sharedState,
    async shutdown() {
      await openWorker.close(); await manageWorker.close();
      await openQueue.close(); await manageQueue.close();
      await positionLedger.close();
    },
  };
}
