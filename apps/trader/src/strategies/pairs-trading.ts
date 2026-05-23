/**
 * Pairs-trading strategy (pure decision module — no I/O).
 *
 * Statistical-arbitrage on two co-integrated linear-perp symbols (default
 * BTCUSDT / ETHUSDT). We model the log-spread:
 *
 *     spread_t = log(leg2_t) - β · log(leg1_t)
 *
 * where β is an OLS hedge ratio computed over a rolling window of aligned
 * closes. The z-score of the spread relative to its rolling mean / stddev
 * drives entries / exits:
 *
 *   - z >  entryZ →  leg2 is *rich* relative to leg1 → SHORT leg2, LONG leg1
 *   - z < -entryZ →  leg2 is *cheap*                 → LONG  leg2, SHORT leg1
 *   - |z| ≤ exitZ → spread converged → close both legs
 *   - hold time ≥ maxHoldMinutes → force exit regardless of z
 *
 * The hedge ratio is frozen at entry on the `PairsPosition` so the exit
 * z-score is computed against the same regression that triggered entry —
 * this prevents asymmetric flapping if the rolling β drifts mid-trade.
 *
 * The caller is responsible for fetching aligned klines for both legs and
 * passing them via `PairsCache` (oldest first, most recent last). This
 * module remains pure for unit testing.
 */

export interface PairsCache {
  leg1Symbol: string;
  leg2Symbol: string;
  /** Date.now() when the cache was last (re)populated. */
  fetchedAt: number;
  /** Aligned closes — oldest first, most recent last. */
  leg1Closes: number[];
  leg2Closes: number[];
}

export interface PairsPosition {
  leg1Symbol: string;
  leg1Side: "long" | "short";
  leg1EntryPrice: number;
  leg1Qty: number;
  leg2Symbol: string;
  leg2Side: "long" | "short";
  leg2EntryPrice: number;
  leg2Qty: number;
  entryZ: number;
  /** β captured at entry; reused for the exit z-score to avoid drift flapping. */
  hedgeRatio: number;
  /** Unix ms of position open. */
  entryAt: number;
}

export interface PairsArbInput {
  cache: PairsCache | null;
  position: PairsPosition | null;
  now: number;
  refreshSec: number;
  windowSize: number;
  /** Open when |z| > this (strict). */
  entryZ: number;
  /** Close when |z| ≤ this (inclusive). */
  exitZ: number;
  maxHoldMinutes: number;
  /** Expected symbols for cache validation (caller passes the configured pair). */
  leg1Symbol: string;
  leg2Symbol: string;
}

export type PairsDecision =
  | {
      kind: "enter";
      leg1Side: "long" | "short";
      leg2Side: "long" | "short";
      z: number;
      hedgeRatio: number;
      spread: number;
      reason: string;
    }
  | {
      kind: "exit";
      reason: "z-converged" | "max-hold-exceeded";
      currentZ: number;
    }
  | {
      kind: "hold";
      reason: string;
      z?: number;
    };

/**
 * OLS hedge ratio β of log(leg2) ≈ β · log(leg1) + const.
 *
 * Returns the slope of a linear regression of log(leg2) on log(leg1) over
 * the aligned window. Falls back to 1 if variance is too small to invert.
 */
export function computeHedgeRatio(leg1: number[], leg2: number[]): number {
  if (leg1.length === 0 || leg1.length !== leg2.length) {
    return 1;
  }
  const n = leg1.length;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i += 1) {
    const x = Math.log(leg1[i]!);
    const y = Math.log(leg2[i]!);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return 1;
    }
    sumX += x;
    sumY += y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = Math.log(leg1[i]!) - meanX;
    const dy = Math.log(leg2[i]!) - meanY;
    cov += dx * dy;
    varX += dx * dx;
  }
  if (varX <= 1e-12) {
    return 1;
  }
  return cov / varX;
}

/**
 * Compute spread = log(leg2_t) - β · log(leg1_t), and the z-score of the
 * current (last) spread against the rolling window's mean / stddev.
 */
