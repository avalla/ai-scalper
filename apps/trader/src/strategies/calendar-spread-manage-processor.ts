/**
 * calendar-spread MANAGE processor (Phase 2 BullMQ migration).
 *
 * Two-leg perp + dated. On every tick:
 *   1. Reconcile BOTH legs (live).
 *   2. Fetch both tickers.
 *   3. calendarDecide; exit → close both reduce-only, ledger, complete;
 *      hold → continue.
 */

import type { createBybitClient } from "@ai-scalper/bybit-client";
import type { TickerSource } from "@ai-scalper/bybit-client/ticker-source";
import type { CalendarSpreadManageJobData } from "@ai-scalper/queueing";
import type { TraderConfig } from "../config";
import type { WebhookAlerter } from "../alerts/webhook";
import { calendarDecide, computeCalendarSpreadBps, type CalendarDecision } from "./calendar-spread";
import type { StrategySharedState } from "./shared/bullmq-shared-state";
import { appendDecisionHistory } from "./shared/trade-job-helpers";
import type { ClosedPositionLedgerEntry } from "../trading/position-ledger";
import { placeOrderWithMakerPreference } from "../pipeline/maker-execution";

type BybitClient = ReturnType<typeof createBybitClient>;

export interface CalendarSpreadManageProcessorLedger {
  appendClosedPosition(entry: ClosedPositionLedgerEntry): Promise<void>;
}

export interface CalendarSpreadManageProcessorDeps {
  config: TraderConfig;
  client: BybitClient;
  tickerSource: TickerSource;
  alerter: WebhookAlerter;
  sharedState: StrategySharedState;
  positionLedger: CalendarSpreadManageProcessorLedger;
  decideFn?: typeof calendarDecide;
  log?: (payload: Record<string, unknown>) => void;
  now?: () => number;
}

export type CalendarSpreadManageTickResult =
  | { status: "complete"; reason: string }
  | { status: "continue"; updatedData: CalendarSpreadManageJobData };

