/**
 * funding-arb OPEN-DECISION processor (Phase 2 BullMQ migration).
 *
 * Pure, fully-DI'd function. On each tick:
 *   1. Skip if a live manage-job already exists (1-position invariant).
 *   2. Fetch ticker + funding info for the configured symbol.
 *   3. Call `fundingArbDecide`. If the decision is `enter`, place the entry
 *      order and enqueue the manage job.
 *
 * I/O routes through injected deps so tests can use stubs.
 */

import {
  JOB_NAMES,
  STRATEGY_JOB_POLICY,
  type FundingArbManageJobData,
  type FundingArbOpenTickJobData,
} from "@ai-scalper/queueing";

import type { createBybitClient } from "@ai-scalper/bybit-client";
import type { TickerSource } from "@ai-scalper/bybit-client/ticker-source";
import type { TraderConfig } from "../config";
import type { WebhookAlerter } from "../alerts/webhook";
import { fundingArbDecide, type FundingArbDecision } from "./funding-arb";
import type { StrategySharedState } from "./shared/bullmq-shared-state";
import {
  computeQtyFromNotional,
  makePositionId,
} from "./shared/trade-job-helpers";

type BybitClient = ReturnType<typeof createBybitClient>;

export interface ManageQueueLike<TData> {
  add(name: string, data: TData, opts?: Record<string, unknown>): Promise<unknown>;
}

export interface FundingArbOpenProcessorDeps {
  config: TraderConfig;
  client: BybitClient;
  tickerSource: TickerSource;
  alerter: WebhookAlerter;
  manageQueue: ManageQueueLike<FundingArbManageJobData>;
  sharedState: StrategySharedState;
  /** Override the decide function for tests. */
  decideFn?: typeof fundingArbDecide;
  log?: (payload: Record<string, unknown>) => void;
  now?: () => number;
}

export type FundingArbOpenTickResult =
  | { status: "skipped"; reason: string }
  | {
      status: "opened";
      positionId: string;
      symbol: string;
      side: "long" | "short";
      qty: number;
      entryPrice: number;
      notionalUsd: number;
      leverage: number;
      fundingTimeTarget: number;
    };

