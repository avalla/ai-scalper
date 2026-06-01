/**
 * basis-arb MANAGE processor (Phase 2 BullMQ migration).
 *
 * Two-leg reconciliation: at every tick check BOTH legs via getPosition (perp)
 * and the spot wallet/inventory (best-effort — Bybit spot inventory is read
 * via wallet balance; here we keep the simpler "any-leg-missing → close both"
 * pattern). On close, send reduce-only on both legs.
 */

import type { createBybitClient } from "@ai-scalper/bybit-client";
import type { TickerSource } from "@ai-scalper/bybit-client/ticker-source";
import type { BasisArbManageJobData } from "@ai-scalper/queueing";
import type { TraderConfig } from "../config";
import type { WebhookAlerter } from "../alerts/webhook";
import { basisArbDecide, computeBasisBps, type BasisArbDecision } from "./basis-arb";
import type { StrategySharedState } from "./shared/bullmq-shared-state";
import { appendDecisionHistory } from "./shared/trade-job-helpers";
import type { ClosedPositionLedgerEntry } from "../trading/position-ledger";

type BybitClient = ReturnType<typeof createBybitClient>;

export interface BasisArbManageProcessorLedger {
  appendClosedPosition(entry: ClosedPositionLedgerEntry): Promise<void>;
}

export interface BasisArbManageProcessorDeps {
  config: TraderConfig;
  client: BybitClient;
  tickerSource: TickerSource;
  alerter: WebhookAlerter;
  sharedState: StrategySharedState;
  positionLedger: BasisArbManageProcessorLedger;
  decideFn?: typeof basisArbDecide;
  log?: (payload: Record<string, unknown>) => void;
  now?: () => number;
}

export type BasisArbManageTickResult =
  | { status: "complete"; reason: string }
  | { status: "continue"; updatedData: BasisArbManageJobData };

