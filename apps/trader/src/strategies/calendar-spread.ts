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
 * Compute the calendar spread `(dated - perp) / perp` in basis points using
 * MARK prices. Used by the manager for convergence detection on exit (the
 * convergence target is a market-wide phenomenon, not execution-specific).
 *
 * Returns 0 if perpPrice <= 0 to avoid division pathologies.
 */
export function computeCalendarSpreadBps(perpPrice: number, datedPrice: number): number {
  if (perpPrice <= 0) return 0;
  return ((datedPrice - perpPrice) / perpPrice) * 10_000;
}

/**
 * REALIZABLE entry spread using order-book L1. This is the spread we would
 * actually capture if we had to take both legs RIGHT NOW at the visible bid/ask,
 * BEFORE fees. Maker execution can do better than this, but we use the worst
 * case for the entry decision so we never enter on phantom mark-only edge.
 *
 * Conventions match the mark-based version:
 *  - positive = dated rich → long perp + short dated direction is profitable.
 *    Capture = (dated_bid - perp_ask) / perp_mid.
 *    We'd sell dated into its bid, buy perp at its ask (worst-case taker).
 *  - negative = dated cheap → short perp + long dated direction is profitable.
 *    Capture = (dated_ask - perp_bid) / perp_mid (will be the more negative one).
 *    We'd buy dated at its ask, sell perp into its bid.
 *
 * The two directions are NOT symmetric: we report the worst-case capture per
 * direction. The decision logic picks whichever direction's realizable capture
 * exceeds the threshold in magnitude.
 *
 * Post-mortem of first live cohort (2026-06-05): mark-based spread overstated
 * captureable edge by ~10-15 bps per trade because it ignored bid/ask costs.
 */
export function computeRealizableEntrySpreadBps(input: {
  perpBid: number; perpAsk: number;
  datedBid: number; datedAsk: number;
}): { positiveDirection: number; negativeDirection: number; perpMid: number } {
  const perpMid = (input.perpBid + input.perpAsk) / 2;
  if (perpMid <= 0) return { positiveDirection: 0, negativeDirection: 0, perpMid: 0 };
  return {
    positiveDirection: ((input.datedBid - input.perpAsk) / perpMid) * 10_000,
    negativeDirection: ((input.datedAsk - input.perpBid) / perpMid) * 10_000,
    perpMid,
  };
}

function hoursUntil(deliveryAt: number, now: number): number {
  return (deliveryAt - now) / 3_600_000;
}

export interface CalendarEntryDecisionInput {
  perpBid: number; perpAsk: number;
  datedBid: number; datedAsk: number;
  datedDeliveryAt: number;
  now: number;
  config: {
    entryThresholdBps: number;
    preSettlementCloseHours: number;
  };
}

/**
 * Entry-only decision that consumes bid/ask (not mark). Use this in the
 * evaluator so we never enter on phantom mark-only edge. Returns the worst-case
 * realizable capture as `spreadBps` on the entry; this is what gets stored in
 * the position and compared against exitThresholdBps later.
 */
export function calendarDecideForEntry(input: CalendarEntryDecisionInput): CalendarDecision {
  const r = computeRealizableEntrySpreadBps({
    perpBid: input.perpBid, perpAsk: input.perpAsk,
    datedBid: input.datedBid, datedAsk: input.datedAsk,
  });
  const hoursToSettlement = hoursUntil(input.datedDeliveryAt, input.now);
  if (hoursToSettlement < input.config.preSettlementCloseHours + 1) {
    return { kind: "hold", reason: "too-close-to-settlement", spreadBps: r.positiveDirection };
  }
  if (r.positiveDirection >= input.config.entryThresholdBps) {
    return {
      kind: "enter", perpSide: "long", datedSide: "short",
      spreadBps: r.positiveDirection,
      reason: `calendar-entry-realizable:+${r.positiveDirection.toFixed(2)}bps`,
    };
  }
  if (r.negativeDirection <= -input.config.entryThresholdBps) {
    return {
      kind: "enter", perpSide: "short", datedSide: "long",
      spreadBps: r.negativeDirection,
      reason: `calendar-entry-realizable:${r.negativeDirection.toFixed(2)}bps`,
    };
  }
  return {
    kind: "hold", reason: "realizable-spread-too-small",
    spreadBps: Math.abs(r.positiveDirection) > Math.abs(r.negativeDirection) ? r.positiveDirection : r.negativeDirection,
  };
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
