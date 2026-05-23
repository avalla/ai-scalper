export { resolveProjectPath } from "./paths";

export type StrategySnapshot = {
  prices: number[];
  fastWindow: number;
  slowWindow: number;
  thresholdBps: number;
};

export type StrategySignal = "long" | "short" | "flat";

export type RiskLimits = {
  maxPositionUsd: number;
  maxDailyLossUsd: number;
  minTradeIntervalMs: number;
  maxSpreadBps: number;
};

export type PositionSide = Exclude<StrategySignal, "flat">;

export interface OpenPosition {
  side: PositionSide;
  quantity: number;
  notionalUsd: number;
  entryPrice: number;
  leverage: number;
  openedAt: number;
  stopLossPrice: number;
  takeProfitPrice: number;
}

export type TraderState = {
  lastTradeAt: number | null;
  realizedPnlUsd: number;
  position: OpenPosition | null;
  dayStartedAt: number | null;
};

export type MarketSnapshot = {
  lastPrice: number;
  markPrice: number;
};

export type RiskDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export type ExitReason = "take-profit" | "stop-loss" | "signal-reversal";

export interface ScalpCandidateInput {
  symbol: string;
  lastPrice: number;
  bidPrice: number;
  askPrice: number;
  turnover24h: number;
  openInterestValue: number;
  price24hPcnt: number;
  prevPrice1h: number;
  fundingRate: number;
  maxLeverage: number;
  minuteRangeBps: number;
  estimatedRoundTripCostBps?: number;
  minNetEdgeBps?: number;
}

export interface ScalpCandidate {
  symbol: string;
  score: number;
  spreadBps: number;
  hourlyMoveBps: number;
  dailyMoveBps: number;
  minuteRangeBps: number;
  turnover24h: number;
  openInterestValue: number;
  fundingRateBps: number;
  maxLeverage: number;
  estimatedRoundTripCostBps: number;
  netEdgeBps: number;
  summary: string;
}

export interface AggressivePerpsLimits {
  maxLeverage: number;
  maxFundingRateBps: number;
  maxLossPerTradeUsd: number;
  minEstimatedLiqBufferBps: number;
  allowedSymbols: string[];
}

export interface ExceptionalLeveragePolicy {
  allowedSymbols: string[];
  exceptionalLeverage: number;
  maxSpreadBps: number;
  maxFundingRateBps: number;
  minHourlyMoveBps: number;
  minMinuteRangeBps: number;
  minNetEdgeBps: number;
}

