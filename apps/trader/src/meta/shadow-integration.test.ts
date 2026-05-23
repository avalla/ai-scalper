import { describe, expect, test } from "bun:test";
import type { InstrumentInfo, MarketTicker } from "@ai-scalper/bybit-client";
import type { TraderState } from "@ai-scalper/trading-core";
import { step } from "../trading/step";
import type { AggressivePerpsLimits } from "@ai-scalper/trading-core";
import { defaultVariantPool, type Variant } from "./variant-pool";
import {
  emptyAllocatorState,
  recordClosedTrade,
  selectChampion,
  type AllocatorState,
  type PersistedAllocator,
} from "./allocator";
import type { TraderConfig } from "../config";

const instrument: InstrumentInfo = {
  symbol: "BTCUSDT",
  leverageFilter: { minLeverage: "1", maxLeverage: "100", leverageStep: "0.01" },
  lotSizeFilter: {
    minNotionalValue: "5",
    maxOrderQty: "1000",
    maxMktOrderQty: "1000",
    minOrderQty: "0.001",
    qtyStep: "0.001",
  },
  priceFilter: { minPrice: "1", maxPrice: "1000000", tickSize: "0.1" },
};

function makeTicker(lastPrice: number, markPrice = lastPrice): MarketTicker {
  return {
    symbol: "BTCUSDT",
    lastPrice: lastPrice.toString(),
    markPrice: markPrice.toString(),
    indexPrice: lastPrice.toString(),
    prevPrice1h: lastPrice.toString(),
    prevPrice24h: lastPrice.toString(),
    price24hPcnt: "0",
    turnover24h: "0",
    volume24h: "0",
    openInterestValue: "0",
    fundingRate: "0",
    bid1Price: lastPrice.toString(),
    ask1Price: lastPrice.toString(),
    bid1Size: "0",
    ask1Size: "0",
  };
}

function makeConfig(): TraderConfig {
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
    aggressiveMaxLeverage: 50,
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
  };
}

/**
 * Synthetic tick stream: slow uptrend with sine-wave noise so that variants
 * see local reversals and can both open and close positions.
 */
function* tickStream(count: number): Generator<number> {
  const base = 100;
  for (let i = 0; i < count; i++) {
    // Larger amplitude noise (~2.5%) ensures even tight-stop variants trade.
    const trend = i * 0.1;
    const noise = Math.sin(i * 0.4) * 2.5 + Math.sin(i * 1.1) * 1.2;
    yield base + trend + noise;
  }
}

