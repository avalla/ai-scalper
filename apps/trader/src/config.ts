import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import defaultConfig from '../config.json';

type TradingConfig = typeof defaultConfig;

/**
 * Find a config file by searching in this order:
 * 1. Absolute path → use it
 * 2. <cwd>/<file>
 * 3. Walk up from cwd looking for `apps/trader/<file>` (handles worker cwd)
 * 4. Walk up from cwd looking for `<file>` next to a `bun.lock`
 */
function resolveConfigFile(name: string): string | null {
  if (isAbsolute(name)) return existsSync(name) ? name : null;
  const cwd = process.cwd();
  const direct = join(cwd, name);
  if (existsSync(direct)) return direct;
  let dir = cwd;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'apps', 'trader', name);
    if (existsSync(candidate)) return candidate;
    const sibling = join(dir, name);
    if (existsSync(sibling) && existsSync(join(dir, 'bun.lock'))) return sibling;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function loadConfig(): TradingConfig {
  const configFile = process.env.CONFIG_FILE;
  if (!configFile) return defaultConfig;
  const resolved = resolveConfigFile(configFile);
  if (!resolved) {
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'config-file-not-found',
      configFile,
      cwd: process.cwd(),
      message: 'falling back to default config.json',
    }));
    return defaultConfig;
  }
  return JSON.parse(readFileSync(resolved, 'utf8')) as TradingConfig;
}

export interface TraderConfig {
  mode: "trade" | "scan";
  tradingProfile: "standard" | "aggressive-perps";
  entryExecutionMode: "taker" | "maker-entry" | "maker-preferred-with-timeout" | "maker-only-aggressive";
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
  trailingStopEnabled: boolean;
  trailingStopActivationBps: number;
  trailingStopTrailBps: number;
  positionReconcileIntervalTicks: number;
  setTradingStopRetryMax: number;
  setTradingStopRetryDelayMs: number;
  drawdownVelocityWindowMs: number;
  drawdownVelocityMaxUsd: number;
  drawdownMaxConsecutiveLosses: number;
  /** Cooldown after drawdown halt before resuming. Env-overridable for ad-hoc debug. */
  drawdownHaltCooldownMs: number;
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
  // Strategy dispatch
  strategyType: "ma-crossover" | "funding-arb" | "longer-tf" | "basis-arb" | "pairs-trading" | "bollinger-adx" | "calendar-spread" | "llm-managed";
  /**
   * Single consolidated flag (replaces the 8 per-strategy *UseBullmqJobs
   * flags). When true AND the active `strategyType` has a BullMQ worker
   * stack, the in-process tick becomes a no-op and the worker owns trades.
   * Sourced from JSON path `runtime.useBullmqJobs`, default false.
   */
  useBullmqJobs: boolean;
  /**
   * Phase 1 WS feed. When true, the ws-feeder process is spawned (by
   * start-stack) and the market-scanner reads live tickers from the shared
   * Redis cache instead of REST `/v5/market/tickers` (falling back to REST
   * for stale entries). Defaults false — pure backward-compatibility flag.
   * Sourced from JSON path `runtime.useWebSocket`.
   */
  useWebSocket: boolean;
  // LLM-managed strategy
  llmManagedAllowedSymbols: string[];
  llmManagedOpenReviewIntervalSec: number;
  llmManagedManageReviewIntervalSec: number;
  llmManagedMaxNotionalUsd: number;
  llmManagedMaxLeverage: number;
  llmManagedMaxHoldHours: number;
  llmManagedMaxAbsoluteLossUsd: number;
  llmManagedHedgeMaxNotionalUsd: number;
  llmManagedModel: string;
  llmManagedTimeoutMs: number;
  llmManagedPostCutLossCooldownMs: number;
  // Calendar-spread strategy
  calendarPerpSymbol: string;
  calendarDatedSymbol: string;
  calendarDatedDeliveryAt: number;
  calendarEntryThresholdBps: number;
  calendarExitThresholdBps: number;
  calendarPreSettlementCloseHours: number;
  calendarMaxNotionalUsdPerLeg: number;
  calendarPollSec: number;
  // LLM advisor
  advisorEnabled: boolean;
  advisorIntervalMinutes: number;
  advisorModel: string;
  // LLM order supervisor
  orderSupervisorEnabled: boolean;
  orderSupervisorStrategies: string[];
  orderSupervisorMinConfidence: number;
  orderSupervisorModel: string;
  orderSupervisorTimeoutMs: number;
  orderSupervisorOnErrorBehavior: "reject" | "approve";
  // Pairs-trading strategy
  pairsLeg1Symbol: string;
  pairsLeg2Symbol: string;
  pairsWindowSize: number;
  pairsEntryZ: number;
  pairsExitZ: number;
  pairsMaxHoldMinutes: number;
  pairsMaxNotionalUsdPerLeg: number;
  pairsKlineInterval: string;
  pairsKlineRefreshSec: number;
  // Bollinger + ADX
  bollingerAdxBbPeriod: number;
  bollingerAdxBbStdDev: number;
  bollingerAdxAdxPeriod: number;
  bollingerAdxAdxRangingThreshold: number;
  bollingerAdxAdxTrendingThreshold: number;
  bollingerAdxStopLossBps: number;
  bollingerAdxTakeProfitBps: number;
  bollingerAdxKlineInterval: string;
  bollingerAdxKlineRefreshSec: number;
  // Basis-arb
  basisArbEntryThresholdBps: number;
  basisArbExitThresholdBps: number;
  basisArbMaxNotionalUsd: number;
  basisArbMaxHoldMinutes: number;
  // Funding-arb
  fundingArbMinAbsRateBps: number;
  fundingArbEntryWindowMinutesBefore: number;
  fundingArbExitDelayMinutesAfter: number;
  fundingArbMaxLeverage: number;
  fundingArbMaxNotionalUsd: number;
  // Longer-TF
  longerTfKlineInterval: string;
  longerTfKlineRefreshSec: number;
  longerTfFastWindow: number;
  longerTfSlowWindow: number;
  longerTfThresholdBps: number;
  longerTfStopLossBps: number;
  longerTfTakeProfitBps: number;
}

