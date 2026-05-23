import type { InstrumentInfo, MarketTicker } from "@ai-scalper/bybit-client";
import {
  buildSignal,
  evaluateAggressivePerpsRisk,
  evaluateRisk,
  getExitReason,
  rolloverDailyPnlIfNeeded,
  updatePaperState,
  type AggressivePerpsLimits,
  type ExitReason,
  type StrategySignal,
  type TraderState,
} from "@ai-scalper/trading-core";

/**
 * Pure-strategy step parameters. A subset of TraderConfig — only the knobs
 * that vary across meta-strategy variants (signal/exit) plus the standard
 * risk guards. No I/O knobs (orderUsd is used to compute notional only).
 */
export interface StepParams {
  fastWindow: number;
  slowWindow: number;
  thresholdBps: number;
  stopLossBps: number;
  takeProfitBps: number;
  leverage: number;
  orderUsd: number;
  maxPositionUsd: number;
  maxDailyLossUsd: number;
  maxSpreadBps: number;
  minTradeIntervalMs: number;
}

export interface StepContext {
  symbol: string;
  ticker: MarketTicker;
  instrument: InstrumentInfo;
  now: number;
  /**
   * Variant-local price window. Mutated in place by step: lastPrice is pushed,
   * then truncated to slowWindow. Callers own one of these per variant.
   */
  priceHistory: number[];
  /**
   * Optional aggressive-perps limits. When provided, the per-variant decision
   * AND-gates the standard risk result with `evaluateAggressivePerpsRisk` using
   * the variant's own leverage/orderUsd (so high-leverage variants get checked
   * against their own notional and liq-buffer). When omitted, only standard
   * risk is applied — i.e., the v1 behaviour.
   */
  aggressivePerpsLimits?: AggressivePerpsLimits;
  /** Funding rate (bps) at this tick. Required iff aggressivePerpsLimits is set. */
  fundingRateBps?: number;
}

export interface StepResult {
  state: TraderState;
  action: StrategySignal;
  exitReason: ExitReason | null;
  riskReason: string;
  fillPrice: number | null;
}

export interface DecideStepResult {
  action: StrategySignal;
  exitReason: ExitReason | null;
  riskReason: string;
  notionalUsd: number;
}

function toNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value: ${value}`);
  }
  return parsed;
}

/**
 * Pure decision helper. Updates ctx.priceHistory in place, then returns the
 * strategy decisions (signal, exit, standard-risk reason) WITHOUT mutating
 * state. Used by both step() and the live run-trader loop so the decision
 * logic has a single source of truth.
 *
 * Note: this only computes the standard risk reason. Aggressive-perps risk
 * and exceptional-leverage decisions remain in the loop.
 */
export function decideStep(
  ctx: StepContext,
  params: StepParams,
  state: TraderState,
): DecideStepResult {
  const lastPrice = toNumber(ctx.ticker.lastPrice);
  const markPrice = toNumber(ctx.ticker.markPrice);

  ctx.priceHistory.push(lastPrice);
  if (ctx.priceHistory.length > params.slowWindow) {
    ctx.priceHistory.shift();
  }

  const action = buildSignal({
    prices: ctx.priceHistory,
    fastWindow: params.fastWindow,
    slowWindow: params.slowWindow,
    thresholdBps: params.thresholdBps,
  });

  const exitReason = getExitReason({
    marketPrice: lastPrice,
    signal: action,
    state,
  });

  const notionalUsd = params.orderUsd * params.leverage;

  // Predict standard risk against the state *after* a hypothetical exit, so
  // the reported riskReason reflects what an entry would face this tick.
  const stateAfterExit: TraderState =
    state.position && exitReason
      ? {
          ...state,
          lastTradeAt: ctx.now,
          position: null,
        }
      : state;

  const risk = evaluateRisk({
    action,
    limits: {
      maxPositionUsd: params.maxPositionUsd,
      maxDailyLossUsd: params.maxDailyLossUsd,
      minTradeIntervalMs: params.minTradeIntervalMs,
      maxSpreadBps: params.maxSpreadBps,
    },
    market: { lastPrice, markPrice },
    now: ctx.now,
    orderUsd: notionalUsd,
    state: stateAfterExit,
  });

  // AND-gate with aggressive-perps risk when caller opts in. Variant's own
  // leverage drives the liq-buffer check, so high-leverage variants are held
  // to the same caps as the live aggressive profile.
  let riskReason: string = risk.allowed ? "allowed" : risk.reason;
  if (riskReason === "allowed" && ctx.aggressivePerpsLimits) {
    const aggressive = evaluateAggressivePerpsRisk({
      symbol: ctx.symbol,
      leverage: params.leverage,
      fundingRateBps: ctx.fundingRateBps ?? 0,
      notionalUsd,
      stopLossBps: params.stopLossBps,
      limits: ctx.aggressivePerpsLimits,
    });
    if (!aggressive.allowed) {
      riskReason = aggressive.reason;
    }
  }

  return {
    action,
    exitReason,
    riskReason,
    notionalUsd,
  };
}

/**
 * Pure strategy step. No I/O: no console.log, no Bun.write, no Date.now().
 * Uses ctx.now for all time references. Mutates ctx.priceHistory in place
 * (push + truncate) but otherwise returns a new state.
 *
 * Semantics (mirrors run-trader for the standard profile):
 *   1. Roll over daily PnL.
 *   2. Push ticker.lastPrice into priceHistory, truncate to slowWindow.
 *   3. Run buildSignal.
 *   4. If a position is open and getExitReason fires, close it via
 *      updatePaperState({reduceOnly:true}) using lastPrice as the fill.
 *   5. After exit (or if no position), evaluateRisk; if allowed AND signal
 *      is non-flat AND no position remains, open via updatePaperState.
 *   6. Returns the final state.
 *
 * Aggressive-perps risk and exceptional-leverage selection are NOT applied
 * here — v1 scope is the standard variant only.
 */
export function step(
  ctx: StepContext,
  params: StepParams,
  state: TraderState,
): StepResult {
  let nextState = rolloverDailyPnlIfNeeded(state, ctx.now);

  const decision = decideStep(ctx, params, nextState);
  const lastPrice = toNumber(ctx.ticker.lastPrice);

  let fillPrice: number | null = null;

  if (nextState.position && decision.exitReason) {
    const closeAction: Exclude<StrategySignal, "flat"> =
      nextState.position.side === "long" ? "short" : "long";
    nextState = updatePaperState({
      action: closeAction,
      leverage: params.leverage,
      notionalUsd: nextState.position.notionalUsd,
      price: lastPrice,
      previous: nextState,
      now: ctx.now,
      stopLossBps: params.stopLossBps,
      takeProfitBps: params.takeProfitBps,
      reduceOnly: true,
    });
    fillPrice = lastPrice;
  }

  if (
    decision.action !== "flat" &&
    !nextState.position &&
    decision.riskReason === "allowed"
  ) {
    nextState = updatePaperState({
      action: decision.action,
      leverage: params.leverage,
      notionalUsd: decision.notionalUsd,
      price: lastPrice,
      previous: nextState,
      now: ctx.now,
      stopLossBps: params.stopLossBps,
      takeProfitBps: params.takeProfitBps,
    });
    fillPrice = lastPrice;
  }

  return {
    state: nextState,
    action: decision.action,
    exitReason: decision.exitReason,
    riskReason: decision.riskReason,
    fillPrice,
  };
}
