/**
 * Calendar-spread strategy (pure decision module — no I/O).
 *
 * Idea: on Bybit V5 the same underlying trades as both a perpetual contract
 * (e.g. BTCUSDT) and as dated quarterly futures (e.g. BTC-26SEP25). Both live
 * under `category: "linear"` but with different `contractType`. The spread
 * `(dated - perp) / perp` (bps) typically reflects time value + funding
 * expectations and converges to zero at the dated contract's settlement.
 *
 * Strategy:
 *   - Positive spread (dated rich, contango)   → perp=long,  dated=short
 *   - Negative spread (dated cheap, backwardation) → perp=short, dated=long
 * Exit on convergence (|spread| <= exitThresholdBps) or when within
 * `preSettlementCloseHours` of the dated contract's `deliveryTime` (force-close
 * to avoid settlement-process risk).
 *
 * Operator note: this v1 takes the dated symbol + delivery time from config
 * (operator must populate from Bybit's listed quarterlies). Auto-discovery is
 * intentionally not wired here to keep the surface small.
 */

export type CalendarLeg = "long" | "short";

export interface CalendarPosition {
  /** Side of the perp leg. */
  perpSide: CalendarLeg;
  /** Side of the dated leg (always opposite of the perp leg). */
  datedSide: CalendarLeg;
  perpEntryPrice: number;
  datedEntryPrice: number;
  /** Contract qty (same on both legs in v1). */
  qty: number;
  /** Spread (bps) at the moment we opened. */
  entrySpreadBps: number;
  /** Unix ms of position open. */
  entryAt: number;
  /** Unix ms of dated contract settlement. */
  datedDeliveryAt: number;
}

export interface CalendarInput {
  perpPrice: number;
  datedPrice: number;
  /** Unix ms of dated contract settlement. */
  datedDeliveryAt: number;
  /** Unix ms — current wall-clock. */
  now: number;
  position: CalendarPosition | null;
  config: {
    /** Open when |spread| >= this. Strict equality at threshold does NOT enter. */
    entryThresholdBps: number;
    /** Close when |spread| <= this (inclusive). */
    exitThresholdBps: number;
    /** Force-close this many hours before dated settlement. Also: refuse to
     *  open within this many hours of settlement. */
    preSettlementCloseHours: number;
  };
}

export type CalendarDecision =
  | {
      kind: "enter";
      perpSide: CalendarLeg;
      datedSide: CalendarLeg;
      spreadBps: number;
      reason: string;
    }
  | {
      kind: "exit";
      reason: "spread-converged" | "pre-settlement" | "divergence-stop";
      currentSpreadBps: number;
    }
  | { kind: "hold"; reason: string; spreadBps: number };

/**
 * Compute the calendar spread `(dated - perp) / perp` in basis points.
 * Returns 0 if perpPrice <= 0 to avoid division pathologies.
 */
export function computeCalendarSpreadBps(perpPrice: number, datedPrice: number): number {
  if (perpPrice <= 0) return 0;
  return ((datedPrice - perpPrice) / perpPrice) * 10_000;
}

function hoursUntil(deliveryAt: number, now: number): number {
  return (deliveryAt - now) / 3_600_000;
}

export function calendarDecide(input: CalendarInput): CalendarDecision {
  const spreadBps = computeCalendarSpreadBps(input.perpPrice, input.datedPrice);

  // In a position: exit-side logic.
  if (input.position !== null) {
    const hoursToSettlement = hoursUntil(input.position.datedDeliveryAt, input.now);
    if (hoursToSettlement <= input.config.preSettlementCloseHours) {
      return {
        kind: "exit",
        reason: "pre-settlement",
        currentSpreadBps: spreadBps,
      };
    }
    if (Math.abs(spreadBps) <= input.config.exitThresholdBps) {
      return {
        kind: "exit",
        reason: "spread-converged",
        currentSpreadBps: spreadBps,
      };
    }
    return { kind: "hold", reason: "waiting-convergence", spreadBps };
  }

  // No position — consider opening. Strict <= matches basis-arb (boundary holds).
  if (Math.abs(spreadBps) <= input.config.entryThresholdBps) {
    return { kind: "hold", reason: "spread-too-small", spreadBps };
  }

  // Refuse to open too close to settlement. Buffer one extra hour on top of
  // the pre-settlement close window so we don't open + force-close on the next
  // tick.
  const hoursToSettlement = hoursUntil(input.datedDeliveryAt, input.now);
  if (hoursToSettlement < input.config.preSettlementCloseHours + 1) {
    return { kind: "hold", reason: "too-close-to-settlement", spreadBps };
  }

  // |spread| >= entryThreshold — open the calendar spread.
  if (spreadBps > 0) {
    // Dated expensive → perp long, dated short.
    return {
      kind: "enter",
      perpSide: "long",
      datedSide: "short",
      spreadBps,
      reason: `calendar-entry:+${spreadBps.toFixed(2)}bps`,
    };
  }
  // Dated cheap → perp short, dated long.
  return {
    kind: "enter",
    perpSide: "short",
    datedSide: "long",
    spreadBps,
    reason: `calendar-entry:${spreadBps.toFixed(2)}bps`,
  };
}
