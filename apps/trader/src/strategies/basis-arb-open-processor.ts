/**
 * basis-arb OPEN-DECISION processor (Phase 2 BullMQ migration).
 *
 * Two-leg: perp + spot on the same symbol. If leg2 (spot) placement fails
 * we compensate leg1 (perp reduce-only) and DO NOT enqueue a manage job
 * (no exposure tracked).
 */

import {
  JOB_NAMES, STRATEGY_JOB_POLICY,
  type BasisArbManageJobData, type BasisArbOpenTickJobData,
} from "@ai-scalper/queueing";

import type { createBybitClient } from "@ai-scalper/bybit-client";
import type { TraderConfig } from "../config";
import type { WebhookAlerter } from "../alerts/webhook";
import { basisArbDecide, computeBasisBps } from "./basis-arb";
import type { StrategySharedState } from "./shared/bullmq-shared-state";
import { computeQtyFromNotional, makePositionId } from "./shared/trade-job-helpers";

type BybitClient = ReturnType<typeof createBybitClient>;

export interface ManageQueueLike<TData> {
  add(name: string, data: TData, opts?: Record<string, unknown>): Promise<unknown>;
}

export interface BasisArbOpenProcessorDeps {
  config: TraderConfig;
  client: BybitClient;
  alerter: WebhookAlerter;
  manageQueue: ManageQueueLike<BasisArbManageJobData>;
  sharedState: StrategySharedState;
  decideFn?: typeof basisArbDecide;
  log?: (payload: Record<string, unknown>) => void;
  now?: () => number;
}

export type BasisArbOpenTickResult =
  | { status: "skipped"; reason: string }
  | {
      status: "opened";
      positionId: string;
      symbol: string;
      perpSide: "long" | "short";
      spotSide: "long" | "short";
      qty: number;
      perpEntryPrice: number;
      spotEntryPrice: number;
      notionalUsd: number;
      entryBasisBps: number;
    }
  | { status: "compensated"; reason: string };

