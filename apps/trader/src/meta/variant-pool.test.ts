import { describe, expect, test } from "bun:test";
import { defaultVariantPool } from "./variant-pool";
import type { TraderConfig } from "../config";

function makeConfig(overrides: Partial<TraderConfig> = {}): TraderConfig {
  return {
    mode: "trade",
    tradingProfile: "standard",
    entryExecutionMode: "taker",
    entryMakerOffsetTicks: 0,
    entryMakerPollMs: 100,
    entryMakerTimeoutMs: 100,
    autoSizeFromWallet: false,
    walletAccountType: "UNIFIED",
    walletCoin: "USDT",
    walletFraction: 1,
    walletMaxOrderUsdCap: null,
    category: "linear",
    symbol: "BTCUSDT",
    pollMs: 1000,
    orderUsd: 25,
    paperTrading: true,
    fastWindow: 5,
    slowWindow: 20,
    thresholdBps: 4,
    leverage: 1,
    stopLossBps: 20,
    takeProfitBps: 30,
    maxPositionUsd: 1_000,
    maxDailyLossUsd: 100,
    maxSpreadBps: 50,
    minTradeIntervalMs: 0,
    riskMaxFundingRateBps: 15,
    slippageTolerancePercent: 0.1,
    maxTicks: 0,
    tradeScanRefreshMs: 60_000,
    tradeMinSetupScore: 45,
    tradeMinSetupNetEdgeBps: 15,
    tickerFailureThreshold: 3,
    tickerFailureCooldownTicks: 20,
    exitPolicyMode: "logical",
    exitPolicySafetyDelayMs: 5_000,
    exitPolicySafetyStopBps: 60,
    aggressiveAllowedSymbols: [],
    aggressiveRequireScanCandidate: false,
    aggressiveScanCandidatesPath: "",
    aggressiveScanLatestPath: "",
    aggressiveScanMaxAgeMinutes: 30,
    tradeCandidateSymbols: [],
    aggressiveMaxLeverage: 100,
    aggressiveMaxFundingRateBps: 8,
    aggressiveMaxLossPerTradeUsd: 8,
    aggressiveMinEstimatedLiqBufferBps: 80,
    exceptionalLeverageEnabled: false,
    exceptionalAllowedSymbols: [],
    exceptionalLeverage: 100,
    exceptionalMaxSpreadBps: 0.5,
    exceptionalMaxFundingRateBps: 2,
    exceptionalMinHourlyMoveBps: 100,
    exceptionalMinMinuteRangeBps: 20,
    exceptionalMinNetEdgeBps: 10,
    runtimeArtifactFlushTicks: 30,
    statePersistenceEnabled: false,
    metaEnabled: true,
    metaWarmupMinTrades: 3,
    metaPnlWindowSize: 50,
    metaIncludeAggressiveVariants: false,
    bybitPositionMode: "one-way",
    trailingStopEnabled: false,
    trailingStopActivationBps: 30,
    trailingStopTrailBps: 15,
    positionReconcileIntervalTicks: 30,
    setTradingStopRetryMax: 3,
    setTradingStopRetryDelayMs: 500,
    drawdownVelocityWindowMs: 3_600_000,
    drawdownVelocityMaxUsd: 30,
    drawdownMaxConsecutiveLosses: 5,
    confidenceSizingEnabled: false,
    confidenceSizingMinMultiplier: 0.5,
    confidenceSizingMaxMultiplier: 2.0,
    bandit_halfLifeDays: 0,
    alertWebhookUrl: "",
    scanGateAutoTuneEnabled: false,
    scanGateAutoTunePercentile: 75,
    scanGateAutoTuneFallbackBps: 15,
    scanMinOpenInterestUsd: 0,
    scanMinListingAgeDays: 0,
    feeRoundTripBps: 0,
    ...overrides,
  };
}

const AGG_IDS = ["agg-25x-tight", "agg-50x-tight", "agg-75x-very-tight", "agg-100x-btc-only", "agg-50x-relaxed"];

describe("defaultVariantPool", () => {
  test("standard profile with default flag returns the 4 safe variants only", () => {
    const config = makeConfig({
      tradingProfile: "standard",
      metaIncludeAggressiveVariants: false,
    bybitPositionMode: "one-way",
    });
    const variants = defaultVariantPool(config);
    expect(variants).toHaveLength(4);
    for (const id of AGG_IDS) {
      expect(variants.find((v) => v.id === id)).toBeUndefined();
    }
  });

  test("aggressive-perps profile with default flag returns 8 variants", () => {
    const config = makeConfig({
      tradingProfile: "aggressive-perps",
      metaIncludeAggressiveVariants: true,
    bybitPositionMode: "one-way",
    });
    const variants = defaultVariantPool(config);
    expect(variants).toHaveLength(9);
    for (const id of AGG_IDS) {
      expect(variants.find((v) => v.id === id)).toBeDefined();
    }
  });

  test("standard profile + manual override includes aggressive variants", () => {
    const config = makeConfig({
      tradingProfile: "standard",
      metaIncludeAggressiveVariants: true,
    bybitPositionMode: "one-way",
    });
    const variants = defaultVariantPool(config);
    expect(variants).toHaveLength(9);
    for (const id of AGG_IDS) {
      expect(variants.find((v) => v.id === id)).toBeDefined();
    }
  });

  test("agg-100x-btc-only has BTCUSDT symbol filter and agg-50x-relaxed has none", () => {
    const config = makeConfig({
      tradingProfile: "aggressive-perps",
      metaIncludeAggressiveVariants: true,
      bybitPositionMode: "one-way",
    });
    const variants = defaultVariantPool(config);
    const btcOnly = variants.find((v) => v.id === "agg-100x-btc-only");
    const relaxed = variants.find((v) => v.id === "agg-50x-relaxed");
    expect(btcOnly).toBeDefined();
    expect(btcOnly!.symbolFilter).toEqual(["BTCUSDT"]);
    expect(relaxed).toBeDefined();
    expect(relaxed!.symbolFilter).toBeUndefined();
  });

  test("all aggressive variants have leverage > 1 and finite SL/TP", () => {
    const config = makeConfig({
      tradingProfile: "aggressive-perps",
      metaIncludeAggressiveVariants: true,
    bybitPositionMode: "one-way",
    });
    const variants = defaultVariantPool(config);
    const aggressive = variants.filter((v) => AGG_IDS.includes(v.id));
    expect(aggressive).toHaveLength(5);
    for (const v of aggressive) {
      expect(v.params.leverage).toBeGreaterThan(1);
      expect(Number.isFinite(v.params.stopLossBps)).toBe(true);
      expect(Number.isFinite(v.params.takeProfitBps)).toBe(true);
      expect(v.params.stopLossBps).toBeGreaterThan(0);
      expect(v.params.takeProfitBps).toBeGreaterThan(0);
      // Inherits standard risk knobs from config.
      expect(v.params.orderUsd).toBe(config.orderUsd);
      expect(v.params.maxPositionUsd).toBe(config.maxPositionUsd);
      expect(v.params.maxDailyLossUsd).toBe(config.maxDailyLossUsd);
      expect(v.params.maxSpreadBps).toBe(config.maxSpreadBps);
      expect(v.params.minTradeIntervalMs).toBe(config.minTradeIntervalMs);
    }
  });
});
