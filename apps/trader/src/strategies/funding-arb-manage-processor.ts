/**
 * funding-arb MANAGE processor (Phase 2 BullMQ migration).
 *
 * Per-tick flow:
 *   1. Reconcile against Bybit (live only) — if position vanished, append
 *      external-close ledger entry and complete the job.
 *   2. Fetch ticker for current price.
 *   3. Call `fundingArbDecide` with hasOpenPosition=true. If it returns:
 *        - exit → close position reduce-only, append ledger entry,
 *                 setLastTradeAt, COMPLETE JOB.
 *        - hold → update lastReviewAt, append history (compact), CONTINUE.
 */

import type { createBybitClient } from "@ai-scalper/bybit-client";
import type { TickerSource } from "@ai-scalper/bybit-client/ticker-source";
import type { PositionSource } from "@ai-scalper/bybit-client/position-source";
import type { FundingArbManageJobData } from "@ai-scalper/queueing";
import type { TraderConfig } from "../config";
import type { WebhookAlerter } from "../alerts/webhook";
import { fundingArbDecide } from "./funding-arb";
import type { StrategySharedState } from "./shared/bullmq-shared-state";
import { appendDecisionHistory } from "./shared/trade-job-helpers";
import type { ClosedPositionLedgerEntry } from "../trading/position-ledger";

type BybitClient = ReturnType<typeof createBybitClient>;

export interface FundingArbManageProcessorLedger {
  appendClosedPosition(entry: ClosedPositionLedgerEntry): Promise<void>;
}

export interface FundingArbManageProcessorDeps {
  config: TraderConfig;
  client: BybitClient;
  tickerSource: TickerSource;
  /**
   * Optional source for the position-reconcile step. When provided, used
   * instead of `client.getPosition` directly; this allows substituting a
   * WS-private-cached source with REST fallback. Falls back to a REST
   * passthrough on the existing client when omitted.
   */
  positionSource?: PositionSource;
  alerter: WebhookAlerter;
  sharedState: StrategySharedState;
  positionLedger: FundingArbManageProcessorLedger;
  decideFn?: typeof fundingArbDecide;
  log?: (payload: Record<string, unknown>) => void;
  now?: () => number;
}

export type FundingArbManageTickResult =
  | { status: "complete"; reason: string; updatedData?: FundingArbManageJobData }
  | { status: "continue"; updatedData: FundingArbManageJobData };

