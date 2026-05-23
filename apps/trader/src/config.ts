import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import defaultConfig from '../config.json';

type TradingConfig = typeof defaultConfig;

function loadConfig(): TradingConfig {
  const configFile = process.env.CONFIG_FILE;
  if (!configFile) return defaultConfig;
  const resolved = configFile.startsWith('/') ? configFile : join(process.cwd(), configFile);
  return JSON.parse(readFileSync(resolved, 'utf8')) as TradingConfig;
}

export interface TraderConfig {
  mode: "trade" | "scan";
  tradingProfile: "standard" | "aggressive-perps";
  entryExecutionMode: "taker" | "maker-entry" | "maker-preferred-with-timeout";
  entryMakerOffsetTicks: number;
  entryMakerPollMs: number;
  entryMakerTimeoutMs: number;
  autoSizeFromWallet: boolean;
  walletAccountType: string;
  walletCoin: string;
  walletFraction: number;
  walletMaxOrderUsdCap: number | null;
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
  riskMaxFundingRateBps: number;
  slippageTolerancePercent: number;
  maxTicks: number;
  tradeScanRefreshMs: number;
  tradeMinSetupScore: number;
  tradeMinSetupNetEdgeBps: number;
  aggressiveAllowedSymbols: string[];
  aggressiveRequireScanCandidate: boolean;
  aggressiveScanCandidatesPath: string;
  aggressiveScanLatestPath: string;
  aggressiveScanMaxAgeMinutes: number;
  tradeCandidateSymbols: string[];
  tickerFailureCooldownTicks: number;
  tickerFailureThreshold: number;
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
  exitPolicyMode: "exchange-native" | "logical";
  exitPolicySafetyDelayMs: number;
  exitPolicySafetyStopBps: number;
  bybitPositionMode: "one-way" | "hedge";
  metaEnabled: boolean;
  metaWarmupMinTrades: number;
  metaPnlWindowSize: number;
  metaIncludeAggressiveVariants: boolean;
  runtimeArtifactFlushTicks: number;
  statePersistenceEnabled: boolean;
}

function resolveIncludeAggressiveVariants(
  env: NodeJS.ProcessEnv,
  cfgValue: boolean | undefined,
  tradingProfile: TraderConfig["tradingProfile"],
): boolean {
  if (env.META_INCLUDE_AGGRESSIVE_VARIANTS !== undefined) {
    return env.META_INCLUDE_AGGRESSIVE_VARIANTS === "true";
  }
  if (cfgValue !== undefined) {
    return cfgValue;
  }
  return tradingProfile === "aggressive-perps";
}

