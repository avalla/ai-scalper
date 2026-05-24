/**
 * calendar-spread OPEN-DECISION processor (Phase 2 BullMQ migration).
 *
 * Two-leg perp + dated quarterly. Compensation on leg2 failure mirrors
 * basis-arb / pairs-trading.
 */

import {
  JOB_NAMES, STRATEGY_JOB_POLICY,
  type CalendarSpreadManageJobData, type CalendarSpreadOpenTickJobData,
} from "@ai-scalper/queueing";

import type { createBybitClient } from "@ai-scalper/bybit-client";
import type { TraderConfig } from "../config";
import type { WebhookAlerter } from "../alerts/webhook";
import { calendarDecide, computeCalendarSpreadBps } from "./calendar-spread";
import type { StrategySharedState } from "./shared/bullmq-shared-state";
import { computeQtyFromNotional, makePositionId } from "./shared/trade-job-helpers";

type BybitClient = ReturnType<typeof createBybitClient>;

export interface ManageQueueLike<TData> {
  add(name: string, data: TData, opts?: Record<string, unknown>): Promise<unknown>;
}

export interface CalendarSpreadOpenProcessorDeps {
  config: TraderConfig;
  client: BybitClient;
  alerter: WebhookAlerter;
  manageQueue: ManageQueueLike<CalendarSpreadManageJobData>;
  sharedState: StrategySharedState;
  decideFn?: typeof calendarDecide;
  log?: (payload: Record<string, unknown>) => void;
  now?: () => number;
}

export type CalendarSpreadOpenTickResult =
  | { status: "skipped"; reason: string }
  | { status: "compensated"; reason: string }
  | {
      status: "opened";
      positionId: string;
      perpSymbol: string;
      datedSymbol: string;
      perpSide: "long" | "short";
      datedSide: "long" | "short";
      qty: number;
      perpEntryPrice: number;
      datedEntryPrice: number;
      notionalPerLegUsd: number;
      entrySpreadBps: number;
    };

