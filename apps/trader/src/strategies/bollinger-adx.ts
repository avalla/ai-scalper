/**
 * Bollinger + ADX regime-filter strategy (pure decision module — no I/O).
 *
 * ADX acts as a regime classifier:
 *   - ADX < adxRangingThreshold   → "ranging"    → mean-reversion (buy lower
 *                                                   band, sell upper band).
 *   - ADX > adxTrendingThreshold  → "trending"   → breakout (buy above upper,
 *                                                   sell below lower).
 *   - in-between                  → "unknown"    → do not open new positions
 *                                                   (existing position stays
 *                                                   open until SL/TP fires).
 *
 * Exits are governed by static bps-based SL/TP from entry. For ranging
 * positions, a hit of the BB middle line is treated as the take-profit
 * trigger (typically a tighter exit than the bps target).
 *
 * Caller is responsible for kline-cache refresh and supplies highs / lows /
 * closes oldest-first.
 */

import { computeAdx } from "../indicators/adx";
import { computeBollinger } from "../indicators/bollinger";

export type BollingerAdxRegime = "ranging" | "trending" | "unknown";

export interface BollingerAdxKlineCache {
  symbol: string;
  fetchedAt: number;
  highs: number[];
  lows: number[];
  closes: number[];
}

export interface BollingerAdxPosition {
  side: "long" | "short";
  entryPrice: number;
}

export interface BollingerAdxInput {
  klineCache: BollingerAdxKlineCache | null;
  position: BollingerAdxPosition | null;
  symbol: string;
  /** Latest tick price — used for entry/exit triggers. Falls back to last close. */
  currentPrice: number;
  now: number;
  refreshSec: number;
  bbPeriod: number;
  bbStdDev: number;
  adxPeriod: number;
  adxRangingThreshold: number;
  adxTrendingThreshold: number;
  stopLossBps: number;
  takeProfitBps: number;
}

export type BollingerAdxDecision =
  | {
      kind: "enter";
      side: "long" | "short";
      regime: BollingerAdxRegime;
      reason: string;
    }
  | {
      kind: "exit";
      reason: "take-profit" | "stop-loss" | "regime-changed";
      currentPrice: number;
    }
  | {
      kind: "hold";
      reason: string;
      regime: BollingerAdxRegime;
    };

function classifyRegime(
  adx: number,
  rangingThreshold: number,
  trendingThreshold: number,
): BollingerAdxRegime {
  if (adx < rangingThreshold) return "ranging";
  if (adx > trendingThreshold) return "trending";
  return "unknown";
}

export function bollingerAdxDecide(input: BollingerAdxInput): BollingerAdxDecision {
  // Cache / freshness checks.
  const cacheOk =
    input.klineCache !== null
    && input.klineCache.symbol === input.symbol
    && (input.now - input.klineCache.fetchedAt) < input.refreshSec * 1000;
  if (!cacheOk) {
    return { kind: "hold", reason: "needs-refresh", regime: "unknown" };
  }
  const cache = input.klineCache as BollingerAdxKlineCache;

  const bb = computeBollinger(cache.closes, input.bbPeriod, input.bbStdDev);
  const adx = computeAdx({
    highs: cache.highs,
    lows: cache.lows,
    closes: cache.closes,
    period: input.adxPeriod,
  });
  if (bb === null || adx === null) {
    return { kind: "hold", reason: "warmup", regime: "unknown" };
  }

  const regime = classifyRegime(
    adx.adx,
    input.adxRangingThreshold,
    input.adxTrendingThreshold,
  );
  const price = input.currentPrice;

  // ── In-position branch: SL / TP take precedence over signal. ───────────
  if (input.position !== null) {
    const pos = input.position;
    const slPriceLong = pos.entryPrice * (1 - input.stopLossBps / 10_000);
    const slPriceShort = pos.entryPrice * (1 + input.stopLossBps / 10_000);
    const tpPriceLongBps = pos.entryPrice * (1 + input.takeProfitBps / 10_000);
    const tpPriceShortBps = pos.entryPrice * (1 - input.takeProfitBps / 10_000);

    if (pos.side === "long" && price <= slPriceLong) {
      return { kind: "exit", reason: "stop-loss", currentPrice: price };
    }
    if (pos.side === "short" && price >= slPriceShort) {
      return { kind: "exit", reason: "stop-loss", currentPrice: price };
    }

    // Take-profit:
    //   - in ranging regime → exit when price crosses BB midline (typically
    //     earlier and tighter than the bps target).
    //   - in any regime → exit on bps target hit.
    if (regime === "ranging") {
      if (pos.side === "long" && price >= bb.middle) {
        return { kind: "exit", reason: "take-profit", currentPrice: price };
      }
      if (pos.side === "short" && price <= bb.middle) {
        return { kind: "exit", reason: "take-profit", currentPrice: price };
      }
    }
    if (pos.side === "long" && price >= tpPriceLongBps) {
      return { kind: "exit", reason: "take-profit", currentPrice: price };
    }
    if (pos.side === "short" && price <= tpPriceShortBps) {
      return { kind: "exit", reason: "take-profit", currentPrice: price };
    }
    return { kind: "hold", reason: "in-position", regime };
  }

  // ── Flat branch: open only in a clearly classified regime. ─────────────
  if (regime === "unknown") {
    return { kind: "hold", reason: "transitional-regime", regime };
  }

  if (regime === "ranging") {
    if (price <= bb.lower) {
      return {
        kind: "enter",
        side: "long",
        regime,
        reason: `bb-adx-ranging-revert-long:adx=${adx.adx.toFixed(2)}`,
      };
    }
    if (price >= bb.upper) {
      return {
        kind: "enter",
        side: "short",
        regime,
        reason: `bb-adx-ranging-revert-short:adx=${adx.adx.toFixed(2)}`,
      };
    }
    return { kind: "hold", reason: "ranging-no-edge", regime };
  }

  // regime === "trending"
  if (price > bb.upper) {
    return {
      kind: "enter",
      side: "long",
      regime,
      reason: `bb-adx-trending-breakout-long:adx=${adx.adx.toFixed(2)}`,
    };
  }
  if (price < bb.lower) {
    return {
      kind: "enter",
      side: "short",
      regime,
      reason: `bb-adx-trending-breakout-short:adx=${adx.adx.toFixed(2)}`,
    };
  }
  return { kind: "hold", reason: "trending-no-breakout", regime };
}