// Convenience helpers — keep config.ts self-contained and avoid scattering
// JSON-shape casts throughout the resolver.
type AnyCfg = Record<string, unknown>;
const sect = (cfg: TradingConfig, key: string): AnyCfg =>
  ((cfg as unknown as Record<string, AnyCfg | undefined>)[key] ?? {});

/**
 * Read trader configuration.
 *
 * Philosophy (post env-cleanup): the JSON config files are the source of
 * truth for ALL strategy/risk/operational parameters. Only a small
 * whitelist of env vars is honored here — secrets, mode/network toggles,
 * infra, and a handful of ad-hoc debug knobs. See `.env.example`.
 */
export function readTraderConfig(env: NodeJS.ProcessEnv = process.env): TraderConfig {
  const cfg = loadConfig();

  const entry = sect(cfg, "entry");
  const wallet = sect(cfg, "wallet");
  const bybit = sect(cfg, "bybit");
  const strategy = sect(cfg, "strategy");
  const risk = sect(cfg, "risk");
  const scanner = sect(cfg, "scanner");
  const tickerFailure = sect(cfg, "tickerFailure");
  const aggressive = sect(cfg, "aggressive");
  const exceptional = sect(cfg, "exceptional");
  const exitPolicy = sect(cfg, "exitPolicy");
  const meta = sect(cfg, "meta");
  const runtime = sect(cfg, "runtime");
  const trailingStop = sect(cfg, "trailingStop");
  const reconcile = sect(cfg, "reconcile");
  const drawdown = sect(cfg, "drawdown");
  const confidenceSizing = sect(cfg, "confidenceSizing");
  const alerts = sect(cfg, "alerts");
  const scanGateAutoTune = sect(cfg, "scanGateAutoTune");
  const orderSupervisor = sect(cfg, "orderSupervisor");
  const llmManaged = sect(cfg, "llmManaged");
  const calendarSpread = sect(cfg, "calendarSpread");
  const advisor = sect(cfg, "advisor");
  const pairs = sect(cfg, "pairs");
  const bollingerAdx = sect(cfg, "bollingerAdx");
  const basisArb = sect(cfg, "basisArb");
  const fundingArb = sect(cfg, "fundingArb");
  const longerTf = sect(cfg, "longerTf");

  const tradingProfile: TraderConfig["tradingProfile"] =
    (cfg as { tradingProfile?: string }).tradingProfile === "aggressive-perps"
      ? "aggressive-perps"
      : "standard";

  const strategyType: TraderConfig["strategyType"] = ((): TraderConfig["strategyType"] => {
    const raw = (strategy.type as string | undefined) ?? "ma-crossover";
    if (
      raw === "funding-arb" || raw === "longer-tf" || raw === "ma-crossover"
      || raw === "basis-arb" || raw === "pairs-trading" || raw === "bollinger-adx"
      || raw === "calendar-spread" || raw === "llm-managed"
    ) return raw;
    return "ma-crossover";
  })();

  // Position mode: env override permitted (paper vs live can flip).
  const bybitPositionMode: "one-way" | "hedge" =
    env.BYBIT_POSITION_MODE === "hedge" ? "hedge"
    : env.BYBIT_POSITION_MODE === "one-way" ? "one-way"
    : (bybit.positionMode === "hedge" ? "hedge" : "one-way");

  return {
    mode: env.TRADER_MODE === "scan" ? "scan" : "trade",
    tradingProfile,
    entryExecutionMode: (entry.executionMode as TraderConfig["entryExecutionMode"]) ?? "maker-preferred-with-timeout",
    entryMakerOffsetTicks: (entry.makerOffsetTicks as number) ?? 0,
    entryMakerPollMs: (entry.makerPollMs as number) ?? 250,
    entryMakerTimeoutMs: (entry.makerTimeoutMs as number) ?? 1500,
    autoSizeFromWallet: (wallet.autoSize as boolean) ?? false,
    walletAccountType: (wallet.accountType as string) ?? "UNIFIED",
    walletCoin: (wallet.coin as string) ?? "USDT",
    walletFraction: (wallet.fraction as number) ?? 1,
    walletMaxOrderUsdCap: (wallet.maxOrderUsdCap as number | null) ?? null,
    category: (bybit.category as string) ?? "linear",
    symbol: (bybit.symbol as string) ?? "BTCUSDT",
    pollMs: (bybit.pollMs as number) ?? 1000,
    orderUsd: (bybit.orderUsd as number) ?? 5,
    paperTrading: (env.BYBIT_PAPER_TRADING || "true") === "true",
    fastWindow: (strategy.fastWindow as number) ?? 5,
    slowWindow: (strategy.slowWindow as number) ?? 20,
    thresholdBps: (strategy.thresholdBps as number) ?? 4,
    leverage: (bybit.leverage as number) ?? 3,
    stopLossBps: (strategy.stopLossBps as number) ?? 30,
    takeProfitBps: (strategy.takeProfitBps as number) ?? 60,
    maxPositionUsd: (risk.maxPositionUsd as number) ?? 100,
    maxDailyLossUsd: (risk.maxDailyLossUsd as number) ?? 50,
    maxSpreadBps: (risk.maxSpreadBps as number) ?? 8,
    minTradeIntervalMs: (risk.minTradeIntervalMs as number) ?? 15000,
    riskMaxFundingRateBps: (risk.maxFundingRateBps as number) ?? 15,
    slippageTolerancePercent: (bybit.slippageTolerancePercent as number) ?? 0.1,
    maxTicks: Number(env.TRADER_MAX_TICKS || "0"),
    tradeScanRefreshMs: (scanner.refreshMs as number) ?? 60000,
    tradeMinSetupScore: (scanner.minSetupScore as number) ?? 45,
    tradeMinSetupNetEdgeBps: (scanner.minSetupNetEdgeBps as number) ?? 15,
    aggressiveAllowedSymbols: (aggressive.allowedSymbols as string[]) ?? [],
    aggressiveRequireScanCandidate: (aggressive.requireScanCandidate as boolean) ?? false,
    aggressiveScanCandidatesPath: (aggressive.scanCandidatesPath as string) ?? "apps/trader/data/backtest-candidates.json",
    aggressiveScanLatestPath: (aggressive.scanLatestPath as string) ?? "apps/trader/data/scan-latest.json",
    aggressiveScanMaxAgeMinutes: (aggressive.scanMaxAgeMinutes as number) ?? 30,
    tradeCandidateSymbols: (scanner.candidateSymbols as string[]) ?? [],
    tickerFailureCooldownTicks: (tickerFailure.cooldownTicks as number) ?? 20,
    tickerFailureThreshold: (tickerFailure.threshold as number) ?? 3,
    aggressiveMaxLeverage: (aggressive.maxLeverage as number) ?? 50,
    aggressiveMaxFundingRateBps: (aggressive.maxFundingRateBps as number) ?? 8,
    aggressiveMaxLossPerTradeUsd: (aggressive.maxLossPerTradeUsd as number) ?? 8,
    aggressiveMinEstimatedLiqBufferBps: (aggressive.minEstimatedLiqBufferBps as number) ?? 80,
    exceptionalLeverageEnabled: (exceptional.enabled as boolean) ?? false,
    exceptionalAllowedSymbols: (exceptional.allowedSymbols as string[]) ?? [],
    exceptionalLeverage: (exceptional.leverage as number) ?? 100,
    exceptionalMaxSpreadBps: (exceptional.maxSpreadBps as number) ?? 0.5,
    exceptionalMaxFundingRateBps: (exceptional.maxFundingRateBps as number) ?? 2,
    exceptionalMinHourlyMoveBps: (exceptional.minHourlyMoveBps as number) ?? 100,
    exceptionalMinMinuteRangeBps: (exceptional.minMinuteRangeBps as number) ?? 20,
    exceptionalMinNetEdgeBps: (exceptional.minNetEdgeBps as number) ?? 10,
    exitPolicyMode: ((exitPolicy.mode as string) === "exchange-native" ? "exchange-native" : "logical"),
    exitPolicySafetyDelayMs: (exitPolicy.safetyDelayMs as number) ?? 5000,
    exitPolicySafetyStopBps: (exitPolicy.safetyStopBps as number) ?? 60,
    bybitPositionMode,
    metaEnabled: (meta.enabled as boolean) ?? false,
    metaWarmupMinTrades: (meta.warmupMinTrades as number) ?? 5,
    metaPnlWindowSize: (meta.pnlWindowSize as number) ?? 50,
    metaIncludeAggressiveVariants:
      (meta.includeAggressiveVariants as boolean | undefined)
      ?? (tradingProfile === "aggressive-perps"),
    runtimeArtifactFlushTicks: (runtime.artifactFlushTicks as number) ?? 30,
    statePersistenceEnabled: (runtime.statePersistenceEnabled as boolean) ?? false,
    trailingStopEnabled: (trailingStop.enabled as boolean) ?? false,
    trailingStopActivationBps: (trailingStop.activationBps as number) ?? 30,
    trailingStopTrailBps: (trailingStop.trailBps as number) ?? 15,
    positionReconcileIntervalTicks: (reconcile.intervalTicks as number) ?? 30,
    setTradingStopRetryMax: (reconcile.setTradingStopRetryMax as number) ?? 3,
    setTradingStopRetryDelayMs: (reconcile.setTradingStopRetryDelayMs as number) ?? 500,
    drawdownVelocityWindowMs: (drawdown.velocityWindowMs as number) ?? 3_600_000,
    drawdownVelocityMaxUsd: (drawdown.velocityMaxUsd as number) ?? 30,
    drawdownMaxConsecutiveLosses: (drawdown.maxConsecutiveLosses as number) ?? 5,
    drawdownHaltCooldownMs: env.DRAWDOWN_HALT_COOLDOWN_MS
      ? Number(env.DRAWDOWN_HALT_COOLDOWN_MS)
      : ((drawdown.haltCooldownMs as number | undefined) ?? 3_600_000),
    confidenceSizingEnabled: (confidenceSizing.enabled as boolean) ?? false,
    confidenceSizingMinMultiplier: (confidenceSizing.minMultiplier as number) ?? 0.5,
    confidenceSizingMaxMultiplier: (confidenceSizing.maxMultiplier as number) ?? 2.0,
    bandit_halfLifeDays: (meta.halfLifeDays as number) ?? 0,
    alertWebhookUrl: (alerts.webhookUrl as string) ?? "",
    scanGateAutoTuneEnabled: (scanGateAutoTune.enabled as boolean) ?? false,
    scanGateAutoTunePercentile: ((): 50 | 75 | 90 => {
      const v = (scanGateAutoTune.percentile as number | undefined) ?? 75;
      return v === 50 ? 50 : v === 90 ? 90 : 75;
    })(),
    scanGateAutoTuneFallbackBps: (scanGateAutoTune.fallbackBps as number) ?? 15,
    scanMinOpenInterestUsd: (scanner.minOpenInterestUsd as number) ?? 0,
    scanMinListingAgeDays: (scanner.minListingAgeDays as number) ?? 0,
    scanExcludedSymbols: (scanner.excludedSymbols as string[]) ?? [],
    feeRoundTripBps: (bybit.feeRoundTripBps as number) ?? 0,
    requireLocalMaConfirmation: (strategy.requireLocalMaConfirmation as boolean | undefined) ?? true,
    strategyType,
    useBullmqJobs: (runtime.useBullmqJobs as boolean | undefined) ?? false,
    useWebSocket: (runtime.useWebSocket as boolean | undefined) ?? false,
    llmManagedAllowedSymbols: (llmManaged.allowedSymbols as string[]) ?? ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
    llmManagedOpenReviewIntervalSec: (llmManaged.openReviewIntervalSec as number) ?? 600,
    llmManagedManageReviewIntervalSec: (llmManaged.manageReviewIntervalSec as number) ?? 180,
    llmManagedMaxNotionalUsd: (llmManaged.maxNotionalUsd as number) ?? 100,
    llmManagedMaxLeverage: (llmManaged.maxLeverage as number) ?? 10,
    llmManagedMaxHoldHours: (llmManaged.maxHoldHours as number) ?? 24,
    llmManagedMaxAbsoluteLossUsd: (llmManaged.maxAbsoluteLossUsd as number) ?? 20,
    llmManagedHedgeMaxNotionalUsd: (llmManaged.hedgeMaxNotionalUsd as number) ?? 100,
    llmManagedModel: (llmManaged.model as string) ?? "claude-haiku-4-5-20251001",
    llmManagedTimeoutMs: (llmManaged.timeoutMs as number) ?? 15000,
    llmManagedPostCutLossCooldownMs: (llmManaged.postCutLossCooldownMs as number) ?? 1_800_000,
    calendarPerpSymbol: (calendarSpread.perpSymbol as string) ?? "BTCUSDT",
    calendarDatedSymbol: (calendarSpread.datedSymbol as string) ?? "",
    calendarDatedDeliveryAt: (calendarSpread.datedDeliveryAt as number) ?? 0,
    calendarEntryThresholdBps: (calendarSpread.entryThresholdBps as number) ?? 30,
    calendarExitThresholdBps: (calendarSpread.exitThresholdBps as number) ?? 5,
    calendarPreSettlementCloseHours: (calendarSpread.preSettlementCloseHours as number) ?? 24,
    calendarMaxNotionalUsdPerLeg: (calendarSpread.maxNotionalUsdPerLeg as number) ?? 200,
    calendarPollSec: (calendarSpread.pollSec as number) ?? 60,
    advisorEnabled: (advisor.enabled as boolean) ?? false,
    advisorIntervalMinutes: (advisor.intervalMinutes as number) ?? 30,
    advisorModel: (advisor.model as string) ?? "claude-haiku-4-5-20251001",
    orderSupervisorEnabled: (orderSupervisor.enabled as boolean) ?? false,
    orderSupervisorStrategies: (orderSupervisor.strategies as string[])
      ?? ["funding-arb", "basis-arb", "pairs-trading", "calendar-spread"],
    orderSupervisorMinConfidence: (orderSupervisor.minConfidence as number) ?? 0.5,
    orderSupervisorModel: (orderSupervisor.model as string) ?? "claude-haiku-4-5-20251001",
    orderSupervisorTimeoutMs: (orderSupervisor.timeoutMs as number) ?? 8000,
    orderSupervisorOnErrorBehavior:
      (orderSupervisor.onErrorBehavior as string) === "approve" ? "approve" : "reject",
    basisArbEntryThresholdBps: (basisArb.entryThresholdBps as number) ?? 8,
    basisArbExitThresholdBps: (basisArb.exitThresholdBps as number) ?? 2,
    basisArbMaxNotionalUsd: (basisArb.maxNotionalUsd as number) ?? 100,
    basisArbMaxHoldMinutes: (basisArb.maxHoldMinutes as number) ?? 240,
    fundingArbMinAbsRateBps: (fundingArb.minAbsRateBps as number) ?? 5,
    fundingArbEntryWindowMinutesBefore: (fundingArb.entryWindowMinutesBefore as number) ?? 5,
    fundingArbExitDelayMinutesAfter: (fundingArb.exitDelayMinutesAfter as number) ?? 2,
    fundingArbMaxLeverage: (fundingArb.maxLeverage as number) ?? 5,
    fundingArbMaxNotionalUsd: (fundingArb.maxNotionalUsd as number) ?? 100,
    longerTfKlineInterval: (longerTf.klineInterval as string) ?? "15",
    longerTfKlineRefreshSec: (longerTf.klineRefreshSec as number) ?? 60,
    longerTfFastWindow: (longerTf.fastWindow as number) ?? 6,
    longerTfSlowWindow: (longerTf.slowWindow as number) ?? 20,
    longerTfThresholdBps: (longerTf.thresholdBps as number) ?? 20,
    longerTfStopLossBps: (longerTf.stopLossBps as number) ?? 50,
    longerTfTakeProfitBps: (longerTf.takeProfitBps as number) ?? 150,
    pairsLeg1Symbol: (pairs.leg1Symbol as string) ?? "BTCUSDT",
    pairsLeg2Symbol: (pairs.leg2Symbol as string) ?? "ETHUSDT",
    pairsWindowSize: (pairs.windowSize as number) ?? 200,
    pairsEntryZ: (pairs.entryZ as number) ?? 2.0,
    pairsExitZ: (pairs.exitZ as number) ?? 0.3,
    pairsMaxHoldMinutes: (pairs.maxHoldMinutes as number) ?? 480,
    pairsMaxNotionalUsdPerLeg: (pairs.maxNotionalUsdPerLeg as number) ?? 100,
    pairsKlineInterval: (pairs.klineInterval as string) ?? "5",
    pairsKlineRefreshSec: (pairs.klineRefreshSec as number) ?? 30,
    bollingerAdxBbPeriod: (bollingerAdx.bbPeriod as number) ?? 20,
    bollingerAdxBbStdDev: (bollingerAdx.bbStdDev as number) ?? 2,
    bollingerAdxAdxPeriod: (bollingerAdx.adxPeriod as number) ?? 14,
    bollingerAdxAdxRangingThreshold: (bollingerAdx.adxRangingThreshold as number) ?? 20,
    bollingerAdxAdxTrendingThreshold: (bollingerAdx.adxTrendingThreshold as number) ?? 25,
    bollingerAdxStopLossBps: (bollingerAdx.stopLossBps as number) ?? 80,
    bollingerAdxTakeProfitBps: (bollingerAdx.takeProfitBps as number) ?? 150,
    bollingerAdxKlineInterval: (bollingerAdx.klineInterval as string) ?? "15",
    bollingerAdxKlineRefreshSec: (bollingerAdx.klineRefreshSec as number) ?? 60,
  };
}