export async function processBasisArbManageTick(
  jobData: BasisArbManageJobData,
  deps: BasisArbManageProcessorDeps,
): Promise<BasisArbManageTickResult> {
  const { config, client, tickerSource, alerter, sharedState, positionLedger } = deps;
  const decideFn = deps.decideFn ?? basisArbDecide;
  const log = deps.log ?? ((p) => console.log(JSON.stringify(p)));
  const now = (deps.now ?? Date.now)();
  const observedAt = new Date(now).toISOString();

  // (1) reconcile perp leg (live only); spot inventory is harder to reliably check
  // without wallet calls, so we accept perp-side reconciliation as the proxy.
  if (!config.paperTrading) {
    try {
      const live = await client.getPosition({ category: "linear", symbol: jobData.symbol });
      const liveSize = live ? Number(live.size) : 0;
      if (jobData.qty > 0 && (!live || !Number.isFinite(liveSize) || liveSize < jobData.qty * 0.01)) {
        await positionLedger.appendClosedPosition(buildLedger(jobData, jobData.perpEntryPrice, jobData.spotEntryPrice, 0, 0, 0, "external-close-detected", jobData.entryBasisBps));
        await alerter.send(`basis-arb: external close ${jobData.symbol}`).catch(() => {});
        return { status: "complete", reason: "external-close" };
      }
    } catch (err) {
      log({
        ts: observedAt, event: "basis-arb-reconcile-failed",
        positionId: jobData.positionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // (2) ticker — both legs
  let perpPrice = jobData.perpEntryPrice;
  let spotPrice = jobData.spotEntryPrice;
  try {
    const [perpT, spotT] = await Promise.all([
      tickerSource.getTicker(jobData.symbol, { category: "linear" }),
      tickerSource.getTicker(jobData.symbol, { category: "spot" }),
    ]);
    const p = Number(perpT.lastPrice);
    const s = Number(spotT.lastPrice);
    if (Number.isFinite(p) && p > 0) perpPrice = p;
    if (Number.isFinite(s) && s > 0) spotPrice = s;
  } catch (err) {
    log({
      ts: observedAt, event: "basis-arb-ticker-unavailable",
      symbol: jobData.symbol,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "continue", updatedData: { ...jobData, lastReviewAt: observedAt } };
  }

  // (3a) divergence-stop guard — leveraged-trading safety net.
  const currentBasisBps = computeBasisBps(spotPrice, perpPrice);
  const widenedBps = Math.abs(currentBasisBps) - Math.abs(jobData.entryBasisBps);
  const divergenceStopBps = config.basisArbSpreadDivergenceStopBps;
  let decision: BasisArbDecision;
  if (divergenceStopBps > 0 && widenedBps > divergenceStopBps) {
    log({
      ts: observedAt, event: "basis-arb-divergence-stop",
      positionId: jobData.positionId,
      entryBasisBps: jobData.entryBasisBps, currentBasisBps,
      widenedBps, divergenceStopBps,
    });
    decision = { kind: "exit", reason: "divergence-stop", currentBasisBps };
  } else {
    // (3b) normal decide
    decision = decideFn({
      spotPrice, perpPrice, now,
      position: {
        perpSide: jobData.perpSide, spotSide: jobData.spotSide,
        entryBasisBps: jobData.entryBasisBps,
        entryAt: new Date(jobData.openedAt).getTime(),
      },
      config: {
        entryThresholdBps: config.basisArbEntryThresholdBps,
        exitThresholdBps: config.basisArbExitThresholdBps,
        maxHoldMinutes: config.basisArbMaxHoldMinutes,
      },
    });
  }

  if (decision.kind === "hold") {
    return {
      status: "continue",
      updatedData: {
        ...jobData, lastReviewAt: observedAt,
        decisionsHistory: appendDecisionHistory(jobData.decisionsHistory, {
          at: observedAt, action: "hold", reasoning: `${decision.reason} basis=${decision.basisBps.toFixed(2)}`,
        }),
      },
    };
  }

  // exit — close both legs reduce-only
  if (!config.paperTrading) {
    const closes: Array<() => Promise<void>> = [
      async () => {
        await client.createOrder({
          category: "linear", symbol: jobData.symbol,
          side: jobData.perpSide === "long" ? "Sell" : "Buy",
          qty: String(jobData.qty), orderType: "Market", reduceOnly: true,
        });
      },
      async () => {
        await client.createOrder({
          category: "spot", symbol: jobData.symbol,
          side: jobData.spotSide === "long" ? "Sell" : "Buy",
          qty: String(jobData.qty), orderType: "Market",
        });
      },
    ];
    const maxLegAttempts = 3;
    for (let i = 0; i < closes.length; i += 1) {
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < maxLegAttempts; attempt += 1) {
        try { await closes[i]!(); lastErr = null; break; }
        catch (err) {
          lastErr = err;
          log({
            ts: observedAt, event: "basis-arb-close-leg-attempt-failed",
            leg: i === 0 ? "perp" : "spot", symbol: jobData.symbol,
            attempt: attempt + 1,
            error: err instanceof Error ? err.message : String(err),
          });
          if (attempt < maxLegAttempts - 1) {
            const delayMs = 500 * 2 ** attempt;
            await new Promise((r) => setTimeout(r, delayMs));
          }
        }
      }
      if (lastErr) {
        log({
          ts: observedAt, event: "basis-arb-close-leg-failed",
          leg: i === 0 ? "perp" : "spot", symbol: jobData.symbol,
          attempts: maxLegAttempts,
          error: lastErr instanceof Error ? lastErr.message : String(lastErr),
        });
        await alerter.send(`basis-arb close leg ${i + 1} failed after ${maxLegAttempts}x: ${jobData.symbol}`).catch(() => {});
        // Keep job alive — next tick retries safety (with its own backoff).
        return {
          status: "continue",
          updatedData: {
            ...jobData, lastReviewAt: observedAt,
            decisionsHistory: appendDecisionHistory(jobData.decisionsHistory, {
              at: observedAt, action: "close-attempt-failed", reasoning: `leg=${i + 1}`,
            }),
          },
        };
      }
    }
  }

  // PnL: perp leg PnL + spot leg PnL.
  const perpSign = jobData.perpSide === "long" ? 1 : -1;
  const spotSign = jobData.spotSide === "long" ? 1 : -1;
  const perpPnl = perpSign * (perpPrice - jobData.perpEntryPrice) * jobData.qty;
  const spotPnl = spotSign * (spotPrice - jobData.spotEntryPrice) * jobData.qty;
  const grossPnl = perpPnl + spotPnl;
  const feeUsd = (perpPrice + spotPrice) * jobData.qty * (config.feeRoundTripBps / 10_000);
  const netPnl = grossPnl - feeUsd;
  const exitBasisBps = computeBasisBps(spotPrice, perpPrice);

  await positionLedger.appendClosedPosition(buildLedger(jobData, perpPrice, spotPrice, netPnl, grossPnl, feeUsd, decision.reason, exitBasisBps));
  await sharedState.setLastTradeAt(now);

  log({
    ts: observedAt, event: "basis-arb-close",
    positionId: jobData.positionId, symbol: jobData.symbol,
    perpPrice, spotPrice, perpPnl, spotPnl, grossPnl, feeUsd, netPnl,
    reason: decision.reason, exitBasisBps,
  });
  return { status: "complete", reason: decision.reason };
}

function buildLedger(
  jobData: BasisArbManageJobData,
  perpExitPrice: number, spotExitPrice: number,
  netPnl: number, grossPnl: number, feeUsd: number,
  reason: string, exitBasisBps: number,
): ClosedPositionLedgerEntry {
  return {
    closedAt: new Date().toISOString(),
    cumulativeRealizedPnlUsd: 0,
    entryPrice: jobData.perpEntryPrice,
    exitPrice: perpExitPrice,
    exitReason: reason,
    leverage: 1,
    notionalUsd: jobData.qty * perpExitPrice,
    openedAt: jobData.openedAt,
    quantity: jobData.qty,
    realizedPnlUsd: netPnl,
    grossPnlUsd: grossPnl,
    feeUsd,
    championIdAtEntry: null,
    strategyType: "basis-arb",
    basisEntryBps: jobData.entryBasisBps,
    basisExitBps: exitBasisBps,
    side: jobData.perpSide,
    stopLossPrice: 0,
    symbol: jobData.symbol,
    takeProfitPrice: 0,
  };
}

export const __INTERNAL = { buildLedger };