export function readTraderConfig(env: NodeJS.ProcessEnv = process.env): TraderConfig {
  const cfg = loadConfig();
  return {
    mode: env.TRADER_MODE === "scan" ? "scan" : "trade",
    tradingProfile:
      env.TRADING_PROFILE === "aggressive-perps" || env.TRADING_PROFILE === "standard"
        ? env.TRADING_PROFILE
        : cfg.tradingProfile as TraderConfig["tradingProfile"],
    entryExecutionMode:
      env.ENTRY_EXECUTION_MODE === "taker" || env.ENTRY_EXECUTION_MODE === "maker-entry" || env.ENTRY_EXECUTION_MODE === "maker-preferred-with-timeout"
        ? env.ENTRY_EXECUTION_MODE
        : cfg.entry.executionMode as TraderConfig["entryExecutionMode"],
    entryMakerOffsetTicks: env.ENTRY_MAKER_OFFSET_TICKS ? Number(env.ENTRY_MAKER_OFFSET_TICKS) : cfg.entry.makerOffsetTicks,
    entryMakerPollMs: env.ENTRY_MAKER_POLL_MS ? Number(env.ENTRY_MAKER_POLL_MS) : cfg.entry.makerPollMs,
    entryMakerTimeoutMs: env.ENTRY_MAKER_TIMEOUT_MS ? Number(env.ENTRY_MAKER_TIMEOUT_MS) : cfg.entry.makerTimeoutMs,
    autoSizeFromWallet: env.AUTO_SIZE_FROM_WALLET ? env.AUTO_SIZE_FROM_WALLET === "true" : cfg.wallet.autoSize,
    walletAccountType: env.WALLET_ACCOUNT_TYPE || cfg.wallet.accountType,
    walletCoin: env.WALLET_COIN || cfg.wallet.coin,
    walletFraction: env.WALLET_FRACTION ? Number(env.WALLET_FRACTION) : cfg.wallet.fraction,
    walletMaxOrderUsdCap: env.WALLET_MAX_ORDER_USD_CAP
      ? Number(env.WALLET_MAX_ORDER_USD_CAP)
      : cfg.wallet.maxOrderUsdCap,
    category: env.BYBIT_CATEGORY || cfg.bybit.category,
    symbol: env.BYBIT_SYMBOL || cfg.bybit.symbol,
    pollMs: env.BYBIT_POLL_MS ? Number(env.BYBIT_POLL_MS) : cfg.bybit.pollMs,
    orderUsd: env.BYBIT_ORDER_USD ? Number(env.BYBIT_ORDER_USD) : cfg.bybit.orderUsd,
    paperTrading: (env.BYBIT_PAPER_TRADING || "true") === "true",
    fastWindow: env.STRATEGY_FAST_WINDOW ? Number(env.STRATEGY_FAST_WINDOW) : cfg.strategy.fastWindow,
    slowWindow: env.STRATEGY_SLOW_WINDOW ? Number(env.STRATEGY_SLOW_WINDOW) : cfg.strategy.slowWindow,
    thresholdBps: env.STRATEGY_THRESHOLD_BPS ? Number(env.STRATEGY_THRESHOLD_BPS) : cfg.strategy.thresholdBps,
    leverage: env.BYBIT_LEVERAGE ? Number(env.BYBIT_LEVERAGE) : cfg.bybit.leverage,
    stopLossBps: env.STRATEGY_STOP_LOSS_BPS ? Number(env.STRATEGY_STOP_LOSS_BPS) : cfg.strategy.stopLossBps,
    takeProfitBps: env.STRATEGY_TAKE_PROFIT_BPS ? Number(env.STRATEGY_TAKE_PROFIT_BPS) : cfg.strategy.takeProfitBps,
    maxPositionUsd: env.RISK_MAX_POSITION_USD ? Number(env.RISK_MAX_POSITION_USD) : cfg.risk.maxPositionUsd,
    maxDailyLossUsd: env.RISK_MAX_DAILY_LOSS_USD ? Number(env.RISK_MAX_DAILY_LOSS_USD) : cfg.risk.maxDailyLossUsd,
    maxSpreadBps: env.RISK_MAX_SPREAD_BPS ? Number(env.RISK_MAX_SPREAD_BPS) : cfg.risk.maxSpreadBps,
    minTradeIntervalMs: env.RISK_MIN_TRADE_INTERVAL_MS ? Number(env.RISK_MIN_TRADE_INTERVAL_MS) : cfg.risk.minTradeIntervalMs,
    riskMaxFundingRateBps: env.RISK_MAX_FUNDING_RATE_BPS ? Number(env.RISK_MAX_FUNDING_RATE_BPS) : cfg.risk.maxFundingRateBps,
    slippageTolerancePercent: env.BYBIT_SLIPPAGE_TOLERANCE_PERCENT ? Number(env.BYBIT_SLIPPAGE_TOLERANCE_PERCENT) : cfg.bybit.slippageTolerancePercent,
    maxTicks: Number(env.TRADER_MAX_TICKS || "0"),
    tradeScanRefreshMs: env.TRADE_SCAN_REFRESH_MS ? Number(env.TRADE_SCAN_REFRESH_MS) : cfg.scanner.refreshMs,
    tradeMinSetupScore: env.TRADE_MIN_SETUP_SCORE ? Number(env.TRADE_MIN_SETUP_SCORE) : cfg.scanner.minSetupScore,
    tradeMinSetupNetEdgeBps: env.TRADE_MIN_SETUP_NET_EDGE_BPS ? Number(env.TRADE_MIN_SETUP_NET_EDGE_BPS) : cfg.scanner.minSetupNetEdgeBps,
    aggressiveAllowedSymbols: env.AGGRESSIVE_ALLOWED_SYMBOLS
      ? env.AGGRESSIVE_ALLOWED_SYMBOLS.split(",").map((s) => s.trim()).filter(Boolean)
      : cfg.aggressive.allowedSymbols,
    aggressiveRequireScanCandidate: env.AGGRESSIVE_REQUIRE_SCAN_CANDIDATE
      ? env.AGGRESSIVE_REQUIRE_SCAN_CANDIDATE === "true"
      : cfg.aggressive.requireScanCandidate,
    aggressiveScanCandidatesPath: env.AGGRESSIVE_SCAN_CANDIDATES_PATH || cfg.aggressive.scanCandidatesPath,
    aggressiveScanLatestPath: env.AGGRESSIVE_SCAN_LATEST_PATH || cfg.aggressive.scanLatestPath,
    aggressiveScanMaxAgeMinutes: env.AGGRESSIVE_SCAN_MAX_AGE_MINUTES ? Number(env.AGGRESSIVE_SCAN_MAX_AGE_MINUTES) : cfg.aggressive.scanMaxAgeMinutes,
    tradeCandidateSymbols: env.TRADE_CANDIDATE_SYMBOLS
      ? env.TRADE_CANDIDATE_SYMBOLS.split(",").map((s) => s.trim()).filter(Boolean)
      : cfg.scanner.candidateSymbols,
    tickerFailureCooldownTicks: env.TICKER_FAILURE_COOLDOWN_TICKS ? Number(env.TICKER_FAILURE_COOLDOWN_TICKS) : cfg.tickerFailure.cooldownTicks,
    tickerFailureThreshold: env.TICKER_FAILURE_THRESHOLD ? Number(env.TICKER_FAILURE_THRESHOLD) : cfg.tickerFailure.threshold,
    aggressiveMaxLeverage: env.AGGRESSIVE_MAX_LEVERAGE ? Number(env.AGGRESSIVE_MAX_LEVERAGE) : cfg.aggressive.maxLeverage,
    aggressiveMaxFundingRateBps: env.AGGRESSIVE_MAX_FUNDING_RATE_BPS ? Number(env.AGGRESSIVE_MAX_FUNDING_RATE_BPS) : cfg.aggressive.maxFundingRateBps,
    aggressiveMaxLossPerTradeUsd: env.AGGRESSIVE_MAX_LOSS_PER_TRADE_USD ? Number(env.AGGRESSIVE_MAX_LOSS_PER_TRADE_USD) : cfg.aggressive.maxLossPerTradeUsd,
    aggressiveMinEstimatedLiqBufferBps: env.AGGRESSIVE_MIN_ESTIMATED_LIQ_BUFFER_BPS ? Number(env.AGGRESSIVE_MIN_ESTIMATED_LIQ_BUFFER_BPS) : cfg.aggressive.minEstimatedLiqBufferBps,
    exceptionalLeverageEnabled: env.EXCEPTIONAL_LEVERAGE_ENABLED
      ? env.EXCEPTIONAL_LEVERAGE_ENABLED === "true"
      : cfg.exceptional.enabled,
    exceptionalAllowedSymbols: env.EXCEPTIONAL_ALLOWED_SYMBOLS
      ? env.EXCEPTIONAL_ALLOWED_SYMBOLS.split(",").map((s) => s.trim()).filter(Boolean)
      : cfg.exceptional.allowedSymbols,
    exceptionalLeverage: env.EXCEPTIONAL_LEVERAGE ? Number(env.EXCEPTIONAL_LEVERAGE) : cfg.exceptional.leverage,
    exceptionalMaxSpreadBps: env.EXCEPTIONAL_MAX_SPREAD_BPS ? Number(env.EXCEPTIONAL_MAX_SPREAD_BPS) : cfg.exceptional.maxSpreadBps,
    exceptionalMaxFundingRateBps: env.EXCEPTIONAL_MAX_FUNDING_RATE_BPS ? Number(env.EXCEPTIONAL_MAX_FUNDING_RATE_BPS) : cfg.exceptional.maxFundingRateBps,
    exceptionalMinHourlyMoveBps: env.EXCEPTIONAL_MIN_HOURLY_MOVE_BPS ? Number(env.EXCEPTIONAL_MIN_HOURLY_MOVE_BPS) : cfg.exceptional.minHourlyMoveBps,
    exceptionalMinMinuteRangeBps: env.EXCEPTIONAL_MIN_MINUTE_RANGE_BPS ? Number(env.EXCEPTIONAL_MIN_MINUTE_RANGE_BPS) : cfg.exceptional.minMinuteRangeBps,
    exceptionalMinNetEdgeBps: env.EXCEPTIONAL_MIN_NET_EDGE_BPS ? Number(env.EXCEPTIONAL_MIN_NET_EDGE_BPS) : cfg.exceptional.minNetEdgeBps,
    exitPolicyMode: cfg.exitPolicy.mode as "exchange-native" | "logical",
    exitPolicySafetyDelayMs: cfg.exitPolicy.safetyDelayMs,
    exitPolicySafetyStopBps: cfg.exitPolicy.safetyStopBps,
    bybitPositionMode: ((): "one-way" | "hedge" => {
      if (env.BYBIT_POSITION_MODE === "hedge") return "hedge";
      if (env.BYBIT_POSITION_MODE === "one-way") return "one-way";
      const cfgMode = (cfg as { bybit?: { positionMode?: string } }).bybit?.positionMode;
      return cfgMode === "hedge" ? "hedge" : "one-way";
    })(),
    metaEnabled: env.META_ENABLED ? env.META_ENABLED === "true" : ((cfg as { meta?: { enabled?: boolean } }).meta?.enabled ?? false),
    metaWarmupMinTrades: env.META_WARMUP_MIN_TRADES
      ? Number(env.META_WARMUP_MIN_TRADES)
      : ((cfg as { meta?: { warmupMinTrades?: number } }).meta?.warmupMinTrades ?? 5),
    metaPnlWindowSize: env.META_PNL_WINDOW_SIZE
      ? Number(env.META_PNL_WINDOW_SIZE)
      : ((cfg as { meta?: { pnlWindowSize?: number } }).meta?.pnlWindowSize ?? 50),
    metaIncludeAggressiveVariants: resolveIncludeAggressiveVariants(
      env,
      (cfg as { meta?: { includeAggressiveVariants?: boolean } }).meta?.includeAggressiveVariants,
      (env.TRADING_PROFILE === "aggressive-perps" || env.TRADING_PROFILE === "standard"
        ? env.TRADING_PROFILE
        : cfg.tradingProfile as TraderConfig["tradingProfile"]),
    ),
    runtimeArtifactFlushTicks: env.RUNTIME_ARTIFACT_FLUSH_TICKS
      ? Number(env.RUNTIME_ARTIFACT_FLUSH_TICKS)
      : ((cfg as { runtime?: { artifactFlushTicks?: number } }).runtime?.artifactFlushTicks ?? 30),
    statePersistenceEnabled: env.STATE_PERSISTENCE_ENABLED
      ? env.STATE_PERSISTENCE_ENABLED === "true"
      : ((cfg as { runtime?: { statePersistenceEnabled?: boolean } }).runtime?.statePersistenceEnabled ?? false),
  };
}
