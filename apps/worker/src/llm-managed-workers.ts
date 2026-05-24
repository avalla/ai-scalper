/**
 * llm-managed Worker stack (Phase 1 PoC).
 *
 * Wires the open-decision processor + manage processor (both pure & in the
 * trader package) into BullMQ Workers, plus configures the recurring
 * open-tick job.
 *
 * Gated on `config.llmManagedUseBullmqJobs` — set false by default to keep
 * the existing in-process loop the source of truth.
 */

import { Queue, Worker } from "bullmq";
import type IORedisType from "ioredis";

import {
  JOB_NAMES,
  LLM_MANAGED_JOB_POLICY,
  QUEUE_NAMES,
  type LlmManagedManageJobData,
  type LlmManagedOpenTickJobData,
} from "@ai-scalper/queueing";

import { createBybitClient } from "@ai-scalper/bybit-client";
import type { TraderConfig } from "../../trader/src/config";
import { createWebhookAlerter } from "../../trader/src/alerts/webhook";
import {
  createLlmManagedSharedState,
  type LlmManagedSharedState,
} from "../../trader/src/strategies/llm-managed-redis";
import { processLlmManagedOpenTick } from "../../trader/src/strategies/llm-managed-open-processor";
import { processLlmManagedManageTick } from "../../trader/src/strategies/llm-managed-manage-processor";
import { createPositionLedger } from "../../trader/src/trading/position-ledger";

export interface LlmManagedWorkerStack {
  openDecisionQueue: Queue<LlmManagedOpenTickJobData>;
  manageQueue: Queue<LlmManagedManageJobData>;
  openWorker: Worker<LlmManagedOpenTickJobData>;
  manageWorker: Worker<LlmManagedManageJobData>;
  sharedState: LlmManagedSharedState;
  shutdown(): Promise<void>;
}

/**
 * Bootstraps the queues + workers and upserts the recurring open-tick.
 * Caller is responsible for shutting things down (use the returned helper).
 */
export async function startLlmManagedWorkerStack(deps: {
  connection: IORedisType;
  config: TraderConfig;
}): Promise<LlmManagedWorkerStack> {
  const { connection, config } = deps;

  const openDecisionQueue = new Queue<LlmManagedOpenTickJobData>(
    QUEUE_NAMES.llmManagedOpenDecision,
    { connection, defaultJobOptions: LLM_MANAGED_JOB_POLICY },
  );
  const manageQueue = new Queue<LlmManagedManageJobData>(
    QUEUE_NAMES.llmManagedTradeManagement,
    { connection, defaultJobOptions: LLM_MANAGED_JOB_POLICY },
  );

  const client = createBybitClient();
  const alerter = createWebhookAlerter(config.alertWebhookUrl);
  const positionLedger = createPositionLedger();
  const sharedState = createLlmManagedSharedState({
    redis: connection,
    manageQueue,
  });

  // No-op contexts for Phase 1 — the in-process collectors live in
  // run-trader and aren't easily reusable here. The worker uses a minimal
  // ctx (BTC ticker + funding) inline.
  const collectMarketContext = async (observedAt: string) => {
    try {
      const t = await client.getTicker({ category: "linear", symbol: "BTCUSDT" });
      const last = Number(t.lastPrice);
      const prev1h = Number(t.prevPrice1h);
      const fr = Number(t.fundingRate);
      return {
        observedAt,
        btcPrice: Number.isFinite(last) ? last : 0,
        btcTrendBps4h: 0,
        btcRealizedVol1h: Number.isFinite(prev1h) && prev1h > 0
          ? Math.abs((last - prev1h) / prev1h) * 100
          : 0,
        avgFundingRateBps: Number.isFinite(fr) ? fr * 10_000 : 0,
        spotPerpBasisBps: 0,
        topRankedSetups: [],
      };
    } catch {
      return {
        observedAt,
        btcPrice: 0, btcTrendBps4h: 0, btcRealizedVol1h: 0,
        avgFundingRateBps: 0, spotPerpBasisBps: 0, topRankedSetups: [],
      };
    }
  };
  const collectRecentPerformance = async () => ({ trades: 0, winRate: 0, netPnlUsd: 0 });
  const collectWallet = async () => {
    try {
      const raw = await client.getWalletBalance(config.walletAccountType) as Record<string, unknown>;
      const list = (raw?.result as { list?: Array<{ totalAvailableBalance?: string }> })?.list ?? [];
      const acct = list[0];
      const available = acct?.totalAvailableBalance ? Number(acct.totalAvailableBalance) : 0;
      return { availableUsd: Number.isFinite(available) ? available : 0 };
    } catch {
      return { availableUsd: 0 };
    }
  };

  // ── Open worker ────────────────────────────────────────────────────────
  const openWorker = new Worker<LlmManagedOpenTickJobData>(
    QUEUE_NAMES.llmManagedOpenDecision,
    async (job) => {
      if (job.name !== JOB_NAMES.llmManagedOpenTick) {
        throw new Error(`Unsupported job name: ${job.name}`);
      }
      return processLlmManagedOpenTick(job.data, {
        config, client, alerter,
        manageQueue,
        sharedState,
        collectMarketContext,
        collectRecentPerformance,
        collectWallet,
      });
    },
    { connection, concurrency: 1 },
  );

  // ── Manage worker ──────────────────────────────────────────────────────
  const manageWorker = new Worker<LlmManagedManageJobData>(
    QUEUE_NAMES.llmManagedTradeManagement,
    async (job) => {
      if (job.name !== JOB_NAMES.llmManagedManageTick) {
        throw new Error(`Unsupported job name: ${job.name}`);
      }
      const result = await processLlmManagedManageTick(job.data, {
        config, client, alerter,
        sharedState,
        positionLedger,
        collectMarketContext,
      });
      if (result.status === "continue" && result.updatedData) {
        try {
          await job.updateData(result.updatedData);
        } catch (err) {
          console.warn(JSON.stringify({
            event: "llm-managed-update-data-failed",
            error: err instanceof Error ? err.message : String(err),
          }));
        }
        return result;
      }
      // status === "complete": remove the repeat schedule so the job stops firing.
      const repeatKey = job.repeatJobKey;
      if (repeatKey) {
        try {
          await manageQueue.removeRepeatableByKey(repeatKey);
        } catch (err) {
          console.warn(JSON.stringify({
            event: "llm-managed-repeat-cleanup-failed",
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      }
      return result;
    },
    { connection, concurrency: 5 },
  );

  // ── Upsert the recurring open-tick job ─────────────────────────────────
  await openDecisionQueue.add(
    JOB_NAMES.llmManagedOpenTick,
    {
      triggeredAt: new Date().toISOString(),
      configFile: process.env.CONFIG_FILE ?? "config.json",
    },
    {
      ...LLM_MANAGED_JOB_POLICY,
      jobId: "llm-managed-open-tick-recurring",
      repeat: { every: config.llmManagedOpenReviewIntervalSec * 1000 },
    },
  );

  console.log(JSON.stringify({
    event: "llm-managed-bullmq-stack-ready",
    openIntervalSec: config.llmManagedOpenReviewIntervalSec,
    manageIntervalSec: config.llmManagedManageReviewIntervalSec,
  }));

  return {
    openDecisionQueue,
    manageQueue,
    openWorker,
    manageWorker,
    sharedState,
    async shutdown() {
      await openWorker.close();
      await manageWorker.close();
      await openDecisionQueue.close();
      await manageQueue.close();
      await positionLedger.close();
    },
  };
}