export async function processBasisArbOpenTick(
  _jobData: BasisArbOpenTickJobData,
  deps: BasisArbOpenProcessorDeps,
): Promise<BasisArbOpenTickResult> {
  const { config, client, alerter, manageQueue, sharedState } = deps;
  const decideFn = deps.decideFn ?? basisArbDecide;
  const log = deps.log ?? ((p) => console.log(JSON.stringify(p)));
  const now = (deps.now ?? Date.now)();
  const observedAt = new Date(now).toISOString();
  const symbol = config.symbol;

  if (await sharedState.hasActivePosition()) {
    return { status: "skipped", reason: "active-position-exists" };
  }

  // Fetch perp + spot tickers (spot via category "spot").
  let perpPrice = 0; let spotPrice = 0; let fundingRateBps = 0;
  try {
    const [perpT, spotT] = await Promise.all([
      client.getTicker({ category: "linear", symbol }),
      client.getTicker({ category: "spot", symbol }),
    ]);
    perpPrice = Number(perpT.lastPrice);
    spotPrice = Number(spotT.lastPrice);
    const fr = Number(perpT.fundingRate);
    fundingRateBps = Number.isFinite(fr) ? fr * 10_000 : 0;
  } catch (err) {
    log({
      ts: observedAt, event: "basis-arb-ticker-unavailable",
      symbol, error: err instanceof Error ? err.message : String(err),
    });
    return { status: "skipped", reason: "ticker-unavailable" };
  }
  if (!Number.isFinite(perpPrice) || perpPrice <= 0 || !Number.isFinite(spotPrice) || spotPrice <= 0) {
    return { status: "skipped", reason: "ticker-invalid" };
  }

  const decision = decideFn({
    spotPrice, perpPrice, now, position: null,
    config: {
      entryThresholdBps: config.basisArbEntryThresholdBps,
      exitThresholdBps: config.basisArbExitThresholdBps,
      maxHoldMinutes: config.basisArbMaxHoldMinutes,
    },
  });
  if (decision.kind !== "enter") {
    return { status: "skipped", reason: `decide-${decision.kind}:${decision.reason}` };
  }

  let perpInstr;
  let spotInstr;
  try {
    [perpInstr, spotInstr] = await Promise.all([
      client.getInstrumentInfo({ category: "linear", symbol }),
      client.getInstrumentInfo({ category: "spot", symbol }),
    ]);
  } catch (err) {
    log({
      ts: observedAt, event: "basis-arb-instrument-info-unavailable",
      symbol, error: err instanceof Error ? err.message : String(err),
    });
    return { status: "skipped", reason: "instrument-info-unavailable" };
  }

  const notionalUsd = config.basisArbMaxNotionalUsd;
  const qtyOut = computeQtyFromNotional({
    notionalUsd, leverage: 1, price: perpPrice,
    qtyStep: perpInstr.lotSizeFilter.qtyStep,
    minOrderQty: perpInstr.lotSizeFilter.minOrderQty,
  });
  if (!qtyOut) return { status: "skipped", reason: "qty-below-min" };

  if (!config.paperTrading) {
    // Leg 1: perp
    try {
      await client.createOrder({
        category: "linear", symbol,
        side: decision.perpSide === "long" ? "Buy" : "Sell",
        qty: qtyOut.qtyStr, orderType: "Market",
      });
    } catch (err) {
      log({
        ts: observedAt, event: "basis-arb-perp-open-failed",
        symbol, error: err instanceof Error ? err.message : String(err),
      });
      await alerter.send(`basis-arb perp open failed: ${symbol}`).catch(() => {});
      return { status: "skipped", reason: "perp-open-failed" };
    }
    // Leg 2: spot — if it fails compensate leg 1.
    try {
      await client.createOrder({
        category: "spot", symbol,
        side: decision.spotSide === "long" ? "Buy" : "Sell",
        qty: qtyOut.qtyStr, orderType: "Market",
      });
    } catch (err) {
      log({
        ts: observedAt, event: "basis-arb-spot-open-failed-compensating",
        symbol, error: err instanceof Error ? err.message : String(err),
      });
      try {
        await client.createOrder({
          category: "linear", symbol,
          side: decision.perpSide === "long" ? "Sell" : "Buy",
          qty: qtyOut.qtyStr, orderType: "Market", reduceOnly: true,
        });
      } catch (compErr) {
        log({
          ts: observedAt, event: "basis-arb-compensation-failed",
          symbol, error: compErr instanceof Error ? compErr.message : String(compErr),
        });
        await alerter.send(`basis-arb COMPENSATION FAILED, manual close needed: ${symbol}`).catch(() => {});
      }
      await alerter.send(`basis-arb spot open failed (compensated): ${symbol}`).catch(() => {});
      return { status: "compensated", reason: "spot-open-failed" };
    }
  }

  const entryBasisBps = computeBasisBps(spotPrice, perpPrice);
  const positionId = makePositionId({ strategy: "basis-arb", now, discriminator: symbol });
  const manageData: BasisArbManageJobData = {
    positionId, symbol,
    perpSide: decision.perpSide, spotSide: decision.spotSide,
    perpEntryPrice: perpPrice, spotEntryPrice: spotPrice,
    qty: qtyOut.qty,
    qtyStep: perpInstr.lotSizeFilter.qtyStep,
    minOrderQty: perpInstr.lotSizeFilter.minOrderQty,
    notionalUsd,
    openedAt: new Date(now).toISOString(),
    entryBasisBps,
    fundingRateAtEntryBps: fundingRateBps,
    decisionsHistory: [{
      at: new Date(now).toISOString(),
      action: "enter", reasoning: decision.reason,
    }],
    lastReviewAt: new Date(now).toISOString(),
  };

  await manageQueue.add(
    JOB_NAMES.basisArbManageTick, manageData,
    { ...STRATEGY_JOB_POLICY, jobId: positionId, repeat: { every: Math.max(5_000, config.pollMs) } },
  );

  log({
    ts: observedAt, event: "basis-arb-opened",
    positionId, symbol, perpSide: decision.perpSide, spotSide: decision.spotSide,
    qty: qtyOut.qty, perpEntryPrice: perpPrice, spotEntryPrice: spotPrice,
    notionalUsd, entryBasisBps,
  });

  return {
    status: "opened",
    positionId, symbol,
    perpSide: decision.perpSide, spotSide: decision.spotSide,
    qty: qtyOut.qty,
    perpEntryPrice: perpPrice, spotEntryPrice: spotPrice,
    notionalUsd, entryBasisBps,
  };
}
