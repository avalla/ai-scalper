/**
 * Aggressive trader — type contract shared across modules.
 *
 * The aggressive subsystem is INTENTIONALLY isolated from the conservative
 * pipeline (Phase 3 strategies). Different ledger namespace, different worker,
 * different one-position gate, different config root. The two never touch.
 *
 * Architecture:
 *
 *   currentEquity ──▶ tier-engine ──▶ activeTier ──▶ {leverage, maxNotional, strategy}
 *                                                          │
 *   liquidation events ──▶ liquidation-map ──▶ ClusterMap  │
 *                                                  │       │
 *                                                  ▼       ▼
 *                                          liquidation-hunter (pure decide)
 *                                                  │
 *                                                  ▼
 *                                          AggressiveIntent ──▶ guards ──▶ execute
 */

/** One tier in the equity-tiered ladder. */
export interface AggressiveTierConfig {
  /** Inclusive lower bound on equity (USD). */
  minEquity: number;
  /** Exclusive upper bound on equity (USD). Use Number.POSITIVE_INFINITY for the top tier. */
  maxEquity: number;
  /** Leverage applied to entries in this tier. Hard-capped by the runtime. */
  leverage: number;
  /** Max notional per single trade in this tier (USD). */
  maxNotionalPerTrade: number;
  /** Strategy id active in this tier (one strategy at a time per tier). */
  strategy: "liquidation-hunter" | "momentum-breakout" | "mean-reversion";
  /** Hard stop loss as a fraction of NOTIONAL (not equity). E.g. 0.02 = exit at -2% adverse. */
  hardStopFraction: number;
  /** Take profit as a fraction of NOTIONAL. */
  takeProfitFraction: number;
}

/** Equity-tiered ladder. Tiers MUST be sorted by minEquity ascending and not overlap. */
export type AggressiveTierLadder = readonly AggressiveTierConfig[];

/**
 * A single liquidation print as observed on the exchange feed.
 * Extends the existing LiquidationEntry with `price` — required to cluster
 * liquidations by level for the map heuristic. The conservative cache does
 * NOT currently store price; the aggressive subsystem will use an extended
 * cache (wiring out of scope for this module).
 */
export interface LiquidationEvent {
  /** Epoch ms. */
  ts: number;
  /** Side of the liquidated position: Buy = short liquidated, Sell = long liquidated. */
  side: "Buy" | "Sell";
  /** Notional liquidated in USD. */
  sizeUsd: number;
  /** Price at which the liquidation printed. */
  price: number;
}

/** A clustered liquidation magnet — a price level with accumulated weight. */
export interface LiquidationMagnet {
  /** Center price of the cluster. */
  price: number;
  /** Sum of sizeUsd across all liquidations in the cluster. */
  magnitudeUsd: number;
  /** Number of distinct liquidation prints in the cluster. */
  count: number;
}

/**
 * A predicted "liquidation map" — clusters of magnitude above and below the
 * reference price, sorted by proximity to the reference.
 */
export interface LiquidationMap {
  /** Reference price the map was built around. */
  refPrice: number;
  /** Magnets ABOVE refPrice, sorted ascending by price (nearest first). */
  above: readonly LiquidationMagnet[];
  /** Magnets BELOW refPrice, sorted descending by price (nearest first). */
  below: readonly LiquidationMagnet[];
}

/** Output of an aggressive strategy decide fn. */
export type AggressiveIntent =
  | { kind: "skip"; reason: string }
  | {
      kind: "enter";
      side: "long" | "short";
      /** Absolute USD notional this trade. Subject to tier.maxNotionalPerTrade. */
      notionalUsd: number;
      /** Leverage to apply at the exchange. */
      leverage: number;
      /** Reference entry price (market at decide time). */
      refPrice: number;
      /** Hard stop price (mechanical exit, not "we'll hedge"). */
      stopPrice: number;
      /** Take profit price (typically the targeted magnet). */
      takeProfitPrice: number;
      /** Human-readable rationale for the audit log. */
      reason: string;
    };

/** State the guards consult to decide whether to allow the order. */
export interface AggressiveGuardState {
  /** Sum of realized PnL in the rolling daily window (negative when losing). */
  dailyRealizedPnlUsd: number;
  /** Equity at the start of the day, for the daily-cap percentage check. */
  dayStartEquityUsd: number;
  /** Number of trades opened in the rolling daily window. */
  tradesToday: number;
  /** Current account equity, used by tier-engine + cap percentage. */
  currentEquityUsd: number;
}

/** Per-tier risk caps, evaluated by the guard layer before any order placement. */
export interface AggressiveGuardLimits {
  /** Block opening when daily realized loss reaches this fraction of dayStartEquity (positive number). */
  dailyLossCapFraction: number;
  /** Block opening above this number of trades per day. */
  maxTradesPerDay: number;
  /** Hard cap on total capital allocated to the aggressive subsystem (separate from conservative). */
  maxTotalCapitalUsd: number;
}

/** Result of running the guard layer. */
export type AggressiveGuardResult =
  | { allowed: true }
  | { allowed: false; reason: string };
