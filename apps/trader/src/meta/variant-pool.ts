import type { TraderConfig } from "../config";
import type { StepParams } from "../trading/step";

export interface Variant {
  /** Stable identifier — used as a persistence key. */
  id: string;
  /** Human-readable label. */
  label: string;
  params: StepParams;
  /**
   * Phase 1A: optional whitelist of symbols this variant may trade. When set,
   * the trader (Phase 1B) is responsible for gating selection to these symbols.
   * The bandit/allocator does not enforce this filter — it is metadata only.
   */
  symbolFilter?: string[];
}

/**
 * v1 variant pool — 4 safer variants that perturb signal/exit knobs around the
 * live config. Risk/orderUsd are shared with the live config so all
 * variants face the same exposure budget.
 *
 * v2 additions (aggressive-perps): when `config.tradingProfile === "aggressive-perps"`
 * (or `config.metaIncludeAggressiveVariants === true`), 4 additional variants
 * with higher leverage and tighter stops are appended. Each aggressive variant
 * inherits standard risk knobs (maxPositionUsd, maxDailyLossUsd, etc.) from
 * config — only signal/exit knobs and `leverage` differ.
 */
export function defaultVariantPool(config: TraderConfig): Variant[] {
  const sharedRisk = {
    orderUsd: config.orderUsd,
    maxPositionUsd: config.maxPositionUsd,
    maxDailyLossUsd: config.maxDailyLossUsd,
    maxSpreadBps: config.maxSpreadBps,
    minTradeIntervalMs: config.minTradeIntervalMs,
  };
  const shared = {
    leverage: config.leverage,
    ...sharedRisk,
  };

  const live: StepParams = {
    fastWindow: config.fastWindow,
    slowWindow: config.slowWindow,
    thresholdBps: config.thresholdBps,
    stopLossBps: config.stopLossBps,
    takeProfitBps: config.takeProfitBps,
    ...shared,
  };

  const safe: Variant[] = [
    {
      id: "ma-5-20-th4",
      label: "Live defaults (5/20 MA, threshold 4bps)",
      params: live,
    },
    {
      id: "ma-3-15-th3",
      label: "Faster/looser (3/15 MA, threshold 3bps)",
      params: {
        ...shared,
        fastWindow: 3,
        slowWindow: 15,
        thresholdBps: 3,
        stopLossBps: config.stopLossBps,
        takeProfitBps: config.takeProfitBps,
      },
    },
    {
      id: "ma-8-30-th6",
      label: "Slower/stricter (8/30 MA, threshold 6bps)",
      params: {
        ...shared,
        fastWindow: 8,
        slowWindow: 30,
        thresholdBps: 6,
        stopLossBps: config.stopLossBps,
        takeProfitBps: config.takeProfitBps,
      },
    },
    {
      id: "ma-5-20-th4-tight",
      label: "Live MA, tight stops (SL/TP halved)",
      params: {
        ...shared,
        fastWindow: config.fastWindow,
        slowWindow: config.slowWindow,
        thresholdBps: config.thresholdBps,
        stopLossBps: config.stopLossBps * 0.5,
        takeProfitBps: config.takeProfitBps * 0.5,
      },
    },
  ];

  if (!config.metaIncludeAggressiveVariants) {
    return safe;
  }

  const aggressive: Variant[] = [
    {
      id: "agg-25x-tight",
      label: "Aggressive 25x, tight stops (5/20 MA, SL 15 / TP 25)",
      params: {
        ...sharedRisk,
        leverage: 25,
        fastWindow: 5,
        slowWindow: 20,
        thresholdBps: 4,
        stopLossBps: 15,
        takeProfitBps: 25,
      },
    },
    {
      id: "agg-50x-tight",
      label: "Aggressive 50x, tight stops (5/20 MA, SL 10 / TP 18)",
      params: {
        ...sharedRisk,
        leverage: 50,
        fastWindow: 5,
        slowWindow: 20,
        thresholdBps: 4,
        stopLossBps: 10,
        takeProfitBps: 18,
      },
    },
    {
      id: "agg-75x-very-tight",
      label: "Aggressive 75x, very tight stops (3/15 MA, SL 8 / TP 14)",
      params: {
        ...sharedRisk,
        leverage: 75,
        fastWindow: 3,
        slowWindow: 15,
        thresholdBps: 3,
        stopLossBps: 8,
        takeProfitBps: 14,
      },
    },
    {
      id: "agg-100x-btc-only",
      label: "Aggressive 100x BTC-only (3/12 MA, SL 10 / TP 18)",
      params: {
        ...sharedRisk,
        leverage: 100,
        fastWindow: 3,
        slowWindow: 12,
        thresholdBps: 3,
        stopLossBps: 10,
        takeProfitBps: 18,
      },
      symbolFilter: ["BTCUSDT"],
    },
    {
      id: "agg-50x-relaxed",
      label: "Aggressive 50x relaxed (4/14 MA, SL 15 / TP 28)",
      params: {
        ...sharedRisk,
        leverage: 50,
        fastWindow: 4,
        slowWindow: 14,
        thresholdBps: 4,
        stopLossBps: 15,
        takeProfitBps: 28,
      },
    },
  ];

  return [...safe, ...aggressive];
}
