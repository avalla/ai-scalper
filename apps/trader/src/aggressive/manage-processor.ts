/**
 * Aggressive manage tick — applies hard stop / TP every tick.
 *
 * On a leveraged directional position, the manage tick IS the safety net.
 * It runs faster than the conservative pipeline (typically every 2s vs 10s)
 * so the stop fires close to the configured price even when the market moves
 * fast. There is NO "let it breathe" — stop is mechanical.
 *
 * Per-tick flow:
 *   1. Fetch current price.
 *   2. shouldHardStop / shouldTakeProfit / max-hold time check.
 *   3. If trigger → close reduce-only Market, compute PnL, write ledger,
 *      record daily PnL, return complete.
 *   4. Else → return continue.
 */

import type { createBybitClient } from "@ai-scalper/bybit-client";
import type { TickerSource } from "@ai-scalper/bybit-client/ticker-source";
import type { TraderConfig } from "../config";
import type { WebhookAlerter } from "../alerts/webhook";
import type { ClosedPositionLedgerEntry } from "../trading/position-ledger";
import type { DailyStateStore } from "./daily-state";
import type { AggressiveManageJobData } from "./adapter";
import { shouldHardStop, shouldTakeProfit } from "./guards";

type BybitClient = ReturnType<typeof createBybitClient>;

export interface AggressiveLedgerLike {
  appendClosedPosition(entry: ClosedPositionLedgerEntry): Promise<void>;
}

export interface AggressiveManageDeps {
  config: TraderConfig;
  client: BybitClient;
  tickerSource: TickerSource;
  alerter: WebhookAlerter;
  ledger: AggressiveLedgerLike;
  dailyState: DailyStateStore;
  /** Optional max-hold safety (seconds since open). Disabled when 0/undefined. */
  maxHoldSec?: number;
  log?: (payload: Record<string, unknown>) => void;
  now?: () => number;
}

export type AggressiveManageResult =
  | { status: "continue"; updatedData: AggressiveManageJobData }
  | { status: "complete"; reason: string };

export async function processAggressiveManageTick(
  jobData: AggressiveManageJobData,
  deps: AggressiveManageDeps,
): Promise<AggressiveManageResult> {
  const log = deps.log ?? ((p) => console.log(JSON.stringify(p)));
  const now = (deps.now ?? Date.now)();
  const observedAt = new Date(now).toISOString();

  // 1. Current price.
  let currentPrice = jobData.entryPrice;
  try {
    const t = await deps.tickerSource.getTicker(jobData.symbol, { category: "linear" });
    const p = Number(t.lastPrice);
    if (Number.isFinite(p) && p > 0) currentPrice = p;
  } catch (err) {
    log({ ts: observedAt, event: "aggressive-ticker-unavailable", err: err instanceof Error ? err.message : String(err) });
    return { status: "continue", updatedData: { ...jobData, lastReviewAt: observedAt } };
  }

  // 2. Trigger checks (in priority: stop > tp > maxHold).
  const stopHit = shouldHardStop({ side: jobData.side, entryPrice: jobData.entryPrice, stopPrice: jobData.stopPrice, currentPrice });
  const tpHit = shouldTakeProfit({ side: jobData.side, entryPrice: jobData.entryPrice, takeProfitPrice: jobData.takeProfitPrice, currentPrice });
  const elapsedSec = (now - new Date(jobData.openedAt).getTime()) / 1000;
  const maxHoldHit = deps.maxHoldSec && deps.maxHoldSec > 0 && elapsedSec >= deps.maxHoldSec;

  if (!stopHit && !tpHit && !maxHoldHit) {
    return { status: "continue", updatedData: { ...jobData, lastReviewAt: observedAt } };
  }
  const reason = stopHit ? "hard-stop" : tpHit ? "take-profit" : "max-hold";

  // 3. Close reduce-only (live only).
  if (!deps.config.paperTrading) {
    try {
      await deps.client.createOrder({
        category: "linear", symbol: jobData.symbol,
        side: jobData.side === "long" ? "Sell" : "Buy",
        qty: jobData.qtyStr, orderType: "Market", reduceOnly: true,
      });
    } catch (err) {
      log({ ts: observedAt, event: "aggressive-close-failed", err: err instanceof Error ? err.message : String(err) });
      await deps.alerter.send(`aggressive close FAILED (${reason}): ${jobData.symbol}`).catch(() => {});
      // Keep retrying — at high leverage a missed close is catastrophic.
      return { status: "continue", updatedData: { ...jobData, lastReviewAt: observedAt } };
    }
  }

  // 4. PnL + ledger + dailyState.
  const sign = jobData.side === "long" ? 1 : -1;
  const grossPnl = sign * (currentPrice - jobData.entryPrice) * jobData.qty;
  // feeRoundTripBps assumption applies to the close-side notional (single leg).
  const closeNotional = currentPrice * jobData.qty;
  const feeUsd = closeNotional * (deps.config.feeRoundTripBps / 10_000);
  const netPnl = grossPnl - feeUsd;

  const entry: ClosedPositionLedgerEntry = {
    closedAt: observedAt,
    cumulativeRealizedPnlUsd: 0,
    entryPrice: jobData.entryPrice,
    exitPrice: currentPrice,
    exitReason: reason,
    leverage: jobData.leverage,
    notionalUsd: jobData.notionalUsd,
    openedAt: jobData.openedAt,
    quantity: jobData.qty,
    realizedPnlUsd: netPnl,
    grossPnlUsd: grossPnl,
    feeUsd,
    championIdAtEntry: null,
    // The strategyType field is constrained by the conservative union — until
    // we widen it, the aggressive trades are tagged via exitReason + leverage.
    // Sufficient for filtered reports on the aggressive ledger key.
    side: jobData.side,
    stopLossPrice: jobData.stopPrice,
    symbol: jobData.symbol,
    takeProfitPrice: jobData.takeProfitPrice,
  };
  await deps.ledger.appendClosedPosition(entry);
  await deps.dailyState.recordClosedPnl(netPnl);

  log({
    ts: observedAt, event: "aggressive-close",
    positionId: jobData.positionId, symbol: jobData.symbol, side: jobData.side,
    reason, entryPrice: jobData.entryPrice, exitPrice: currentPrice,
    grossPnl, feeUsd, netPnl,
  });
  return { status: "complete", reason };
}