export async function processFundingArbManageTick(
  jobData: FundingArbManageJobData,
  deps: FundingArbManageProcessorDeps,
): Promise<FundingArbManageTickResult> {
  const { config, client, tickerSource, alerter, sharedState, positionLedger } = deps;
  const decideFn = deps.decideFn ?? fundingArbDecide;
  const log = deps.log ?? ((p) => console.log(JSON.stringify(p)));
  const now = (deps.now ?? Date.now)();
  const observedAt = new Date(now).toISOString();

  // (1) Reconcile against Bybit (live only). Uses the injected positionSource
  // (WS-private cache + REST fallback) when provided; otherwise falls back to
  // the REST client directly, preserving the original behaviour.
  if (!config.paperTrading) {
    try {
      const live = deps.positionSource
        ? await deps.positionSource.getPosition(jobData.symbol, { category: "linear" })
        : await client.getPosition({ category: "linear", symbol: jobData.symbol });
      const liveSize = live ? Number(live.size) : 0;
      if (jobData.qty > 0 && (!live || !Number.isFinite(liveSize) || liveSize < jobData.qty * 0.01)) {
        log({
          ts: observedAt, event: "funding-arb-external-close",
          positionId: jobData.positionId, symbol: jobData.symbol,
          recordedQty: jobData.qty, liveSize,
        });
        await positionLedger.appendClosedPosition(buildLedgerEntry({
          jobData, currentPrice: jobData.entryPrice, closeQty: jobData.qty,
          netPnl: 0, grossPnl: 0, feeUsd: 0,
          reasoning: "external-close-detected",
          cumulativeRealizedPnlUsd: 0,
        }));
        await alerter.send(`funding-arb: external close detected for ${jobData.symbol}`).catch(() => {});
        return { status: "complete", reason: "external-close" };
      }
    } catch (err) {
      log({
        ts: observedAt, event: "funding-arb-reconcile-failed",
        positionId: jobData.positionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // (2) ticker
  let currentPrice = jobData.entryPrice;
  try {
    const t = await tickerSource.getTicker(jobData.symbol, { category: "linear" });
    const p = Number(t.lastPrice);
    if (Number.isFinite(p) && p > 0) currentPrice = p;
  } catch (err) {
    log({
      ts: observedAt, event: "funding-arb-ticker-unavailable",
      symbol: jobData.symbol,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "continue", updatedData: { ...jobData, lastReviewAt: observedAt } };
  }

  // (3) decide
  const decision = decideFn({
    fundingRateBps: jobData.fundingRateAtEntryBps,
    nextFundingTime: jobData.fundingTimeTarget,
    now,
    symbol: jobData.symbol,
    hasOpenPosition: true,
    openPositionEnteredForFundingTime: jobData.fundingTimeTarget,
    config: {
      minAbsRateBps: config.fundingArbMinAbsRateBps,
      entryWindowMinutesBefore: config.fundingArbEntryWindowMinutesBefore,
      exitDelayMinutesAfter: config.fundingArbExitDelayMinutesAfter,
    },
  });

  if (decision.kind === "hold") {
    return {
      status: "continue",
      updatedData: {
        ...jobData,
        lastReviewAt: observedAt,
        decisionsHistory: appendDecisionHistory(jobData.decisionsHistory, {
          at: observedAt, action: "hold", reasoning: decision.reason,
        }),
      },
    };
  }

  // exit — close reduce-only
  const closeSide: "Buy" | "Sell" = jobData.side === "long" ? "Sell" : "Buy";
  if (!config.paperTrading) {
    try {
      await client.createOrder({
        category: "linear",
        symbol: jobData.symbol,
        side: closeSide,
        qty: String(jobData.qty),
        orderType: "Market",
        reduceOnly: true,
      });
    } catch (err) {
      log({
        ts: observedAt, event: "funding-arb-close-failed",
        symbol: jobData.symbol,
        error: err instanceof Error ? err.message : String(err),
      });
      await alerter.send(`funding-arb close failed: ${jobData.symbol}`).catch(() => {});
      return {
        status: "continue",
        updatedData: { ...jobData, lastReviewAt: observedAt },
      };
    }
  }

  const sliceSign = jobData.side === "long" ? 1 : -1;
  const grossPnl = sliceSign * (currentPrice - jobData.entryPrice) * jobData.qty;
  const closeNotional = jobData.qty * currentPrice;
  const feeUsd = closeNotional * (config.feeRoundTripBps / 10_000);
  const netPnl = grossPnl - feeUsd;

  await positionLedger.appendClosedPosition(buildLedgerEntry({
    jobData, currentPrice, closeQty: jobData.qty,
    netPnl, grossPnl, feeUsd,
    reasoning: decision.reason,
    cumulativeRealizedPnlUsd: 0,
  }));
  await sharedState.setLastTradeAt(now);

  log({
    ts: observedAt, event: "funding-arb-close",
    positionId: jobData.positionId, symbol: jobData.symbol,
    closeQty: jobData.qty, currentPrice, grossPnl, feeUsd, netPnl,
    reason: decision.reason,
  });

  return { status: "complete", reason: decision.reason };
}

function buildLedgerEntry(params: {
  jobData: FundingArbManageJobData;
  currentPrice: number;
  closeQty: number;
  netPnl: number;
  grossPnl: number;
  feeUsd: number;
  reasoning: string;
  cumulativeRealizedPnlUsd: number;
}): ClosedPositionLedgerEntry {
  const { jobData, currentPrice, closeQty, netPnl, grossPnl, feeUsd, reasoning, cumulativeRealizedPnlUsd } = params;
  return {
    closedAt: new Date().toISOString(),
    cumulativeRealizedPnlUsd,
    entryPrice: jobData.entryPrice,
    exitPrice: currentPrice,
    exitReason: reasoning,
    leverage: jobData.leverage,
    notionalUsd: closeQty * currentPrice,
    openedAt: jobData.openedAt,
    quantity: closeQty,
    realizedPnlUsd: netPnl,
    grossPnlUsd: grossPnl,
    feeUsd,
    championIdAtEntry: null,
    strategyType: "funding-arb",
    side: jobData.side,
    stopLossPrice: 0,
    symbol: jobData.symbol,
    takeProfitPrice: 0,
  };
}

export const __INTERNAL = { buildLedgerEntry };