export function computeZScore(
  leg1: number[],
  leg2: number[],
  hedgeRatio: number,
): { z: number; mean: number; stddev: number; spread: number } {
  if (leg1.length === 0 || leg1.length !== leg2.length) {
    return { z: 0, mean: 0, stddev: 0, spread: 0 };
  }
  const n = leg1.length;
  const spreads = new Array<number>(n);
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const s = Math.log(leg2[i]!) - hedgeRatio * Math.log(leg1[i]!);
    spreads[i] = s;
    sum += s;
  }
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i += 1) {
    const d = spreads[i]! - mean;
    varSum += d * d;
  }
  const stddev = Math.sqrt(varSum / n);
  const currentSpread = spreads[n - 1]!;
  const z = stddev > 1e-12 ? (currentSpread - mean) / stddev : 0;
  return { z, mean, stddev, spread: currentSpread };
}

export function pairsDecide(input: PairsArbInput): PairsDecision {
  // ── In-position branch: use FROZEN hedge ratio from entry ──────────────
  if (input.position !== null) {
    const minutesHeld = (input.now - input.position.entryAt) / 60_000;
    // Max-hold takes precedence so we always exit on the time-cap regardless
    // of whether we have a usable cache.
    if (minutesHeld >= input.maxHoldMinutes) {
      const currentZ = input.cache
        && input.cache.leg1Symbol === input.position.leg1Symbol
        && input.cache.leg2Symbol === input.position.leg2Symbol
        && input.cache.leg1Closes.length === input.cache.leg2Closes.length
        && input.cache.leg1Closes.length > 0
        ? computeZScore(
            input.cache.leg1Closes,
            input.cache.leg2Closes,
            input.position.hedgeRatio,
          ).z
        : input.position.entryZ;
      return { kind: "exit", reason: "max-hold-exceeded", currentZ };
    }
    if (
      input.cache === null
      || input.cache.leg1Symbol !== input.position.leg1Symbol
      || input.cache.leg2Symbol !== input.position.leg2Symbol
      || (input.now - input.cache.fetchedAt) >= input.refreshSec * 1000
    ) {
      return { kind: "hold", reason: "needs-refresh" };
    }
    if (
      input.cache.leg1Closes.length !== input.cache.leg2Closes.length
      || input.cache.leg1Closes.length === 0
    ) {
      return { kind: "hold", reason: "invalid-cache" };
    }
    const { z } = computeZScore(
      input.cache.leg1Closes,
      input.cache.leg2Closes,
      input.position.hedgeRatio,
    );
    if (Math.abs(z) <= input.exitZ) {
      return { kind: "exit", reason: "z-converged", currentZ: z };
    }
    return { kind: "hold", reason: "waiting-convergence", z };
  }

  // ── Flat branch: consider opening ──────────────────────────────────────
  if (
    input.cache === null
    || input.cache.leg1Symbol !== input.leg1Symbol
    || input.cache.leg2Symbol !== input.leg2Symbol
    || (input.now - input.cache.fetchedAt) >= input.refreshSec * 1000
  ) {
    return { kind: "hold", reason: "needs-refresh" };
  }
  if (input.cache.leg1Closes.length !== input.cache.leg2Closes.length) {
    return { kind: "hold", reason: "invalid-cache" };
  }
  if (input.cache.leg1Closes.length < input.windowSize) {
    return { kind: "hold", reason: "warmup" };
  }
  const leg1 = input.cache.leg1Closes.slice(-input.windowSize);
  const leg2 = input.cache.leg2Closes.slice(-input.windowSize);
  const hedgeRatio = computeHedgeRatio(leg1, leg2);
  const { z, spread } = computeZScore(leg1, leg2, hedgeRatio);
  if (Math.abs(z) <= input.entryZ) {
    return { kind: "hold", reason: "within-bands", z };
  }
  if (z > 0) {
    // leg2 rich vs leg1 → short leg2, long leg1.
    return {
      kind: "enter",
      leg1Side: "long",
      leg2Side: "short",
      z,
      hedgeRatio,
      spread,
      reason: `pairs-entry:z=${z.toFixed(2)}`,
    };
  }
  // leg2 cheap → long leg2, short leg1.
  return {
    kind: "enter",
    leg1Side: "short",
    leg2Side: "long",
    z,
    hedgeRatio,
    spread,
    reason: `pairs-entry:z=${z.toFixed(2)}`,
  };
}
