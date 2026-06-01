/**
 * Tier engine — selects the active tier given current equity.
 *
 * Capital-tiered design: the trader is aggressive at low equity and
 * automatically becomes conservative as equity grows. Promotion happens when
 * equity crosses a tier upper bound; demotion happens when equity drops below
 * the lower bound (drawdown protection).
 *
 * Pure function, no I/O. The caller is responsible for tracking equity and
 * applying the returned tier to subsequent intents.
 */

import type { AggressiveTierConfig, AggressiveTierLadder } from "./types";

export interface TierSelection {
  /** The tier matched at the given equity. */
  tier: AggressiveTierConfig;
  /** Zero-based index of the tier in the ladder. */
  index: number;
}

/**
 * Throws if the ladder is invalid (empty, unsorted, overlapping, or has gaps).
 * Should be called once at startup to validate config — the loop in
 * selectActiveTier assumes a valid ladder.
 */
export function validateTierLadder(ladder: AggressiveTierLadder): void {
  if (ladder.length === 0) throw new Error("tier-engine: ladder is empty");
  for (let i = 0; i < ladder.length; i += 1) {
    const t = ladder[i]!;
    if (!(t.minEquity >= 0)) throw new Error(`tier-engine: tier[${i}].minEquity must be >= 0`);
    if (!(t.maxEquity > t.minEquity)) throw new Error(`tier-engine: tier[${i}].maxEquity must be > minEquity`);
    if (i === 0 && t.minEquity !== 0) throw new Error("tier-engine: first tier must start at minEquity=0");
    if (i > 0) {
      const prev = ladder[i - 1]!;
      if (t.minEquity !== prev.maxEquity) {
        throw new Error(`tier-engine: tier[${i}].minEquity (${t.minEquity}) must equal tier[${i - 1}].maxEquity (${prev.maxEquity}) — no gaps/overlap allowed`);
      }
    }
    if (!(t.leverage >= 1)) throw new Error(`tier-engine: tier[${i}].leverage must be >= 1`);
    if (!(t.maxNotionalPerTrade > 0)) throw new Error(`tier-engine: tier[${i}].maxNotionalPerTrade must be > 0`);
    if (!(t.hardStopFraction > 0 && t.hardStopFraction < 1)) {
      throw new Error(`tier-engine: tier[${i}].hardStopFraction must be in (0, 1)`);
    }
    if (!(t.takeProfitFraction > 0)) throw new Error(`tier-engine: tier[${i}].takeProfitFraction must be > 0`);
  }
}

/**
 * Pick the tier covering `equityUsd`. Negative equity clamps to the first tier
 * (you're broke — still need a config to wind down gracefully). Equity above
 * the top tier's maxEquity returns the top tier.
 */
export function selectActiveTier(
  ladder: AggressiveTierLadder,
  equityUsd: number,
): TierSelection {
  if (ladder.length === 0) throw new Error("tier-engine: ladder is empty");
  if (!Number.isFinite(equityUsd) || equityUsd < 0) {
    return { tier: ladder[0]!, index: 0 };
  }
  for (let i = 0; i < ladder.length; i += 1) {
    const t = ladder[i]!;
    if (equityUsd >= t.minEquity && equityUsd < t.maxEquity) {
      return { tier: t, index: i };
    }
  }
  // Equity at or above the top tier's maxEquity — clamp to top.
  return { tier: ladder[ladder.length - 1]!, index: ladder.length - 1 };
}

/**
 * Returns true iff the active tier index would change between two equity
 * values. Useful for logging "tier-promoted" / "tier-demoted" events when
 * crossing a threshold.
 */
export function tierWouldChange(
  ladder: AggressiveTierLadder,
  oldEquityUsd: number,
  newEquityUsd: number,
): boolean {
  return selectActiveTier(ladder, oldEquityUsd).index !== selectActiveTier(ladder, newEquityUsd).index;
}
