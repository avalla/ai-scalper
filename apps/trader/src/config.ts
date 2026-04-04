export interface TraderConfig {
  mode: "trade" | "scan";
  tradingProfile: "standard" | "aggressive-perps";
  entryExecutionMode: "taker" | "maker-entry" | "maker-preferred-with-timeout";
  entryMakerOffsetTicks: number;
  entryMakerPollMs: number;
  entryMakerTimeoutMs: number;
  category: string;
  symbol: string;
  pollMs: number;
  orderUsd: number;
  paperTrading: boolean;
  fastWindow: number;
  slowWindow: number;
  thresholdBps: number;
  leverage: number;
  stopLossBps: number;
  takeProfitBps: number;
  maxPositionUsd: number;
  maxDailyLossUsd: number;
  maxSpreadBps: number;
  minTradeIntervalMs: number;
  slippageTolerancePercent: number;
  maxTicks: number;
  aggressiveAllowedSymbols: string[];
  aggressiveRequireScanCandidate: boolean;
  aggressiveScanCandidatesPath: string;
  aggressiveScanLatestPath: string;
  aggressiveScanMaxAgeMinutes: number;
  tradeCandidateSymbols: string[];
  aggressiveMaxLeverage: number;
  aggressiveMaxFundingRateBps: number;
  aggressiveMaxLossPerTradeUsd: number;
  aggressiveMinEstimatedLiqBufferBps: number;
  exceptionalLeverageEnabled: boolean;
  exceptionalAllowedSymbols: string[];
  exceptionalLeverage: number;
  exceptionalMaxSpreadBps: number;
  exceptionalMaxFundingRateBps: number;
  exceptionalMinHourlyMoveBps: number;
  exceptionalMinMinuteRangeBps: number;
  exceptionalMinNetEdgeBps: number;
}

export function readTraderConfig(env: NodeJS.ProcessEnv = process.env): TraderConfig {
  return {
    mode: env.TRADER_MODE === "scan" ? "scan" : "trade",
    tradingProfile: env.TRADING_PROFILE === "aggressive-perps" ? "aggressive-perps" : "standard",
    entryExecutionMode:
      env.ENTRY_EXECUTION_MODE === "maker-entry" || env.ENTRY_EXECUTION_MODE === "maker-preferred-with-timeout"
        ? env.ENTRY_EXECUTION_MODE
        : "taker",
    entryMakerOffsetTicks: Number(env.ENTRY_MAKER_OFFSET_TICKS || "0"),
    entryMakerPollMs: Number(env.ENTRY_MAKER_POLL_MS || "250"),
    entryMakerTimeoutMs: Number(env.ENTRY_MAKER_TIMEOUT_MS || "1500"),
    category: env.BYBIT_CATEGORY || "linear",
    symbol: env.BYBIT_SYMBOL || "BTCUSDT",
    pollMs: Number(env.BYBIT_POLL_MS || "1000"),
    orderUsd: Number(env.BYBIT_ORDER_USD || "25"),
    paperTrading: (env.BYBIT_PAPER_TRADING || "true") === "true",
    fastWindow: Number(env.STRATEGY_FAST_WINDOW || "5"),
    slowWindow: Number(env.STRATEGY_SLOW_WINDOW || "20"),
    thresholdBps: Number(env.STRATEGY_THRESHOLD_BPS || "4"),
    leverage: Number(env.BYBIT_LEVERAGE || "1"),
    stopLossBps: Number(env.STRATEGY_STOP_LOSS_BPS || "20"),
    takeProfitBps: Number(env.STRATEGY_TAKE_PROFIT_BPS || "30"),
    maxPositionUsd: Number(env.RISK_MAX_POSITION_USD || "100"),
    maxDailyLossUsd: Number(env.RISK_MAX_DAILY_LOSS_USD || "50"),
    maxSpreadBps: Number(env.RISK_MAX_SPREAD_BPS || "8"),
    minTradeIntervalMs: Number(env.RISK_MIN_TRADE_INTERVAL_MS || "15000"),
    slippageTolerancePercent: Number(env.BYBIT_SLIPPAGE_TOLERANCE_PERCENT || "0.1"),
    maxTicks: Number(env.TRADER_MAX_TICKS || "0"),
    aggressiveAllowedSymbols: (env.AGGRESSIVE_ALLOWED_SYMBOLS || "BTCUSDT,ETHUSDT,SOLUSDT")
      .split(",")
      .map((symbol) => symbol.trim())
      .filter(Boolean),
    aggressiveRequireScanCandidate: env.AGGRESSIVE_REQUIRE_SCAN_CANDIDATE === "true",
    aggressiveScanCandidatesPath: env.AGGRESSIVE_SCAN_CANDIDATES_PATH || "apps/trader/data/backtest-candidates.json",
    aggressiveScanLatestPath: env.AGGRESSIVE_SCAN_LATEST_PATH || "apps/trader/data/scan-latest.json",
    aggressiveScanMaxAgeMinutes: Number(env.AGGRESSIVE_SCAN_MAX_AGE_MINUTES || "30"),
    tradeCandidateSymbols: (env.TRADE_CANDIDATE_SYMBOLS || "")
      .split(",")
      .map((symbol) => symbol.trim())
      .filter(Boolean),
    aggressiveMaxLeverage: Number(env.AGGRESSIVE_MAX_LEVERAGE || "50"),
    aggressiveMaxFundingRateBps: Number(env.AGGRESSIVE_MAX_FUNDING_RATE_BPS || "8"),
    aggressiveMaxLossPerTradeUsd: Number(env.AGGRESSIVE_MAX_LOSS_PER_TRADE_USD || "8"),
    aggressiveMinEstimatedLiqBufferBps: Number(env.AGGRESSIVE_MIN_ESTIMATED_LIQ_BUFFER_BPS || "80"),
    exceptionalLeverageEnabled: env.EXCEPTIONAL_LEVERAGE_ENABLED === "true",
    exceptionalAllowedSymbols: (env.EXCEPTIONAL_ALLOWED_SYMBOLS || "BTCUSDT,ETHUSDT")
      .split(",")
      .map((symbol) => symbol.trim())
      .filter(Boolean),
    exceptionalLeverage: Number(env.EXCEPTIONAL_LEVERAGE || "100"),
    exceptionalMaxSpreadBps: Number(env.EXCEPTIONAL_MAX_SPREAD_BPS || "0.5"),
    exceptionalMaxFundingRateBps: Number(env.EXCEPTIONAL_MAX_FUNDING_RATE_BPS || "2"),
    exceptionalMinHourlyMoveBps: Number(env.EXCEPTIONAL_MIN_HOURLY_MOVE_BPS || "100"),
    exceptionalMinMinuteRangeBps: Number(env.EXCEPTIONAL_MIN_MINUTE_RANGE_BPS || "20"),
    exceptionalMinNetEdgeBps: Number(env.EXCEPTIONAL_MIN_NET_EDGE_BPS || "10"),
  };
}
