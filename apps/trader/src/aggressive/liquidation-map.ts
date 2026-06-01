/**
 * Liquidation-map heuristic (free, no paid API).
 *
 * Clusters recent liquidation prints by price band into "magnets" — levels
 * with concentrated leveraged-position pain that the price is statistically
 * pulled toward (because cascading liquidations self-reinforce).
 *
 * Inputs: a flat list of `LiquidationEvent` with `{ts, side, sizeUsd, price}`,
 * a reference price (current market), and tunable params.
 *
 * Output: a `LiquidationMap` separating magnets above and below the ref price,
 * each sorted by proximity to ref.
 *
 * PURE — no I/O. The cache reader / WS subscription is a separate concern.
 */

import type { LiquidationEvent, LiquidationMagnet, LiquidationMap } from "./types";

export interface BuildMapOpts {
  /**
   * Cluster bandwidth in basis points. Two liquidations within this many bps
   * of each other (relative to refPrice) merge into the same magnet. Typical:
   * 10-30 bps on BTC, more on less-liquid alts.
   */
  bandBps: number;
  /**
   * Drop magnets with cumulative size below this floor (USD) — noise filter.
   */
  minMagnetSizeUsd: number;
  /**
   * Drop magnets farther than this many bps from refPrice (irrelevant). Bigger
   * is "see further". 0 = no cap.
   */
  maxDistanceBps?: number;
  /**
   * Drop events older than `(nowMs - maxAgeMs)`. 0 = no age filter.
   */
  maxAgeMs?: number;
  /** Reference for the "now" used by the age filter. Defaults to Date.now(). */
  nowMs?: number;
}

/** Convert price distance to bps relative to a reference. */
function priceDistanceBps(price: number, refPrice: number): number {
  if (refPrice <= 0) return Number.POSITIVE_INFINITY;
  return Math.abs(price - refPrice) / refPrice * 10_000;
}

/** Weighted-mean price across a cluster, weighted by sizeUsd. */
function weightedMeanPrice(events: readonly LiquidationEvent[]): number {
  let num = 0;
  let den = 0;
  for (const e of events) { num += e.price * e.sizeUsd; den += e.sizeUsd; }
  return den > 0 ? num / den : 0;
}

/**
 * Build a liquidation map. Pure function — deterministic given the same inputs.
 */
export function buildLiquidationMap(
  events: readonly LiquidationEvent[],
  refPrice: number,
  opts: BuildMapOpts,
): LiquidationMap {
  const empty: LiquidationMap = { refPrice, above: [], below: [] };
  if (!Number.isFinite(refPrice) || refPrice <= 0) return empty;
  if (events.length === 0) return empty;

  const nowMs = opts.nowMs ?? Date.now();

  // 1. Filter: valid, recent enough.
  let filtered = events.filter((e) =>
    Number.isFinite(e.price) && e.price > 0
    && Number.isFinite(e.sizeUsd) && e.sizeUsd > 0,
  );
  if (opts.maxAgeMs && opts.maxAgeMs > 0) {
    filtered = filtered.filter((e) => nowMs - e.ts <= opts.maxAgeMs!);
  }
  if (opts.maxDistanceBps && opts.maxDistanceBps > 0) {
    filtered = filtered.filter((e) => priceDistanceBps(e.price, refPrice) <= opts.maxDistanceBps!);
  }
  if (filtered.length === 0) return empty;

  // 2. Sort by price, sweep into bands. A new band starts whenever the gap
  //    from the band's anchor price exceeds bandBps × refPrice / 10000.
  const sorted = filtered.slice().sort((a, b) => a.price - b.price);
  const bandWidth = (opts.bandBps / 10_000) * refPrice;
  const clusters: LiquidationEvent[][] = [];
  let current: LiquidationEvent[] = [];
  let anchorPrice = -Infinity;
  for (const e of sorted) {
    if (current.length === 0 || (e.price - anchorPrice) <= bandWidth) {
      if (current.length === 0) anchorPrice = e.price;
      current.push(e);
    } else {
      clusters.push(current);
      current = [e]; anchorPrice = e.price;
    }
  }
  if (current.length > 0) clusters.push(current);

  // 3. Build magnets; filter by minMagnetSizeUsd; split above/below ref.
  const above: LiquidationMagnet[] = [];
  const below: LiquidationMagnet[] = [];
  for (const c of clusters) {
    const magnitudeUsd = c.reduce((acc, e) => acc + e.sizeUsd, 0);
    if (magnitudeUsd < opts.minMagnetSizeUsd) continue;
    const price = weightedMeanPrice(c);
    const magnet: LiquidationMagnet = { price, magnitudeUsd, count: c.length };
    if (price > refPrice) above.push(magnet);
    else if (price < refPrice) below.push(magnet);
    // exactly equal → drop (no directional signal)
  }
  // 4. Sort by proximity to ref.
  above.sort((a, b) => a.price - b.price);
  below.sort((a, b) => b.price - a.price);
  return { refPrice, above, below };
}

/**
 * Convenience: return the nearest magnet on each side, or null if none. The
 * liquidation-hunter strategy uses this to pick the target.
 */
export function nearestMagnets(map: LiquidationMap): {
  above: LiquidationMagnet | null;
  below: LiquidationMagnet | null;
} {
  return {
    above: map.above[0] ?? null,
    below: map.below[0] ?? null,
  };
}
