/**
 * Aggressive guards — pre-trade safety checks.
 *
 * Composable: callers run all guards; the FIRST one that blocks wins. Each
 * guard returns `{allowed: true}` or `{allowed: false, reason}`. The reason
 * goes into the audit log; the order is NOT placed.
 *
 * Guards are pure functions of (intent, state, limits). The caller is
 * responsible for keeping `AggressiveGuardState` up to date — typically by
 * reading the ledger window at each tick.
 *
 * NOTE: the per-trade HARD STOP LOSS is enforced at execution time (the
 * manage processor checks `currentPrice` vs `intent.stopPrice` every tick),
 * NOT here. This module handles the BEFORE-OPEN gate only.
 */

import type {
  AggressiveGuardLimits,
  AggressiveGuardResult,
  AggressiveGuardState,
  AggressiveIntent,
} from "./types";

export type AggressiveGuard = (
  intent: AggressiveIntent,
  state: AggressiveGuardState,
  limits: AggressiveGuardLimits,
) => AggressiveGuardResult;

const ALLOWED: AggressiveGuardResult = { allowed: true };

/**
 * Daily-loss circuit breaker: blocks new entries once cumulative realized loss
 * for the day reaches `dailyLossCapFraction` of the day-start equity.
 *
 * Example: dayStartEquity=$500, cap=0.5 → block after -$250 of realized loss.
 */
export const dailyLossCapGuard: AggressiveGuard = (intent, state, limits) => {
  if (intent.kind !== "enter") return ALLOWED;
  if (!(limits.dailyLossCapFraction > 0)) return ALLOWED;
  if (!(state.dayStartEquityUsd > 0)) return ALLOWED;
  const lossUsd = Math.max(0, -state.dailyRealizedPnlUsd);
  const capUsd = state.dayStartEquityUsd * limits.dailyLossCapFraction;
  if (lossUsd >= capUsd) {
    return {
      allowed: false,
      reason: `daily-loss-cap-hit:lossUsd=${lossUsd.toFixed(2)} capUsd=${capUsd.toFixed(2)} fraction=${limits.dailyLossCapFraction}`,
    };
  }
  return ALLOWED;
};

/**
 * Anti-tilt: caps trades per day. Prevents an over-firing strategy from
 * burning capital on fees during a flat market or a feedback-loop bug.
 */
export const maxTradesPerDayGuard: AggressiveGuard = (intent, state, limits) => {
  if (intent.kind !== "enter") return ALLOWED;
  if (!(limits.maxTradesPerDay > 0)) return ALLOWED;
  if (state.tradesToday >= limits.maxTradesPerDay) {
    return {
      allowed: false,
      reason: `max-trades-per-day-hit:today=${state.tradesToday} max=${limits.maxTradesPerDay}`,
    };
  }
  return ALLOWED;
};

/**
 * Total-capital cap: hard ceiling on equity allocated to the aggressive
 * subsystem. Above this, refuse to open — operator must explicitly reduce.
 * This is the structural firewall keeping aggressive separate from the
 * conservative book.
 */
export const totalCapitalCapGuard: AggressiveGuard = (intent, state, limits) => {
  if (intent.kind !== "enter") return ALLOWED;
  if (!(limits.maxTotalCapitalUsd > 0)) return ALLOWED;
  if (state.currentEquityUsd > limits.maxTotalCapitalUsd) {
    return {
      allowed: false,
      reason: `total-capital-cap-exceeded:equity=${state.currentEquityUsd.toFixed(2)} cap=${limits.maxTotalCapitalUsd}`,
    };
  }
  return ALLOWED;
};

/** Default guard set in evaluation order. The first failure short-circuits. */
export const DEFAULT_AGGRESSIVE_GUARDS: readonly AggressiveGuard[] = [
  dailyLossCapGuard,
  maxTradesPerDayGuard,
  totalCapitalCapGuard,
];

/** Run guards in order; return the first block, else allow. */
export function runAggressiveGuards(
  guards: readonly AggressiveGuard[],
  intent: AggressiveIntent,
  state: AggressiveGuardState,
  limits: AggressiveGuardLimits,
): AggressiveGuardResult {
  for (const g of guards) {
    const r = g(intent, state, limits);
    if (!r.allowed) return r;
  }
  return ALLOWED;
}

// ── Per-trade hard-stop evaluator (in-flight protection) ─────────────────

/**
 * Decide whether an open position must be closed NOW based on its hard stop.
 * Called by the manage processor at every tick — not by the open-gate.
 */
export function shouldHardStop(params: {
  side: "long" | "short";
  entryPrice: number;
  stopPrice: number;
  currentPrice: number;
}): boolean {
  if (params.side === "long") return params.currentPrice <= params.stopPrice;
  return params.currentPrice >= params.stopPrice;
}

/** Same idea for take profit, symmetric. */
export function shouldTakeProfit(params: {
  side: "long" | "short";
  entryPrice: number;
  takeProfitPrice: number;
  currentPrice: number;
}): boolean {
  if (params.side === "long") return params.currentPrice >= params.takeProfitPrice;
  return params.currentPrice <= params.takeProfitPrice;
}