export async function processCalendarSpreadOpenTick(
  _jobData: CalendarSpreadOpenTickJobData,
  deps: CalendarSpreadOpenProcessorDeps,
): Promise<CalendarSpreadOpenTickResult> {
  const { config, client, alerter, manageQueue, sharedState } = deps;
  const decideFn = deps.decideFn ?? calendarDecide;
  const log = deps.log ?? ((p) => console.log(JSON.stringify(p)));
  const now = (deps.now ?? Date.now)();
  const observedAt = new Date(now).toISOString();

  if (!config.calendarDatedSymbol || config.calendarDatedDeliveryAt <= 0) {
    return { status: "skipped", reason: "dated-symbol-or-delivery-not-configured" };
  }

  if (await sharedState.hasActivePosition()) {
    return { status: "skipped", reason: "active-position-exists" };
  }

  let perpPrice = 0; let datedPrice = 0;
  try {
    const [perpT, datedT] = await Promise.all([
      client.getTicker({ category: "linear", symbol: config.calendarPerpSymbol }),
      client.getTicker({ category: "linear", symbol: config.calendarDatedSymbol }),
    ]);
    perpPrice = Number(perpT.lastPrice);
    datedPrice = Number(datedT.lastPrice);
  } catch (err) {
    log({
      ts: observedAt, event: "calendar-spread-ticker-unavailable",
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "skipped", reason: "ticker-unavailable" };
  }
  if (!Number.isFinite(perpPrice) || perpPrice <= 0 || !Number.isFinite(datedPrice) || datedPrice <= 0) {
    return { status: "skipped", reason: "ticker-invalid" };
  }

  const decision = decideFn({
    perpPrice, datedPrice,
    datedDeliveryAt: config.calendarDatedDeliveryAt,
    now, position: null,
    config: {
      entryThresholdBps: config.calendarEntryThresholdBps,
      exitThresholdBps: config.calendarExitThresholdBps,
      preSettlementCloseHours: config.calendarPreSettlementCloseHours,
    },
  });
  if (decision.kind !== "enter") {
    return { status: "skipped", reason: `decide-${decision.kind}:${decision.reason}` };
  }

  let perpInstr; let datedInstr;
  try {
    [perpInstr, datedInstr] = await Promise.all([
      client.getInstrumentInfo({ category: "linear", symbol: config.calendarPerpSymbol }),
      client.getInstrumentInfo({ category: "linear", symbol: config.calendarDatedSymbol }),
    ]);
  } catch (err) {
    log({
      ts: observedAt, event: "calendar-spread-instrument-info-unavailable",
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "skipped", reason: "instrument-info-unavailable" };
  }

  const notionalPerLegUsd = config.calendarMaxNotionalUsdPerLeg;
  const q = computeQtyFromNotional({
    notionalUsd: notionalPerLegUsd, leverage: 1, price: perpPrice,
    qtyStep: perpInstr.lotSizeFilter.qtyStep,
    minOrderQty: perpInstr.lotSizeFilter.minOrderQty,
  });
  if (!q) return { status: "skipped", reason: "qty-below-min" };

  if (!config.paperTrading) {
    try {
      await client.createOrder({
        category: "linear", symbol: config.calendarPerpSymbol,
        side: decision.perpSide === "long" ? "Buy" : "Sell",
        qty: q.qtyStr, orderType: "Market",
      });
    } catch (err) {
      log({
        ts: observedAt, event: "calendar-spread-perp-open-failed",
        error: err instanceof Error ? err.message : String(err),
      });
      await alerter.send(`calendar-spread perp open failed`).catch(() => {});
      return { status: "skipped", reason: "perp-open-failed" };
    }
    try {
      await client.createOrder({
        category: "linear", symbol: config.calendarDatedSymbol,
        side: decision.datedSide === "long" ? "Buy" : "Sell",
        qty: q.qtyStr, orderType: "Market",
      });
    } catch (err) {
      log({
        ts: observedAt, event: "calendar-spread-dated-open-failed-compensating",
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        await client.createOrder({
          category: "linear", symbol: config.calendarPerpSymbol,
          side: decision.perpSide === "long" ? "Sell" : "Buy",
          qty: q.qtyStr, orderType: "Market", reduceOnly: true,
        });
      } catch (compErr) {
        log({
          ts: observedAt, event: "calendar-spread-compensation-failed",
          error: compErr instanceof Error ? compErr.message : String(compErr),
        });
        await alerter.send(`calendar-spread COMPENSATION FAILED`).catch(() => {});
      }
      await alerter.send(`calendar-spread dated open failed (compensated)`).catch(() => {});
      return { status: "compensated", reason: "dated-open-failed" };
    }
  }

  const entrySpreadBps = computeCalendarSpreadBps(perpPrice, datedPrice);
  const positionId = makePositionId({
    strategy: "calendar-spread", now,
    discriminator: `${config.calendarPerpSymbol}-${config.calendarDatedSymbol}`,
  });
  const manageData: CalendarSpreadManageJobData = {
    positionId,
    perpSymbol: config.calendarPerpSymbol,
    datedSymbol: config.calendarDatedSymbol,
    perpSide: decision.perpSide, datedSide: decision.datedSide,
    perpEntryPrice: perpPrice, datedEntryPrice: datedPrice,
    qty: q.qty,
    qtyStep: perpInstr.lotSizeFilter.qtyStep,
    minOrderQty: perpInstr.lotSizeFilter.minOrderQty,
    notionalPerLegUsd,
    openedAt: new Date(now).toISOString(),
    entrySpreadBps,
    datedDeliveryAt: config.calendarDatedDeliveryAt,
    decisionsHistory: [{
      at: new Date(now).toISOString(),
      action: "enter", reasoning: decision.reason,
    }],
    lastReviewAt: new Date(now).toISOString(),
  };

  await manageQueue.add(
    JOB_NAMES.calendarSpreadManageTick, manageData,
    { ...STRATEGY_JOB_POLICY, jobId: positionId, repeat: { every: Math.max(5_000, config.calendarPollSec * 1000) } },
  );

  log({
    ts: observedAt, event: "calendar-spread-opened",
    positionId, perpSymbol: config.calendarPerpSymbol, datedSymbol: config.calendarDatedSymbol,
    perpSide: decision.perpSide, datedSide: decision.datedSide,
    perpEntryPrice: perpPrice, datedEntryPrice: datedPrice, entrySpreadBps,
  });

  return {
    status: "opened",
    positionId,
    perpSymbol: config.calendarPerpSymbol, datedSymbol: config.calendarDatedSymbol,
    perpSide: decision.perpSide, datedSide: decision.datedSide,
    qty: q.qty, perpEntryPrice: perpPrice, datedEntryPrice: datedPrice,
    notionalPerLegUsd, entrySpreadBps,
  };
}
