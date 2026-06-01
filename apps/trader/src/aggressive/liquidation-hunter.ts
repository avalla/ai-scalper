/**
 * Liquidation-hunter strategy — pure decide fn.
 *
 * Premise: price is statistically attracted to magnitude clusters from the
 * liquidation map. We position TOWARD the nearest magnet, with TP set just
 * SHY of it (slip protection) and a mechanical hard stop on the opposite
 * side. No "hedge" — pure direction + stop.
 *
 * Rules:
 *   1. Pick the nearest magnet on each side.
 *   2. If both exist, target the LARGER magnitude (the stronger magnet wins).
 *   3. If only one exists, target it.
 *   4. Require a minimum magnitude ratio between target and opposite side —
 *      don't trade when both sides are roughly balanced (no edge).
 *   5. Require a minimum distance to magnet — don't trade if we're already on
 *      top of one (already played out).
 *   6. Sizing: tier.maxNotionalPerTrade (clamped). Stop & TP from tier fractions.
 *
 * The function is PURE — no I/O, no randomness. Deterministic given inputs.
 */

import type {
  AggressiveIntent,
  AggressiveTierConfig,
  LiquidationMap,
} from "./types";
import { nearestMagnets } from "./liquidation-map";

export interface HunterParams {
  /**
   * Require target magnet ≥ opposite × this ratio. Higher = more selective
   * (only clear setups). Default 1.5.
   */
  minDominanceRatio: number;
  /**
   * Require target magnet ≥ this many bps away from refPrice (room to run).
   * Default 10 bps. Below this it's already at the magnet.
   */
  minTargetDistanceBps: number;
  /**
   * Required absolute magnitude of the target magnet (USD). Filters noise.
   * Default 50_000.
   */
  minTargetMagnitudeUsd: number;
  /**
   * Fractional offset from the magnet for the TP (so we exit BEFORE the cluster
   * absorbs us). Expressed as a fraction of the magnet distance. Default 0.85
   * (capture 85% of the move).
   */
  tpProximityFraction: number;
}

export const DEFAULT_HUNTER_PARAMS: HunterParams = {
  minDominanceRatio: 1.5,
  minTargetDistanceBps: 10,
  minTargetMagnitudeUsd: 50_000,
  tpProximityFraction: 0.85,
};

export function liquidationHunterDecide(
  map: LiquidationMap,
  tier: AggressiveTierConfig,
  params: HunterParams = DEFAULT_HUNTER_PARAMS,
): AggressiveIntent {
  const ref = map.refPrice;
  if (!Number.isFinite(ref) || ref <= 0) {
    return { kind: "skip", reason: "invalid-ref-price" };
  }
  if (tier.strategy !== "liquidation-hunter") {
    return { kind: "skip", reason: `tier-strategy-mismatch:${tier.strategy}` };
  }

  const { above, below } = nearestMagnets(map);
  if (!above && !below) return { kind: "skip", reason: "no-magnets" };

  // Pick the dominant side.
  let target = above; let oppositeSize = below?.magnitudeUsd ?? 0;
  let side: "long" | "short" = "long";
  if (!above && below) { target = below; side = "short"; oppositeSize = 0; }
  else if (above && below) {
    if (above.magnitudeUsd >= below.magnitudeUsd) { target = above; side = "long"; oppositeSize = below.magnitudeUsd; }
    else { target = below; side = "short"; oppositeSize = above.magnitudeUsd; }
  } else if (above && !below) { side = "long"; oppositeSize = 0; }
  if (!target) return { kind: "skip", reason: "no-target-magnet" };

  // Minimum-magnitude filter.
  if (target.magnitudeUsd < params.minTargetMagnitudeUsd) {
    return { kind: "skip", reason: `target-too-small:${target.magnitudeUsd.toFixed(0)}<${params.minTargetMagnitudeUsd}` };
  }
  // Dominance filter — refuse balanced setups.
  if (oppositeSize > 0 && target.magnitudeUsd < oppositeSize * params.minDominanceRatio) {
    return { kind: "skip", reason: `dominance-too-low:${(target.magnitudeUsd / oppositeSize).toFixed(2)}<${params.minDominanceRatio}` };
  }
  // Distance filter — already at the magnet, no room.
  const distanceBps = Math.abs(target.price - ref) / ref * 10_000;
  if (distanceBps < params.minTargetDistanceBps) {
    return { kind: "skip", reason: `distance-too-small:${distanceBps.toFixed(1)}bps<${params.minTargetDistanceBps}` };
  }

  // Sizing + price computation.
  const notionalUsd = tier.maxNotionalPerTrade;
  const leverage = tier.leverage;
  const refPrice = ref;
  // TP: take fraction of the way to the magnet (avoid getting absorbed).
  const move = (target.price - refPrice); // signed
  const tpPrice = refPrice + move * params.tpProximityFraction;
  // Stop: opposite side, distance = tier.hardStopFraction × refPrice.
  const stopDistance = refPrice * tier.hardStopFraction;
  const stopPrice = side === "long" ? refPrice - stopDistance : refPrice + stopDistance;

  return {
    kind: "enter", side, notionalUsd, leverage, refPrice,
    stopPrice, takeProfitPrice: tpPrice,
    reason: `liq-hunter:target=${target.price.toFixed(2)}(${target.magnitudeUsd.toFixed(0)}USD,${target.count}prints) ref=${refPrice.toFixed(2)}`,
  };
}