export async function processCalendarSpreadManageTick(
  jobData: CalendarSpreadManageJobData,
  deps: CalendarSpreadManageProcessorDeps,
): Promise<CalendarSpreadManageTickResult> {
  const { config, client, tickerSource, alerter, sharedState, positionLedger } = deps;
  const decideFn = deps.decideFn ?? calendarDecide;
  const log = deps.log ?? ((p) => console.log(JSON.stringify(p)));
  const now = (deps.now ?? Date.now)();
  const observedAt = new Date(now).toISOString();

  // (1) Reconcile both legs (live)
  if (!config.paperTrading) {
    try {
      const [perpPos, datedPos] = await Promise.all([
        client.getPosition({ category: "linear", symbol: jobData.perpSymbol }),
        client.getPosition({ category: "linear", symbol: jobData.datedSymbol }),
      ]);
      const ps = perpPos ? Number(perpPos.size) : 0;
      const ds = datedPos ? Number(datedPos.size) : 0;
      const perpMissing = !perpPos || !Number.isFinite(ps) || ps < jobData.qty * 0.01;
      const datedMissing = !datedPos || !Number.isFinite(ds) || ds < jobData.qty * 0.01;
      if (perpMissing || datedMissing) {
        await positionLedger.appendClosedPosition(buildLedger(jobData, jobData.perpEntryPrice, jobData.datedEntryPrice, 0, 0, 0, "external-close-detected", jobData.entrySpreadBps));
        await alerter.send(`calendar-spread: external close ${jobData.perpSymbol}+${jobData.datedSymbol}`).catch(() => {});
        return { status: "complete", reason: "external-close" };
      }
    } catch (err) {
      log({
        ts: observedAt, event: "calendar-spread-reconcile-failed",
        positionId: jobData.positionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // (2) tickers
  let perpPrice = jobData.perpEntryPrice;
  let datedPrice = jobData.datedEntryPrice;
  try {
    const [perpT, datedT] = await Promise.all([
      tickerSource.getTicker(jobData.perpSymbol, { category: "linear" }),
      tickerSource.getTicker(jobData.datedSymbol, { category: "linear" }),
    ]);
    const p = Number(perpT.lastPrice); const d = Number(datedT.lastPrice);
    if (Number.isFinite(p) && p > 0) perpPrice = p;
    if (Number.isFinite(d) && d > 0) datedPrice = d;
  } catch (err) {
    log({
      ts: observedAt, event: "calendar-spread-ticker-unavailable",
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "continue", updatedData: { ...jobData, lastReviewAt: observedAt } };
  }

  // (3a) divergence-stop guard — leveraged-trading safety net.
  // If the spread has WIDENED beyond the configured tolerance vs the entry,
  // close immediately rather than wait for convergence. Skip when disabled (0)
  // or when the position was opened at 1x leverage AND user didn't set a stop.
  const currentSpreadBps = computeCalendarSpreadBps(perpPrice, datedPrice);
  const widenedBps = Math.abs(currentSpreadBps) - Math.abs(jobData.entrySpreadBps);
  const divergenceStopBps = config.calendarSpreadDivergenceStopBps;
  let decision: CalendarDecision;
  if (divergenceStopBps > 0 && widenedBps > divergenceStopBps) {
    log({
      ts: observedAt, event: "calendar-spread-divergence-stop",
      positionId: jobData.positionId,
      entrySpreadBps: jobData.entrySpreadBps, currentSpreadBps,
      widenedBps, divergenceStopBps,
    });
    decision = { kind: "exit", reason: "divergence-stop", currentSpreadBps };
  } else {
    // (3b) normal decide
    decision = decideFn({
      perpPrice, datedPrice,
      datedDeliveryAt: jobData.datedDeliveryAt, now,
      position: {
        perpSide: jobData.perpSide, datedSide: jobData.datedSide,
        perpEntryPrice: jobData.perpEntryPrice, datedEntryPrice: jobData.datedEntryPrice,
        qty: jobData.qty,
        entrySpreadBps: jobData.entrySpreadBps,
        entryAt: new Date(jobData.openedAt).getTime(),
        datedDeliveryAt: jobData.datedDeliveryAt,
      },
      config: {
        entryThresholdBps: config.calendarEntryThresholdBps,
        exitThresholdBps: config.calendarExitThresholdBps,
        preSettlementCloseHours: config.calendarPreSettlementCloseHours,
      },
    });
  }

  if (decision.kind === "hold") {
    return {
      status: "continue",
      updatedData: {
        ...jobData, lastReviewAt: observedAt,
        decisionsHistory: appendDecisionHistory(jobData.decisionsHistory, {
          at: observedAt, action: "hold", reasoning: `${decision.reason} spread=${decision.spreadBps.toFixed(2)}`,
        }),
      },
    };
  }

  // exit — close both legs reduce-only.
  // Post-mortem: 65% of all fees came from taker exits ($4.93/16 trades). The
  // PERP leg is highly liquid → maker close with short timeout almost always
  // fills with rebate (-2 vs +5.5 bps). The DATED leg stays Market (illiquid;
  // legging-out risk from a stuck maker close is worse than the fee saving).
  if (!config.paperTrading) {
    const perpCloseSide: "Buy" | "Sell" = jobData.perpSide === "long" ? "Sell" : "Buy";
    const datedCloseSide: "Buy" | "Sell" = jobData.datedSide === "long" ? "Sell" : "Buy";

    // Perp: maker-first with timeout, automatic fallback to Market reduceOnly.
    try {
      const r = await placeOrderWithMakerPreference(
        { category: "linear", symbol: jobData.perpSymbol, side: perpCloseSide, qty: String(jobData.qty), reduceOnly: true },
        { client, tickerSource, log: (p) => log({ ts: observedAt, ...p }) },
        { timeoutMs: 10_000, pollIntervalMs: 1_000, fallbackToTaker: true },
      );
      if (r.status === "skipped-failed") throw new Error(`perp-close-failed:${r.reason}`);
    } catch (err) {
      log({ ts: observedAt, event: "calendar-spread-close-leg-failed", leg: "perp", symbol: jobData.perpSymbol, error: err instanceof Error ? err.message : String(err) });
      await alerter.send(`calendar-spread close perp failed: ${jobData.perpSymbol}`).catch(() => {});
      return {
        status: "continue",
        updatedData: { ...jobData, lastReviewAt: observedAt,
          decisionsHistory: appendDecisionHistory(jobData.decisionsHistory, { at: observedAt, action: "close-attempt-failed", reasoning: "perp" }),
        },
      };
    }

    // Dated: Market reduceOnly (illiquid; legging-out risk > taker fee).
    try {
      await client.createOrder({ category: "linear", symbol: jobData.datedSymbol, side: datedCloseSide, qty: String(jobData.qty), orderType: "Market", reduceOnly: true });
    } catch (err) {
      log({ ts: observedAt, event: "calendar-spread-close-leg-failed", leg: "dated", symbol: jobData.datedSymbol, error: err instanceof Error ? err.message : String(err) });
      await alerter.send(`calendar-spread close dated failed: ${jobData.datedSymbol}`).catch(() => {});
      return {
        status: "continue",
        updatedData: { ...jobData, lastReviewAt: observedAt,
          decisionsHistory: appendDecisionHistory(jobData.decisionsHistory, { at: observedAt, action: "close-attempt-failed", reasoning: "dated" }),
        },
      };
    }
  }

  const psign = jobData.perpSide === "long" ? 1 : -1;
  const dsign = jobData.datedSide === "long" ? 1 : -1;
  const perpPnl = psign * (perpPrice - jobData.perpEntryPrice) * jobData.qty;
  const datedPnl = dsign * (datedPrice - jobData.datedEntryPrice) * jobData.qty;
  const grossPnl = perpPnl + datedPnl;
  const feeUsd = (perpPrice + datedPrice) * jobData.qty * (config.feeRoundTripBps / 10_000);
  const netPnl = grossPnl - feeUsd;
  const exitSpreadBps = computeCalendarSpreadBps(perpPrice, datedPrice);

  await positionLedger.appendClosedPosition(buildLedger(jobData, perpPrice, datedPrice, netPnl, grossPnl, feeUsd, decision.reason, exitSpreadBps));
  await sharedState.setLastTradeAt(now);

  log({
    ts: observedAt, event: "calendar-spread-close",
    positionId: jobData.positionId,
    perpPnl, datedPnl, grossPnl, feeUsd, netPnl, reason: decision.reason, exitSpreadBps,
  });

  // Pin-risk telemetry: surface losses that close within 48h of settlement.
  // We need to know if (a) liquidity dry-up near settlement is causing adverse
  // exits, vs (b) losses are independent of contract age (general volatility).
  // Emit only — no behavioral change. Tail with: grep pin-risk-loss-suspect.
  const hoursToSettlementAtClose = (jobData.datedDeliveryAt - now) / 3_600_000;
  if (netPnl < 0 && hoursToSettlementAtClose < PIN_RISK_WINDOW_HOURS) {
    log({
      ts: observedAt, event: "pin-risk-loss-suspect",
      positionId: jobData.positionId,
      datedSymbol: jobData.datedSymbol,
      hoursToSettlement: Number(hoursToSettlementAtClose.toFixed(2)),
      netPnl: Number(netPnl.toFixed(4)),
      reason: decision.reason,
      entrySpreadBps: jobData.entrySpreadBps,
      exitSpreadBps,
    });
  }

  return { status: "complete", reason: decision.reason };
}

/** Window in which a loss is flagged as potentially driven by pin-risk. */
export const PIN_RISK_WINDOW_HOURS = 48;

function buildLedger(
  jobData: CalendarSpreadManageJobData,
  perpExit: number, _datedExit: number,
  netPnl: number, grossPnl: number, feeUsd: number,
  reason: string, exitSpreadBps: number,
): ClosedPositionLedgerEntry {
  return {
    closedAt: new Date().toISOString(),
    cumulativeRealizedPnlUsd: 0,
    entryPrice: jobData.perpEntryPrice,
    exitPrice: perpExit,
    exitReason: reason,
    leverage: 1,
    notionalUsd: jobData.qty * perpExit,
    openedAt: jobData.openedAt,
    quantity: jobData.qty,
    realizedPnlUsd: netPnl,
    grossPnlUsd: grossPnl,
    feeUsd,
    championIdAtEntry: null,
    strategyType: "calendar-spread",
    calendarDatedSymbol: jobData.datedSymbol,
    calendarEntrySpreadBps: jobData.entrySpreadBps,
    calendarExitSpreadBps: exitSpreadBps,
    side: jobData.perpSide,
    stopLossPrice: 0,
    symbol: jobData.perpSymbol,
    takeProfitPrice: 0,
  };
}

export const __INTERNAL = { buildLedger };