function utcDayKey(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

export function rolloverDailyPnlIfNeeded(state: TraderState, now: number): TraderState {
  if (state.dayStartedAt === null) {
    return { ...state, dayStartedAt: now };
  }
  if (utcDayKey(state.dayStartedAt) === utcDayKey(now)) {
    return state;
  }
  return { ...state, realizedPnlUsd: 0, dayStartedAt: now };
}

function average(values: number[]): number {
  if (values.length === 0) {
    throw new Error("Cannot average an empty array");
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function basisPoints(delta: number, reference: number): number {
  if (reference === 0) {
    throw new Error("Reference price cannot be zero");
  }
  return (delta / reference) * 10_000;
}

function clampScore(value: number, min = 0, max = 100): number {
  return Math.min(Math.max(value, min), max);
}

function exitPrice(entryPrice: number, basisPointsValue: number, multiplier: number): number {
  return entryPrice * (1 + ((basisPointsValue / 10_000) * multiplier));
}

function realizedPnl(position: OpenPosition, exitPriceValue: number): number {
  const priceDelta = exitPriceValue - position.entryPrice;
  const signedDelta = position.side === "long" ? priceDelta : -priceDelta;
  return signedDelta * position.quantity;
}

export function buildSignal(snapshot: StrategySnapshot): StrategySignal {
  if (snapshot.prices.length < snapshot.slowWindow) {
    return "flat";
  }

  const fastSlice = snapshot.prices.slice(-snapshot.fastWindow);
  const slowSlice = snapshot.prices.slice(-snapshot.slowWindow);
  const fastAverage = average(fastSlice);
  const slowAverage = average(slowSlice);
  const spreadBps = basisPoints(fastAverage - slowAverage, slowAverage);

  if (spreadBps >= snapshot.thresholdBps) {
    return "long";
  }
  if (spreadBps <= -snapshot.thresholdBps) {
    return "short";
  }
  return "flat";
}

export function evaluateRisk(params: {
  action: StrategySignal;
  limits: RiskLimits;
  market: MarketSnapshot;
  now: number;
  orderUsd: number;
  state: TraderState;
}): RiskDecision {
  const { action, limits, market, now, orderUsd, state } = params;

  if (action === "flat") {
    return { allowed: false, reason: "signal-flat" };
  }

  if (state.lastTradeAt && now - state.lastTradeAt < limits.minTradeIntervalMs) {
    return { allowed: false, reason: "cooldown-active" };
  }

  const sameUtcDay =
    state.dayStartedAt !== null && utcDayKey(state.dayStartedAt) === utcDayKey(now);
  if (sameUtcDay && state.realizedPnlUsd <= -limits.maxDailyLossUsd) {
    return { allowed: false, reason: "daily-loss-limit" };
  }

  const spreadBps = Math.abs(basisPoints(market.lastPrice - market.markPrice, market.markPrice));
  if (spreadBps > limits.maxSpreadBps) {
    return { allowed: false, reason: "spread-too-wide" };
  }

  const openExposureUsd = state.position?.notionalUsd ?? 0;
  if (openExposureUsd + orderUsd > limits.maxPositionUsd) {
    return { allowed: false, reason: "position-limit" };
  }

  return { allowed: true };
}

export function getExitReason(params: {
  marketPrice: number;
  signal: StrategySignal;
  state: TraderState;
}): ExitReason | null {
  const { marketPrice, signal, state } = params;
  const { position } = state;

  if (!position) {
    return null;
  }

  if (position.side === "long") {
    if (marketPrice >= position.takeProfitPrice) {
      return "take-profit";
    }
    if (marketPrice <= position.stopLossPrice) {
      return "stop-loss";
    }
    if (signal === "short") {
      return "signal-reversal";
    }
    return null;
  }

  if (marketPrice <= position.takeProfitPrice) {
    return "take-profit";
  }
  if (marketPrice >= position.stopLossPrice) {
    return "stop-loss";
  }
  if (signal === "long") {
    return "signal-reversal";
  }
  return null;
}

export function buildPositionTargets(params: {
  action: PositionSide;
  price: number;
  stopLossBps: number;
  takeProfitBps: number;
}): {
  stopLossPrice: number;
  takeProfitPrice: number;
} {
  const sideMultiplier = params.action === "long" ? 1 : -1;

  return {
    stopLossPrice: exitPrice(params.price, params.stopLossBps, -sideMultiplier),
    takeProfitPrice: exitPrice(params.price, params.takeProfitBps, sideMultiplier),
  };
}

export function updatePaperState(params: {
  action: PositionSide;
  leverage: number;
  notionalUsd: number;
  price: number;
  previous: TraderState;
  now: number;
  stopLossBps: number;
  takeProfitBps: number;
  reduceOnly?: boolean;
}): TraderState {
  const previous = rolloverDailyPnlIfNeeded(params.previous, params.now);
  const previousPosition = previous.position;

  if (params.reduceOnly) {
    if (!previousPosition) {
      return previous;
    }

    return {
      lastTradeAt: params.now,
      realizedPnlUsd: previous.realizedPnlUsd + realizedPnl(previousPosition, params.price),
      position: null,
      dayStartedAt: previous.dayStartedAt,
    };
  }

  const quantity = params.notionalUsd / params.price;
  const targets = buildPositionTargets({
    action: params.action,
    price: params.price,
    stopLossBps: params.stopLossBps,
    takeProfitBps: params.takeProfitBps,
  });

  return {
    lastTradeAt: params.now,
    realizedPnlUsd: previous.realizedPnlUsd,
    dayStartedAt: previous.dayStartedAt,
    position: {
      side: params.action,
      quantity,
      notionalUsd: params.notionalUsd,
      entryPrice: params.price,
      leverage: params.leverage,
      openedAt: params.now,
      stopLossPrice: targets.stopLossPrice,
      takeProfitPrice: targets.takeProfitPrice,
    },
  };
}

export function scoreScalpCandidate(input: ScalpCandidateInput): ScalpCandidate | null {
  if (input.bidPrice <= 0 || input.askPrice <= 0 || input.lastPrice <= 0) {
    return null;
  }

  const midPrice = (input.bidPrice + input.askPrice) / 2;
  const spreadBps = basisPoints(input.askPrice - input.bidPrice, midPrice);
  const hourlyMoveBps = Math.abs(basisPoints(input.lastPrice - input.prevPrice1h, input.prevPrice1h));
  const dailyMoveBps = Math.abs(input.price24hPcnt * 10_000);
  const fundingRateBps = input.fundingRate * 10_000;
  const estimatedRoundTripCostBps = input.estimatedRoundTripCostBps ?? 16;
  const minNetEdgeBps = input.minNetEdgeBps ?? 4;
  const netEdgeBps = input.minuteRangeBps - estimatedRoundTripCostBps - spreadBps;

  if (input.turnover24h < 2_000_000) {
    return null;
  }

  if (spreadBps > 12) {
    return null;
  }

  if (netEdgeBps < minNetEdgeBps) {
    return null;
  }

  const liquidityScore = clampScore((input.turnover24h / 50_000_000) * 35, 0, 35);
  const openInterestScore = clampScore((input.openInterestValue / 20_000_000) * 20, 0, 20);
  const spreadScore = clampScore(20 - (spreadBps * 1.5), 0, 20);
  const momentumScore = clampScore((hourlyMoveBps / 60) * 10, 0, 10);
  const intradayScore = clampScore((dailyMoveBps / 300) * 5, 0, 5);
  const microVolatilityScore = clampScore((input.minuteRangeBps / 25) * 8, 0, 8);
  const edgeScore = clampScore((netEdgeBps / 20) * 8, 0, 8);
  const leverageScore = clampScore((Math.min(input.maxLeverage, 50) / 50) * 4, 0, 4);
  const fundingPenalty = clampScore(Math.max(Math.abs(fundingRateBps) - 1, 0) * 2, 0, 10);
  const score = Number(clampScore(
    liquidityScore +
    openInterestScore +
    spreadScore +
    momentumScore +
    intradayScore +
    microVolatilityScore +
    edgeScore +
    leverageScore -
    fundingPenalty,
  ).toFixed(2));

  return {
    symbol: input.symbol,
    score,
    spreadBps: Number(spreadBps.toFixed(2)),
    hourlyMoveBps: Number(hourlyMoveBps.toFixed(2)),
    dailyMoveBps: Number(dailyMoveBps.toFixed(2)),
    minuteRangeBps: Number(input.minuteRangeBps.toFixed(2)),
    turnover24h: input.turnover24h,
    openInterestValue: input.openInterestValue,
    fundingRateBps: Number(fundingRateBps.toFixed(4)),
    maxLeverage: input.maxLeverage,
    estimatedRoundTripCostBps: Number(estimatedRoundTripCostBps.toFixed(2)),
    netEdgeBps: Number(netEdgeBps.toFixed(2)),
    summary: [
      `spread ${spreadBps.toFixed(2)}bps`,
      `1h move ${hourlyMoveBps.toFixed(0)}bps`,
      `1m range ${input.minuteRangeBps.toFixed(0)}bps`,
      `net edge ${netEdgeBps.toFixed(1)}bps`,
      `24h turnover ${Math.round(input.turnover24h / 1_000_000)}M`,
    ].join(", "),
  };
}

export function evaluateAggressivePerpsRisk(params: {
  symbol: string;
  leverage: number;
  fundingRateBps: number;
  notionalUsd: number;
  stopLossBps: number;
  limits: AggressivePerpsLimits;
}): RiskDecision {
  const { symbol, leverage, fundingRateBps, notionalUsd, stopLossBps, limits } = params;

  if (limits.allowedSymbols.length > 0 && !limits.allowedSymbols.includes(symbol)) {
    return { allowed: false, reason: "symbol-not-allowed" };
  }

  if (leverage > limits.maxLeverage) {
    return { allowed: false, reason: "leverage-too-high" };
  }

  if (Math.abs(fundingRateBps) > limits.maxFundingRateBps) {
    return { allowed: false, reason: "funding-too-high" };
  }

  const estimatedLossAtStopUsd = notionalUsd * (stopLossBps / 10_000);
  if (estimatedLossAtStopUsd > limits.maxLossPerTradeUsd) {
    return { allowed: false, reason: "loss-per-trade-limit" };
  }

  const estimatedLiquidationDistanceBps = 10_000 / leverage;
  const estimatedBufferAfterStopBps = estimatedLiquidationDistanceBps - stopLossBps;
  if (estimatedBufferAfterStopBps < limits.minEstimatedLiqBufferBps) {
    return { allowed: false, reason: "liq-buffer-too-small" };
  }

  return { allowed: true };
}

// ---------- Phase 1A: Trailing stop ----------

export function computeTrailingStop(params: {
  position: OpenPosition;
  marketPrice: number;
  activationBps: number;
  trailBps: number;
}): { newStopLossPrice: number | null; reason: "below-activation" | "trailing" } {
  const { position, marketPrice, activationBps, trailBps } = params;
  const entry = position.entryPrice;

  if (position.side === "long") {
    const activationPrice = entry * (1 + activationBps / 10_000);
    if (marketPrice < activationPrice) {
      return { newStopLossPrice: null, reason: "below-activation" };
    }
    const candidate = marketPrice * (1 - trailBps / 10_000);
    const newStop = Math.max(position.stopLossPrice, candidate);
    return { newStopLossPrice: newStop, reason: "trailing" };
  }

  // short
  const activationPrice = entry * (1 - activationBps / 10_000);
  if (marketPrice > activationPrice) {
    return { newStopLossPrice: null, reason: "below-activation" };
  }
  const candidate = marketPrice * (1 + trailBps / 10_000);
  const newStop = Math.min(position.stopLossPrice, candidate);
  return { newStopLossPrice: newStop, reason: "trailing" };
}

// ---------- Phase 1A: Drawdown-velocity guard ----------

export interface DrawdownVelocityState {
  recentPnlSamples: Array<{ ts: number; cumulativePnlUsd: number }>;
}

export function recordPnlSample(
  state: DrawdownVelocityState,
  now: number,
  cumulativePnlUsd: number,
  windowMs: number,
): DrawdownVelocityState {
  const cutoff = now - windowMs;
  const filtered = state.recentPnlSamples.filter((s) => s.ts >= cutoff);
  filtered.push({ ts: now, cumulativePnlUsd });
  return { recentPnlSamples: filtered };
}

export function evaluateDrawdownVelocity(
  state: DrawdownVelocityState,
  params: {
    now: number;
    windowMs: number;
    maxDrawdownInWindowUsd: number;
    maxConsecutiveLosses?: number;
    closedTradeOutcomes?: Array<"win" | "loss">;
  },
): { halted: boolean; reason: string | null } {
  const cutoff = params.now - params.windowMs;
  const inWindow = state.recentPnlSamples.filter((s) => s.ts >= cutoff);
  if (inWindow.length > 0) {
    const peak = Math.max(...inWindow.map((s) => s.cumulativePnlUsd));
    const current = inWindow[inWindow.length - 1]!.cumulativePnlUsd;
    if (peak - current > params.maxDrawdownInWindowUsd) {
      return { halted: true, reason: "drawdown-velocity" };
    }
  }

  if (
    params.maxConsecutiveLosses !== undefined &&
    params.maxConsecutiveLosses > 0 &&
    params.closedTradeOutcomes &&
    params.closedTradeOutcomes.length >= params.maxConsecutiveLosses
  ) {
    const tail = params.closedTradeOutcomes.slice(-params.maxConsecutiveLosses);
    if (tail.every((o) => o === "loss")) {
      return { halted: true, reason: "consecutive-losses" };
    }
  }

  return { halted: false, reason: null };
}

// ---------- Phase 1A: Position reconciliation ----------

export function reconcilePositions(params: {
  expected: OpenPosition | null;
  observed: { side: "Buy" | "Sell"; size: number; avgPrice: number } | null;
  tolerance?: number;
}): {
  aligned: boolean;
  drift: "missing-on-exchange" | "extra-on-exchange" | "side-mismatch" | "size-mismatch" | null;
  details?: string;
} {
  const tolerance = params.tolerance ?? 1e-6;
  const { expected, observed } = params;

  if (!expected && !observed) {
    return { aligned: true, drift: null };
  }
  if (expected && !observed) {
    return { aligned: false, drift: "missing-on-exchange", details: "expected position not present on exchange" };
  }
  if (!expected && observed) {
    return { aligned: false, drift: "extra-on-exchange", details: `unexpected ${observed.side} ${observed.size} on exchange` };
  }
  // both present
  const expectedSide = expected!.side === "long" ? "Buy" : "Sell";
  if (expectedSide !== observed!.side) {
    return {
      aligned: false,
      drift: "side-mismatch",
      details: `expected ${expectedSide} got ${observed!.side}`,
    };
  }
  if (Math.abs(expected!.quantity - observed!.size) > tolerance) {
    return {
      aligned: false,
      drift: "size-mismatch",
      details: `expected qty ${expected!.quantity} got ${observed!.size}`,
    };
  }
  return { aligned: true, drift: null };
}

// ---------- Phase 1A: Confidence-weighted sizing ----------

export function applyConfidenceSizing(params: {
  baseOrderUsd: number;
  scanScore: number;
  referenceScore: number;
  minMultiplier?: number;
  maxMultiplier?: number;
}): { orderUsd: number; multiplier: number } {
  const min = params.minMultiplier ?? 0.5;
  const max = params.maxMultiplier ?? 2.0;
  const raw = params.referenceScore > 0 ? params.scanScore / params.referenceScore : 1;
  const multiplier = Math.min(Math.max(raw, min), max);
  return { orderUsd: params.baseOrderUsd * multiplier, multiplier };
}

export function selectLeverageForOpportunity(params: {
  symbol: string;
  configuredLeverage: number;
  fundingRateBps: number;
  spreadBps: number;
  hourlyMoveBps: number;
  minuteRangeBps: number;
  netEdgeBps: number;
  policy: ExceptionalLeveragePolicy;
}): {
  leverage: number;
  exceptional: boolean;
  reason: string;
} {
  const { policy } = params;

  if (policy.allowedSymbols.length > 0 && !policy.allowedSymbols.includes(params.symbol)) {
    return {
      leverage: params.configuredLeverage,
      exceptional: false,
      reason: "symbol-not-whitelisted",
    };
  }

  if (params.spreadBps > policy.maxSpreadBps) {
    return {
      leverage: params.configuredLeverage,
      exceptional: false,
      reason: "spread-too-wide",
    };
  }

  if (Math.abs(params.fundingRateBps) > policy.maxFundingRateBps) {
    return {
      leverage: params.configuredLeverage,
      exceptional: false,
      reason: "funding-too-high",
    };
  }

  if (params.hourlyMoveBps < policy.minHourlyMoveBps) {
    return {
      leverage: params.configuredLeverage,
      exceptional: false,
      reason: "hourly-move-too-small",
    };
  }

  if (params.minuteRangeBps < policy.minMinuteRangeBps) {
    return {
      leverage: params.configuredLeverage,
      exceptional: false,
      reason: "minute-range-too-small",
    };
  }

  if (params.netEdgeBps < policy.minNetEdgeBps) {
    return {
      leverage: params.configuredLeverage,
      exceptional: false,
      reason: "net-edge-too-small",
    };
  }

  return {
    leverage: policy.exceptionalLeverage,
    exceptional: true,
    reason: "exceptional-conditions-met",
  };
}