export async function processFundingArbOpenTick(
  _jobData: FundingArbOpenTickJobData,
  deps: FundingArbOpenProcessorDeps,
): Promise<FundingArbOpenTickResult> {
  const { config, client, tickerSource, alerter, manageQueue, sharedState } = deps;
  const decideFn = deps.decideFn ?? fundingArbDecide;
  const log = deps.log ?? ((p) => console.log(JSON.stringify(p)));
  const now = (deps.now ?? Date.now)();
  const observedAt = new Date(now).toISOString();

  // (1) one-position invariant
  if (await sharedState.hasActivePosition()) {
    log({ ts: observedAt, event: "funding-arb-open-skip", reason: "active-position-exists" });
    return { status: "skipped", reason: "active-position-exists" };
  }

  const symbol = config.symbol;

  // (2) ticker + funding info
  let lastPrice = 0;
  let fundingRateBps = 0;
  let nextFundingTime = 0;
  try {
    const t = await tickerSource.getTicker(symbol, { category: "linear" });
    lastPrice = Number(t.lastPrice);
    const fr = Number(t.fundingRate);
    fundingRateBps = Number.isFinite(fr) ? fr * 10_000 : 0;
    nextFundingTime = Number(t.nextFundingTime);
  } catch (err) {
    log({
      ts: observedAt,
      event: "funding-arb-open-skip",
      reason: "ticker-unavailable",
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "skipped", reason: "ticker-unavailable" };
  }
  if (!Number.isFinite(lastPrice) || lastPrice <= 0 || !Number.isFinite(nextFundingTime) || nextFundingTime <= 0) {
    return { status: "skipped", reason: "ticker-invalid" };
  }

  // (3) pure decide
  const decision: FundingArbDecision = decideFn({
    fundingRateBps,
    nextFundingTime,
    now,
    symbol,
    hasOpenPosition: false,
    config: {
      minAbsRateBps: config.fundingArbMinAbsRateBps,
      entryWindowMinutesBefore: config.fundingArbEntryWindowMinutesBefore,
      exitDelayMinutesAfter: config.fundingArbExitDelayMinutesAfter,
    },
  });

  log({
    ts: observedAt,
    event: "funding-arb-open-decision",
    kind: decision.kind,
    reason: decision.kind === "enter" ? decision.reason : decision.reason,
    fundingRateBps,
    nextFundingTime,
  });

  if (decision.kind !== "enter") {
    return { status: "skipped", reason: `decide-${decision.kind}:${decision.reason}` };
  }

  // (4) Fetch instrument info to compute qty
  let instrument;
  try {
    instrument = await client.getInstrumentInfo({ category: "linear", symbol });
  } catch (err) {
    log({
      ts: observedAt,
      event: "funding-arb-open-skip",
      reason: "instrument-info-unavailable",
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "skipped", reason: "instrument-info-unavailable" };
  }

  const leverage = Math.max(1, Math.min(config.fundingArbMaxLeverage, config.leverage));
  const notionalUsd = Math.min(config.fundingArbMaxNotionalUsd, config.orderUsd);
  const qtyOut = computeQtyFromNotional({
    notionalUsd,
    leverage,
    price: lastPrice,
    qtyStep: instrument.lotSizeFilter.qtyStep,
    minOrderQty: instrument.lotSizeFilter.minOrderQty,
  });
  if (!qtyOut) {
    log({
      ts: observedAt,
      event: "funding-arb-open-skip",
      reason: "qty-below-min",
      notionalUsd, leverage, price: lastPrice,
    });
    return { status: "skipped", reason: "qty-below-min" };
  }

  // (5) live order placement (paper bypasses)
  if (!config.paperTrading) {
    try {
      await client.setLeverage({
        category: "linear",
        symbol,
        buyLeverage: String(leverage),
        sellLeverage: String(leverage),
      });
    } catch (err) {
      log({
        ts: observedAt,
        event: "funding-arb-set-leverage-failed",
        symbol,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await client.createOrder({
        category: "linear",
        symbol,
        side: decision.side === "long" ? "Buy" : "Sell",
        qty: qtyOut.qtyStr,
        orderType: "Market",
      });
    } catch (err) {
      log({
        ts: observedAt,
        event: "funding-arb-open-order-failed",
        symbol,
        error: err instanceof Error ? err.message : String(err),
      });
      await alerter.send(`funding-arb open order failed: ${symbol}`).catch(() => {});
      return { status: "skipped", reason: "open-order-failed" };
    }
  }

  // (6) enqueue manage job
  const positionId = makePositionId({ strategy: "funding-arb", now, discriminator: symbol });
  const manageData: FundingArbManageJobData = {
    positionId,
    symbol,
    side: decision.side,
    entryPrice: lastPrice,
    qty: qtyOut.qty,
    qtyStep: instrument.lotSizeFilter.qtyStep,
    minOrderQty: instrument.lotSizeFilter.minOrderQty,
    notionalUsd,
    leverage,
    openedAt: new Date(now).toISOString(),
    fundingRateAtEntryBps: fundingRateBps,
    fundingTimeTarget: decision.fundingTimeTarget,
    decisionsHistory: [{
      at: new Date(now).toISOString(),
      action: "enter",
      reasoning: decision.reason,
    }],
    lastReviewAt: new Date(now).toISOString(),
  };

  await manageQueue.add(
    JOB_NAMES.fundingArbManageTick,
    manageData,
    {
      ...STRATEGY_JOB_POLICY,
      jobId: positionId,
      repeat: { every: Math.max(5_000, config.pollMs) },
    },
  );

  log({
    ts: observedAt,
    event: "funding-arb-opened",
    positionId, symbol, side: decision.side, qty: qtyOut.qty,
    entryPrice: lastPrice, notionalUsd, leverage,
  });

  return {
    status: "opened",
    positionId, symbol, side: decision.side,
    qty: qtyOut.qty, entryPrice: lastPrice, notionalUsd, leverage,
    fundingTimeTarget: decision.fundingTimeTarget,
  };
}