/** Deterministic uniform RNG in (0, 1). */
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("shadow integration", () => {
  test("running 200 ticks through 4 variants closes ≥1 trade per variant and explores champions", () => {
    const config = makeConfig();
    const variants: Variant[] = defaultVariantPool(config);
    expect(variants.length).toBe(4);

    const states = new Map<string, TraderState>(
      variants.map((v) => [v.id, {
        lastTradeAt: null,
        realizedPnlUsd: 0,
        position: null,
        dayStartedAt: null,
      } as TraderState]),
    );
    const histories = new Map<string, number[]>(
      variants.map((v) => [v.id, []]),
    );
    let allocator: AllocatorState = emptyAllocatorState();
    const championPicks: string[] = [];
    const rng = seededRng(12345);

    let t = 0;
    for (const lastPrice of tickStream(200)) {
      const now = 1_000_000 + t * 1_000;
      for (const v of variants) {
        const prevState = states.get(v.id)!;
        const history = histories.get(v.id)!;
        const result = step(
          {
            symbol: "BTCUSDT",
            ticker: makeTicker(lastPrice),
            instrument,
            now,
            priceHistory: history,
          },
          v.params,
          prevState,
        );
        if (prevState.position && !result.state.position) {
          const pnlDelta = result.state.realizedPnlUsd - prevState.realizedPnlUsd;
          allocator = recordClosedTrade(allocator, v.id, pnlDelta, now, config.metaPnlWindowSize);
        }
        states.set(v.id, result.state);
      }
      const pick = selectChampion({
        allocator,
        variants,
        now,
        warmupMinTrades: config.metaWarmupMinTrades,
        rng,
      });
      championPicks.push(pick.championId);
      t++;
    }

    // Each variant should have closed at least 1 trade over 200 noisy ticks.
    for (const v of variants) {
      const stats = allocator.stats[v.id];
      expect(stats).toBeDefined();
      expect(stats!.closedTrades).toBeGreaterThanOrEqual(1);
    }

    // Allocator should not lock in to a single champion every tick — exploration.
    const uniqueChampions = new Set(championPicks);
    expect(uniqueChampions.size).toBeGreaterThanOrEqual(2);
  });

  test("PersistedAllocator round-trips through JSON without losing shape", () => {
    let allocator = emptyAllocatorState();
    allocator = recordClosedTrade(allocator, "ma-5-20-th4", 0.5, 1_000);
    allocator = recordClosedTrade(allocator, "ma-5-20-th4", -0.2, 2_000);
    allocator = recordClosedTrade(allocator, "ma-3-15-th3", 1.0, 3_000);
    allocator = { ...allocator, championId: "ma-5-20-th4", selectedAt: 4_000 };

    const variantStates: Record<string, TraderState> = {
      "ma-5-20-th4": {
        lastTradeAt: 4_000,
        realizedPnlUsd: 0.3,
        position: null,
        dayStartedAt: 1_000,
      },
      "ma-3-15-th3": {
        lastTradeAt: 3_000,
        realizedPnlUsd: 1.0,
        position: null,
        dayStartedAt: 1_000,
      },
    };

    const payload: PersistedAllocator = {
      allocator,
      variantStates,
      lastTickAt: 5_000,
    };

    const serialized = JSON.stringify(payload);
    const restored = JSON.parse(serialized) as PersistedAllocator;

    expect(restored.allocator.championId).toBe("ma-5-20-th4");
    expect(restored.allocator.stats["ma-5-20-th4"]!.closedTrades).toBe(2);
    expect(restored.allocator.stats["ma-5-20-th4"]!.realizedPnlUsd).toBeCloseTo(0.3);
    expect(restored.allocator.stats["ma-3-15-th3"]!.recentPnlWindow).toEqual([1.0]);
    expect(restored.variantStates["ma-5-20-th4"]).toBeDefined();
    expect(restored.lastTickAt).toBe(5_000);
  });

  test("aggressive-perps variant pool drives ≥2 aggressive variants to close trades and explores them as champions", () => {
    const config: TraderConfig = {
      ...makeConfig(),
      tradingProfile: "aggressive-perps",
      aggressiveAllowedSymbols: ["BTCUSDT"],
      aggressiveMaxLeverage: 100,
      aggressiveMaxFundingRateBps: 10,
      aggressiveMaxLossPerTradeUsd: 20,
      aggressiveMinEstimatedLiqBufferBps: 50,
      orderUsd: 1, // keep notional small so loss-per-trade caps don't bind
      metaIncludeAggressiveVariants: true,
    bybitPositionMode: "one-way",
      metaWarmupMinTrades: 2,
    };
    const variants: Variant[] = defaultVariantPool(config);
    expect(variants).toHaveLength(8);

    const aggressiveLimits: AggressivePerpsLimits = {
      maxLeverage: config.aggressiveMaxLeverage,
      maxFundingRateBps: config.aggressiveMaxFundingRateBps,
      maxLossPerTradeUsd: config.aggressiveMaxLossPerTradeUsd,
      minEstimatedLiqBufferBps: config.aggressiveMinEstimatedLiqBufferBps,
      allowedSymbols: config.aggressiveAllowedSymbols,
    };

    const states = new Map<string, TraderState>(
      variants.map((v) => [v.id, {
        lastTradeAt: null,
        realizedPnlUsd: 0,
        position: null,
        dayStartedAt: null,
      } as TraderState]),
    );
    const histories = new Map<string, number[]>(
      variants.map((v) => [v.id, []]),
    );
    let allocator: AllocatorState = emptyAllocatorState();
    const championPicks: string[] = [];
    const rng = seededRng(42);

    let t = 0;
    for (const lastPrice of tickStream(300)) {
      const now = 2_000_000 + t * 1_000;
      for (const v of variants) {
        const prevState = states.get(v.id)!;
        const history = histories.get(v.id)!;
        const result = step(
          {
            symbol: "BTCUSDT",
            ticker: makeTicker(lastPrice),
            instrument,
            now,
            priceHistory: history,
            aggressivePerpsLimits: aggressiveLimits,
            fundingRateBps: 0,
          },
          v.params,
          prevState,
        );
        if (prevState.position && !result.state.position) {
          const pnlDelta = result.state.realizedPnlUsd - prevState.realizedPnlUsd;
          allocator = recordClosedTrade(allocator, v.id, pnlDelta, now, config.metaPnlWindowSize);
        }
        states.set(v.id, result.state);
      }
      const pick = selectChampion({
        allocator,
        variants,
        now,
        warmupMinTrades: config.metaWarmupMinTrades,
        rng,
      });
      championPicks.push(pick.championId);
      t++;
    }

    // The 100x variant has stopLossBps=6 → buffer = 100 - 6 = 94 ≥ 50 → NOT
    // systematically blocked by aggressive risk.
    const extreme = variants.find((v) => v.id === "agg-100x-extreme")!;
    expect(extreme.params.leverage).toBe(100);
    expect(extreme.params.stopLossBps).toBe(6);
    const liqDistance = 10_000 / extreme.params.leverage;
    expect(liqDistance - extreme.params.stopLossBps).toBeGreaterThanOrEqual(50);

    // At least 2 aggressive variants closed ≥1 trade each.
    const aggIds = ["agg-25x-tight", "agg-50x-tight", "agg-75x-very-tight", "agg-100x-extreme"];
    const aggressiveTraded = aggIds.filter((id) => (allocator.stats[id]?.closedTrades ?? 0) >= 1);
    expect(aggressiveTraded.length).toBeGreaterThanOrEqual(2);

    // Champion selection should at some point pick an aggressive variant.
    const pickedAnyAggressive = championPicks.some((id) => aggIds.includes(id));
    expect(pickedAnyAggressive).toBe(true);
  });

  test("variant pool params share risk knobs with live config", () => {
    const config = makeConfig();
    const variants = defaultVariantPool(config);
    for (const v of variants) {
      expect(v.params.maxPositionUsd).toBe(config.maxPositionUsd);
      expect(v.params.maxDailyLossUsd).toBe(config.maxDailyLossUsd);
      expect(v.params.maxSpreadBps).toBe(config.maxSpreadBps);
      expect(v.params.orderUsd).toBe(config.orderUsd);
      expect(v.params.leverage).toBe(config.leverage);
    }
    // Tight variant should have halved SL/TP.
    const tight = variants.find((v) => v.id === "ma-5-20-th4-tight")!;
    expect(tight.params.stopLossBps).toBe(config.stopLossBps * 0.5);
    expect(tight.params.takeProfitBps).toBe(config.takeProfitBps * 0.5);
  });
});
