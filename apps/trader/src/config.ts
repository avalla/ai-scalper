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
  // Phase 1A additions — populated but not yet wired into run-trader.ts.
  trailingStopEnabled: boolean;
  trailingStopActivationBps: number;
  trailingStopTrailBps: number;
  positionReconcileIntervalTicks: number;
  setTradingStopRetryMax: number;
  setTradingStopRetryDelayMs: number;
  drawdownVelocityWindowMs: number;
  drawdownVelocityMaxUsd: number;
  drawdownMaxConsecutiveLosses: number;
  confidenceSizingEnabled: boolean;
  confidenceSizingMinMultiplier: number;
  confidenceSizingMaxMultiplier: number;
  bandit_halfLifeDays: number;
  alertWebhookUrl: string;
  scanGateAutoTuneEnabled: boolean;
  scanGateAutoTunePercentile: 50 | 75 | 90;
  scanGateAutoTuneFallbackBps: number;
  scanMinOpenInterestUsd: number;
  scanMinListingAgeDays: number;
  scanExcludedSymbols: string[];
  feeRoundTripBps: number;
  requireLocalMaConfirmation: boolean;
  // Strategy dispatch (Phase 2+: funding-arb and longer-tf strategies)
  strategyType: "ma-crossover" | "funding-arb" | "longer-tf";
  // Funding-rate arbitrage strategy parameters
  fundingArbMinAbsRateBps: number;
  fundingArbEntryWindowMinutesBefore: number;
  fundingArbExitDelayMinutesAfter: number;
  fundingArbMaxLeverage: number;
  fundingArbMaxNotionalUsd: number;
  // Longer-timeframe MA strategy parameters
  longerTfKlineInterval: string;
  longerTfKlineRefreshSec: number;
  longerTfFastWindow: number;
  longerTfSlowWindow: number;
  longerTfThresholdBps: number;
  longerTfStopLossBps: number;
  longerTfTakeProfitBps: number;
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
    // ---------- Phase 1A ----------
    trailingStopEnabled: env.TRAILING_STOP_ENABLED
      ? env.TRAILING_STOP_ENABLED === "true"
      : ((cfg as { trailingStop?: { enabled?: boolean } }).trailingStop?.enabled ?? false),
    trailingStopActivationBps: env.TRAILING_STOP_ACTIVATION_BPS
      ? Number(env.TRAILING_STOP_ACTIVATION_BPS)
      : ((cfg as { trailingStop?: { activationBps?: number } }).trailingStop?.activationBps ?? 30),
    trailingStopTrailBps: env.TRAILING_STOP_TRAIL_BPS
      ? Number(env.TRAILING_STOP_TRAIL_BPS)
      : ((cfg as { trailingStop?: { trailBps?: number } }).trailingStop?.trailBps ?? 15),
    positionReconcileIntervalTicks: env.POSITION_RECONCILE_INTERVAL_TICKS
      ? Number(env.POSITION_RECONCILE_INTERVAL_TICKS)
      : ((cfg as { reconcile?: { intervalTicks?: number } }).reconcile?.intervalTicks ?? 30),
    setTradingStopRetryMax: env.SET_TRADING_STOP_RETRY_MAX
      ? Number(env.SET_TRADING_STOP_RETRY_MAX)
      : ((cfg as { reconcile?: { setTradingStopRetryMax?: number } }).reconcile?.setTradingStopRetryMax ?? 3),
    setTradingStopRetryDelayMs: env.SET_TRADING_STOP_RETRY_DELAY_MS
      ? Number(env.SET_TRADING_STOP_RETRY_DELAY_MS)
      : ((cfg as { reconcile?: { setTradingStopRetryDelayMs?: number } }).reconcile?.setTradingStopRetryDelayMs ?? 500),
    drawdownVelocityWindowMs: env.DRAWDOWN_VELOCITY_WINDOW_MS
      ? Number(env.DRAWDOWN_VELOCITY_WINDOW_MS)
      : ((cfg as { drawdown?: { velocityWindowMs?: number } }).drawdown?.velocityWindowMs ?? 3_600_000),
    drawdownVelocityMaxUsd: env.DRAWDOWN_VELOCITY_MAX_USD
      ? Number(env.DRAWDOWN_VELOCITY_MAX_USD)
      : ((cfg as { drawdown?: { velocityMaxUsd?: number } }).drawdown?.velocityMaxUsd ?? 30),
    drawdownMaxConsecutiveLosses: env.DRAWDOWN_MAX_CONSECUTIVE_LOSSES
      ? Number(env.DRAWDOWN_MAX_CONSECUTIVE_LOSSES)
      : ((cfg as { drawdown?: { maxConsecutiveLosses?: number } }).drawdown?.maxConsecutiveLosses ?? 5),
    confidenceSizingEnabled: env.CONFIDENCE_SIZING_ENABLED
      ? env.CONFIDENCE_SIZING_ENABLED === "true"
      : ((cfg as { confidenceSizing?: { enabled?: boolean } }).confidenceSizing?.enabled ?? false),
    confidenceSizingMinMultiplier: env.CONFIDENCE_SIZING_MIN_MULTIPLIER
      ? Number(env.CONFIDENCE_SIZING_MIN_MULTIPLIER)
      : ((cfg as { confidenceSizing?: { minMultiplier?: number } }).confidenceSizing?.minMultiplier ?? 0.5),
    confidenceSizingMaxMultiplier: env.CONFIDENCE_SIZING_MAX_MULTIPLIER
      ? Number(env.CONFIDENCE_SIZING_MAX_MULTIPLIER)
      : ((cfg as { confidenceSizing?: { maxMultiplier?: number } }).confidenceSizing?.maxMultiplier ?? 2.0),
    bandit_halfLifeDays: env.BANDIT_HALF_LIFE_DAYS
      ? Number(env.BANDIT_HALF_LIFE_DAYS)
      : ((cfg as { meta?: { halfLifeDays?: number } }).meta?.halfLifeDays ?? 0),
    alertWebhookUrl: env.ALERT_WEBHOOK_URL ?? ((cfg as { alerts?: { webhookUrl?: string } }).alerts?.webhookUrl ?? ""),
    scanGateAutoTuneEnabled: env.SCAN_GATE_AUTO_TUNE_ENABLED
      ? env.SCAN_GATE_AUTO_TUNE_ENABLED === "true"
      : ((cfg as { scanGateAutoTune?: { enabled?: boolean } }).scanGateAutoTune?.enabled ?? false),
    scanGateAutoTunePercentile: ((): 50 | 75 | 90 => {
      const v = env.SCAN_GATE_AUTO_TUNE_PERCENTILE
        ? Number(env.SCAN_GATE_AUTO_TUNE_PERCENTILE)
        : ((cfg as { scanGateAutoTune?: { percentile?: number } }).scanGateAutoTune?.percentile ?? 75);
      return v === 50 ? 50 : v === 90 ? 90 : 75;
    })(),
    scanGateAutoTuneFallbackBps: env.SCAN_GATE_AUTO_TUNE_FALLBACK_BPS
      ? Number(env.SCAN_GATE_AUTO_TUNE_FALLBACK_BPS)
      : ((cfg as { scanGateAutoTune?: { fallbackBps?: number } }).scanGateAutoTune?.fallbackBps ?? 15),
    scanMinOpenInterestUsd: env.SCAN_MIN_OPEN_INTEREST_USD
      ? Number(env.SCAN_MIN_OPEN_INTEREST_USD)
      : ((cfg as { scanner?: { minOpenInterestUsd?: number } }).scanner?.minOpenInterestUsd ?? 0),
    scanMinListingAgeDays: env.SCAN_MIN_LISTING_AGE_DAYS
      ? Number(env.SCAN_MIN_LISTING_AGE_DAYS)
      : ((cfg as { scanner?: { minListingAgeDays?: number } }).scanner?.minListingAgeDays ?? 0),
    scanExcludedSymbols: env.SCAN_EXCLUDED_SYMBOLS
      ? env.SCAN_EXCLUDED_SYMBOLS.split(",").map((s) => s.trim()).filter(Boolean)
      : ((cfg as { scanner?: { excludedSymbols?: string[] } }).scanner?.excludedSymbols ?? []),
    feeRoundTripBps: env.BYBIT_FEE_ROUND_TRIP_BPS
      ? Number(env.BYBIT_FEE_ROUND_TRIP_BPS)
      : ((cfg as { bybit?: { feeRoundTripBps?: number } }).bybit?.feeRoundTripBps ?? 0),
    requireLocalMaConfirmation: env.REQUIRE_LOCAL_MA_CONFIRMATION
      ? env.REQUIRE_LOCAL_MA_CONFIRMATION === "true"
      : ((cfg as { strategy?: { requireLocalMaConfirmation?: boolean } }).strategy?.requireLocalMaConfirmation ?? true),
    strategyType: ((): TraderConfig["strategyType"] => {
      const raw = env.STRATEGY_TYPE
        ?? (cfg as { strategy?: { type?: string } }).strategy?.type
        ?? "ma-crossover";
      if (raw === "funding-arb" || raw === "longer-tf" || raw === "ma-crossover") return raw;
      return "ma-crossover";
    })(),
    fundingArbMinAbsRateBps: env.FUNDING_ARB_MIN_ABS_RATE_BPS
      ? Number(env.FUNDING_ARB_MIN_ABS_RATE_BPS)
      : ((cfg as { fundingArb?: { minAbsRateBps?: number } }).fundingArb?.minAbsRateBps ?? 5),
    fundingArbEntryWindowMinutesBefore: env.FUNDING_ARB_ENTRY_WINDOW_MINUTES_BEFORE
      ? Number(env.FUNDING_ARB_ENTRY_WINDOW_MINUTES_BEFORE)
      : ((cfg as { fundingArb?: { entryWindowMinutesBefore?: number } }).fundingArb?.entryWindowMinutesBefore ?? 5),
    fundingArbExitDelayMinutesAfter: env.FUNDING_ARB_EXIT_DELAY_MINUTES_AFTER
      ? Number(env.FUNDING_ARB_EXIT_DELAY_MINUTES_AFTER)
      : ((cfg as { fundingArb?: { exitDelayMinutesAfter?: number } }).fundingArb?.exitDelayMinutesAfter ?? 2),
    fundingArbMaxLeverage: env.FUNDING_ARB_MAX_LEVERAGE
      ? Number(env.FUNDING_ARB_MAX_LEVERAGE)
      : ((cfg as { fundingArb?: { maxLeverage?: number } }).fundingArb?.maxLeverage ?? 5),
    fundingArbMaxNotionalUsd: env.FUNDING_ARB_MAX_NOTIONAL_USD
      ? Number(env.FUNDING_ARB_MAX_NOTIONAL_USD)
      : ((cfg as { fundingArb?: { maxNotionalUsd?: number } }).fundingArb?.maxNotionalUsd ?? 100),
    longerTfKlineInterval: env.LONGER_TF_KLINE_INTERVAL
      ?? ((cfg as { longerTf?: { klineInterval?: string } }).longerTf?.klineInterval ?? "15"),
    longerTfKlineRefreshSec: env.LONGER_TF_KLINE_REFRESH_SEC
      ? Number(env.LONGER_TF_KLINE_REFRESH_SEC)
      : ((cfg as { longerTf?: { klineRefreshSec?: number } }).longerTf?.klineRefreshSec ?? 60),
    longerTfFastWindow: env.LONGER_TF_FAST_WINDOW
      ? Number(env.LONGER_TF_FAST_WINDOW)
      : ((cfg as { longerTf?: { fastWindow?: number } }).longerTf?.fastWindow ?? 6),
    longerTfSlowWindow: env.LONGER_TF_SLOW_WINDOW
      ? Number(env.LONGER_TF_SLOW_WINDOW)
      : ((cfg as { longerTf?: { slowWindow?: number } }).longerTf?.slowWindow ?? 20),
    longerTfThresholdBps: env.LONGER_TF_THRESHOLD_BPS
      ? Number(env.LONGER_TF_THRESHOLD_BPS)
      : ((cfg as { longerTf?: { thresholdBps?: number } }).longerTf?.thresholdBps ?? 20),
    longerTfStopLossBps: env.LONGER_TF_STOP_LOSS_BPS
      ? Number(env.LONGER_TF_STOP_LOSS_BPS)
      : ((cfg as { longerTf?: { stopLossBps?: number } }).longerTf?.stopLossBps ?? 50),
    longerTfTakeProfitBps: env.LONGER_TF_TAKE_PROFIT_BPS
      ? Number(env.LONGER_TF_TAKE_PROFIT_BPS)
      : ((cfg as { longerTf?: { takeProfitBps?: number } }).longerTf?.takeProfitBps ?? 150),
  };
}
