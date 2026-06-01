/**
 * Spot-perp basis arbitrage strategy (pure decision module — no I/O).
 *
 * Idea: On Bybit UNIFIED account the same symbol exists as both spot and
 * linear perp. The basis = (perpPrice - spotPrice) / spotPrice (in bps) is
 * usually small but occasionally diverges (contango / backwardation).
 *
 * - Positive basis (perp > spot): short perp + long spot. Market-neutral.
 *   We profit from basis convergence plus funding (longs pay shorts on perp).
 * - Negative basis (perp < spot): long perp + short spot.
 *
 * Exit when |basis| reverts back inside the exit threshold, or after a hard
 * time-cap to bound funding-direction and execution risk.
 */

export type BasisLeg = "long" | "short";

export interface BasisPosition {
  /** Side of the perp leg. */
  perpSide: BasisLeg;
  /** Side of the spot leg (always opposite of the perp leg). */
  spotSide: BasisLeg;
  /** Basis (bps) at the moment we opened the spread. */
  entryBasisBps: number;
  /** Unix ms of position open. */
  entryAt: number;
}

export interface BasisArbInput {
  spotPrice: number;
  perpPrice: number;
  now: number;
  position: BasisPosition | null;
  config: {
    /** Open when |basis| >= this. Strict equality at threshold does NOT enter. */
    entryThresholdBps: number;
    /** Close when |basis| <= this (inclusive). */
    exitThresholdBps: number;
    /** Force-exit after this many minutes regardless of basis. */
    maxHoldMinutes: number;
  };
}

export type BasisArbDecision =
  | {
      kind: "enter";
      perpSide: BasisLeg;
      spotSide: BasisLeg;
      basisBps: number;
      reason: string;
    }
  | {
      kind: "exit";
      reason: "basis-converged" | "max-hold-exceeded" | "divergence-stop";
      currentBasisBps: number;
    }
  | { kind: "hold"; reason: string; basisBps: number };

/**
 * Maximum plausible perp/spot basis (bps). The real basis on a liquid symbol
 * is single-digit bps; anything beyond this ceiling is a data error (e.g. a
 * stale/bad tick on one leg), not a tradeable signal, and must NOT open a
 * position. 500bps (5%) is already wildly generous.
 */
export const MAX_PLAUSIBLE_BASIS_BPS = 500;

/** Compute the basis (perp - spot) / spot in basis points. Returns 0 if spot<=0. */
export function computeBasisBps(spotPrice: number, perpPrice: number): number {
  if (spotPrice <= 0) return 0;
  return ((perpPrice - spotPrice) / spotPrice) * 10_000;
}

export function basisArbDecide(input: BasisArbInput): BasisArbDecision {
  const basisBps = computeBasisBps(input.spotPrice, input.perpPrice);

  if (input.position !== null) {
    const minutesHeld = (input.now - input.position.entryAt) / 60_000;
    if (minutesHeld >= input.config.maxHoldMinutes) {
      return { kind: "exit", reason: "max-hold-exceeded", currentBasisBps: basisBps };
    }
    if (Math.abs(basisBps) <= input.config.exitThresholdBps) {
      return { kind: "exit", reason: "basis-converged", currentBasisBps: basisBps };
    }
    return { kind: "hold", reason: "waiting-convergence", basisBps };
  }

  // No position — consider opening.
  // Data-integrity guard: reject physically-impossible basis as a bad tick.
  if (Math.abs(basisBps) > MAX_PLAUSIBLE_BASIS_BPS) {
    return { kind: "hold", reason: "implausible-basis", basisBps };
  }
  if (Math.abs(basisBps) <= input.config.entryThresholdBps) {
    return { kind: "hold", reason: "basis-too-small", basisBps };
  }

  // |basis| > entryThreshold: open the spread.
  if (basisBps > 0) {
    // Perp expensive: short perp, long spot.
    return {
      kind: "enter",
      perpSide: "short",
      spotSide: "long",
      basisBps,
      reason: `basis-arb-entry:+${basisBps.toFixed(2)}bps`,
    };
  }
  // Perp cheap: long perp, short spot.
  return {
    kind: "enter",
    perpSide: "long",
    spotSide: "short",
    basisBps,
    reason: `basis-arb-entry:${basisBps.toFixed(2)}bps`,
  };
}
