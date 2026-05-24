/**
 * Backtest engine. Replays historical klines as synthetic ticks against a
 * pure decision function, simulating SL/TP intra-kline and round-trip fees.
 *
 * Scope (v1):
 *   - ma-crossover, longer-tf (delegate to longerTfSignal)
 *   - All other strategy types are accepted but treated as `flat`-only,
 *     producing zero trades. They serve as schema validation only — full
 *     wiring is a follow-up. (Anthropic-driven `llm-managed` is explicitly
 *     skipped: replaying it would cost real $$ per backtest tick.)
 *
 * Design:
 *   - Pure: depends only on a `fetchKlines` function — no Bybit, no Redis.
 *   - Deterministic: no Date.now(), no I/O outside `fetchKlines`.
 *   - SL/TP simulation: if a kline's [low,high] range crosses SL or TP, we
 *     exit at that level instead of the close (worst-case for SL, best-case
 *     for TP — caller can tighten by setting both magnitudes equal).
 */

import type { MarketKline } from "@ai-scalper/bybit-client";
import { buildSignal } from "@ai-scalper/trading-core";

export type BacktestStrategyType =
  | "ma-crossover"
  | "longer-tf"
  | "bollinger-adx"
  | "funding-arb"
  | "basis-arb"
  | "pairs-trading"
  | "calendar-spread";

export interface BacktestRiskParams {
  orderUsd: number;
  leverage: number;
  stopLossBps: number;
  takeProfitBps: number;
  maxPositionUsd: number;
  feeRoundTripBps: number;
}

export interface BacktestScenario {
  name: string;
  strategyType: BacktestStrategyType;
  symbol: string;
  klineInterval: string;
  startDate: string;
  endDate: string;
  strategyParams: Record<string, unknown>;
  riskParams: BacktestRiskParams;
}

export interface BacktestTrade {
  openedAt: string;
  closedAt: string;
  side: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  qty: number;
  grossPnl: number;
  feeUsd: number;
  netPnl: number;
  exitReason: string;
}

export interface BacktestResult {
  scenario: BacktestScenario;
  totalTicks: number;
  tradesOpened: number;
  tradesClosed: number;
  wins: number;
  losses: number;
  winRate: number;
  grossPnlUsd: number;
  feesUsd: number;
  netPnlUsd: number;
  maxDrawdownUsd: number;
  sharpeAnnualizedScalp: number;
  trades: BacktestTrade[];
}

export interface BacktestDeps {
  fetchKlines: (params: {
    symbol: string;
    interval: string;
    start: number;
    end: number;
  }) => Promise<MarketKline[]>;
}

interface OpenSimPosition {
  side: "long" | "short";
  entryPrice: number;
  qty: number;
  notionalUsd: number;
  openedAt: number;
  stopLossPrice: number;
  takeProfitPrice: number;
}

/** Compute realized PnL of a closed sim position before fees. */
function grossPnlOf(pos: OpenSimPosition, exitPrice: number): number {
  return pos.side === "long"
    ? (exitPrice - pos.entryPrice) * pos.qty
    : (pos.entryPrice - exitPrice) * pos.qty;
}

/** Round-trip fee on a notional position close. */
function feeOf(notionalUsd: number, feeRoundTripBps: number): number {
  return notionalUsd * (feeRoundTripBps / 10_000);
}

function computeSharpe(pnls: number[]): number {
  if (pnls.length < 2) return 0;
  const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const variance = pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / pnls.length;
  const stddev = Math.sqrt(variance);
  if (stddev === 0) return 0;
  // Annualization factor for ~per-tick PnL series; matches the legacy
  // computeReport's `sqrt(252 * 24)` heuristic for hourly-equivalent samples.
  return (mean / stddev) * Math.sqrt(252 * 24);
}

function computeMaxDrawdown(cumPnl: number[]): number {
  let peak = -Infinity;
  let maxDD = 0;
  for (const v of cumPnl) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

/**
 * Decide the next action given a price history. Pure; returns `flat` for
 * unsupported strategies in v1 (TODO: wire bollinger-adx, funding-arb, etc.).
 */
function decideAction(
  strategyType: BacktestStrategyType,
  prices: number[],
  params: Record<string, unknown>,
): "long" | "short" | "flat" {
  switch (strategyType) {
    case "ma-crossover":
    case "longer-tf": {
      const fastWindow = Number(params.fastWindow ?? 5);
      const slowWindow = Number(params.slowWindow ?? 20);
      const thresholdBps = Number(params.thresholdBps ?? 4);
      if (prices.length < slowWindow) return "flat";
      return buildSignal({ prices, fastWindow, slowWindow, thresholdBps });
    }
    default:
      // TODO: wire bollinger-adx, funding-arb, basis-arb, pairs-trading,
      // calendar-spread. These need richer per-kline context (ADX, funding
      // rate, second-leg klines). v1 returns flat → zero trades, intended.
      return "flat";
  }
}

export async function runBacktest(
  scenario: BacktestScenario,
  deps: BacktestDeps,
): Promise<BacktestResult> {
  const start = Date.parse(scenario.startDate);
  const end = Date.parse(scenario.endDate);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new Error(
      `Invalid backtest date range: ${scenario.startDate}..${scenario.endDate}`,
    );
  }

  const klines = await deps.fetchKlines({
    symbol: scenario.symbol,
    interval: scenario.klineInterval,
    start,
    end,
  });

  // Bybit returns klines newest-first; sort oldest-first for replay.
  const sorted = [...klines].sort((a, b) => Number(a.startTime) - Number(b.startTime));

  const trades: BacktestTrade[] = [];
  const closedPnls: number[] = [];
  const cumPnl: number[] = [];
  let cumulative = 0;

  const prices: number[] = [];
  let position: OpenSimPosition | null = null;
  let tradesOpened = 0;

  for (const k of sorted) {
    const close = Number(k.closePrice);
    const high = Number(k.highPrice);
    const low = Number(k.lowPrice);
    const ts = Number(k.startTime);

    prices.push(close);
    // Match the live trader's behaviour: keep slow-window worth of prices.
    const slowWindow = Number(scenario.strategyParams.slowWindow ?? 20);
    if (prices.length > slowWindow * 4) prices.shift(); // keep a small surplus

    // 1. SL / TP check intra-kline (high/low precedence).
    if (position) {
      const slHit = position.side === "long"
        ? low <= position.stopLossPrice
        : high >= position.stopLossPrice;
      const tpHit = position.side === "long"
        ? high >= position.takeProfitPrice
        : low <= position.takeProfitPrice;

      // If both hit in the same kline, pessimistically assume SL fired first.
      let exitPrice: number | null = null;
      let exitReason = "";
      if (slHit) {
        exitPrice = position.stopLossPrice;
        exitReason = "stop-loss";
      } else if (tpHit) {
        exitPrice = position.takeProfitPrice;
        exitReason = "take-profit";
      }

      if (exitPrice !== null) {
        const gross = grossPnlOf(position, exitPrice);
        const fee = feeOf(position.notionalUsd, scenario.riskParams.feeRoundTripBps);
        const net = gross - fee;
        trades.push({
          openedAt: new Date(position.openedAt).toISOString(),
          closedAt: new Date(ts).toISOString(),
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice,
          qty: position.qty,
          grossPnl: gross,
          feeUsd: fee,
          netPnl: net,
          exitReason,
        });
        closedPnls.push(net);
        cumulative += net;
        cumPnl.push(cumulative);
        position = null;
      }
    }

    // 2. Decide next action from updated price window.
    const action = decideAction(scenario.strategyType, prices, scenario.strategyParams);

    // 3. Open a new position if signal fires and we're flat.
    if (!position && (action === "long" || action === "short")) {
      const notional = Math.min(
        scenario.riskParams.orderUsd * scenario.riskParams.leverage,
        scenario.riskParams.maxPositionUsd,
      );
      if (notional > 0 && close > 0) {
        const qty = notional / close;
        const slMult = scenario.riskParams.stopLossBps / 10_000;
        const tpMult = scenario.riskParams.takeProfitBps / 10_000;
        position = {
          side: action,
          entryPrice: close,
          qty,
          notionalUsd: notional,
          openedAt: ts,
          stopLossPrice: action === "long"
            ? close * (1 - slMult)
            : close * (1 + slMult),
          takeProfitPrice: action === "long"
            ? close * (1 + tpMult)
            : close * (1 - tpMult),
        };
        tradesOpened += 1;
      }
    }
  }

  // Flatten any still-open position at the last close.
  if (position && sorted.length > 0) {
    const lastK = sorted[sorted.length - 1]!;
    const exitPrice = Number(lastK.closePrice);
    const ts = Number(lastK.startTime);
    const gross = grossPnlOf(position, exitPrice);
    const fee = feeOf(position.notionalUsd, scenario.riskParams.feeRoundTripBps);
    const net = gross - fee;
    trades.push({
      openedAt: new Date(position.openedAt).toISOString(),
      closedAt: new Date(ts).toISOString(),
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice,
      qty: position.qty,
      grossPnl: gross,
      feeUsd: fee,
      netPnl: net,
      exitReason: "end-of-data",
    });
    closedPnls.push(net);
    cumulative += net;
    cumPnl.push(cumulative);
    position = null;
  }

  const wins = trades.filter((t) => t.netPnl > 0).length;
  const losses = trades.filter((t) => t.netPnl < 0).length;
  const grossPnlUsd = trades.reduce((a, t) => a + t.grossPnl, 0);
  const feesUsd = trades.reduce((a, t) => a + t.feeUsd, 0);
  const netPnlUsd = trades.reduce((a, t) => a + t.netPnl, 0);

  return {
    scenario,
    totalTicks: sorted.length,
    tradesOpened,
    tradesClosed: trades.length,
    wins,
    losses,
    winRate: trades.length > 0 ? wins / trades.length : 0,
    grossPnlUsd,
    feesUsd,
    netPnlUsd,
    maxDrawdownUsd: computeMaxDrawdown(cumPnl),
    sharpeAnnualizedScalp: computeSharpe(closedPnls),
    trades,
  };
}
