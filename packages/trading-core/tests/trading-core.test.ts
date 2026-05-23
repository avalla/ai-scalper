import { describe, expect, test } from "bun:test";
import {
  buildPositionTargets,
  evaluateAggressivePerpsRisk,
  buildSignal,
  evaluateRisk,
  getExitReason,
  selectLeverageForOpportunity,
  rolloverDailyPnlIfNeeded,
  scoreScalpCandidate,
  updatePaperState,
} from "../src/index";

describe("buildSignal", () => {
  test("returns long when fast average is above slow average by threshold", () => {
    expect(buildSignal({
      prices: [100, 100.2, 100.4, 100.6, 101, 101.4],
      fastWindow: 3,
      slowWindow: 6,
      thresholdBps: 10,
    })).toBe("long");
  });

  test("returns flat when there is not enough data", () => {
    expect(buildSignal({
      prices: [100, 100.1],
      fastWindow: 3,
      slowWindow: 5,
      thresholdBps: 5,
    })).toBe("flat");
  });
});

describe("evaluateRisk", () => {
  test("blocks trades when spread is too wide", () => {
    expect(evaluateRisk({
      action: "long",
      limits: {
        maxPositionUsd: 100,
        maxDailyLossUsd: 50,
        minTradeIntervalMs: 1_000,
        maxSpreadBps: 5,
      },
      market: {
        lastPrice: 101,
        markPrice: 100,
      },
      now: Date.now(),
      orderUsd: 10,
      state: {
        lastTradeAt: null,
        realizedPnlUsd: 0,
        position: null,
        dayStartedAt: null,
      },
    })).toEqual({
      allowed: false,
      reason: "spread-too-wide",
    });
  });

  test("blocks trades when leveraged notional exceeds the position limit", () => {
    expect(evaluateRisk({
      action: "long",
      limits: {
        maxPositionUsd: 100,
        maxDailyLossUsd: 50,
        minTradeIntervalMs: 1_000,
        maxSpreadBps: 20,
      },
      market: {
        lastPrice: 100,
        markPrice: 100,
      },
      now: Date.now(),
      orderUsd: 120,
      state: {
        lastTradeAt: null,
        realizedPnlUsd: 0,
        position: null,
        dayStartedAt: null,
      },
    })).toEqual({
      allowed: false,
      reason: "position-limit",
    });
  });
});

describe("paper trading state", () => {
  test("opens and closes a long position with realized profit", () => {
    const opened = updatePaperState({
      action: "long",
      leverage: 5,
      notionalUsd: 100,
      price: 100,
      previous: {
        lastTradeAt: null,
        realizedPnlUsd: 0,
        position: null,
        dayStartedAt: null,
      },
      now: 1,
      stopLossBps: 20,
      takeProfitBps: 30,
    });

    expect(opened.position).toMatchObject({
      side: "long",
      leverage: 5,
      quantity: 1,
      notionalUsd: 100,
      entryPrice: 100,
      openedAt: 1,
    });
    expect(opened.position?.stopLossPrice).toBeCloseTo(99.8);
    expect(opened.position?.takeProfitPrice).toBeCloseTo(100.3);

    const closed = updatePaperState({
      action: "short",
      leverage: 5,
      notionalUsd: 100,
      price: 101,
      previous: opened,
      now: 2,
      stopLossBps: 20,
      takeProfitBps: 30,
      reduceOnly: true,
    });

    expect(closed.position).toBeNull();
    expect(closed.realizedPnlUsd).toBe(1);
  });

  test("builds symmetric targets for long and short positions", () => {
    expect(buildPositionTargets({
      action: "long",
      price: 100,
      stopLossBps: 20,
      takeProfitBps: 30,
    })).toEqual({
      stopLossPrice: 99.8,
      takeProfitPrice: 100.29999999999998,
    });

    expect(buildPositionTargets({
      action: "short",
      price: 100,
      stopLossBps: 20,
      takeProfitBps: 30,
    })).toEqual({
      stopLossPrice: 100.2,
      takeProfitPrice: 99.7,
    });
  });

  test("returns a stop loss exit for a short position when price rises", () => {
    const state = updatePaperState({
      action: "short",
      leverage: 3,
      notionalUsd: 90,
      price: 100,
      previous: {
        lastTradeAt: null,
        realizedPnlUsd: 0,
        position: null,
        dayStartedAt: null,
      },
      now: 1,
      stopLossBps: 20,
      takeProfitBps: 30,
    });

    expect(getExitReason({
      marketPrice: 100.25,
      signal: "flat",
      state,
    })).toBe("stop-loss");
  });
});

describe("market scanner scoring", () => {
  test("scores a liquid, tight-spread pair as a candidate", () => {
    const candidate = scoreScalpCandidate({
      symbol: "BTCUSDT",
      lastPrice: 67_210.5,
      bidPrice: 67_210.5,
      askPrice: 67_210.6,
      turnover24h: 6_258_816_008,
      openInterestValue: 3_358_478_664,
      price24hPcnt: 0.000364,
      prevPrice1h: 67_016.7,
      fundingRate: -0.00000598,
      maxLeverage: 100,
      minuteRangeBps: 28,
      estimatedRoundTripCostBps: 10,
      minNetEdgeBps: 4,
    });

    expect(candidate?.symbol).toBe("BTCUSDT");
    expect(candidate?.score).toBeGreaterThan(40);
    expect(candidate?.spreadBps).toBeLessThan(1);
    expect(candidate?.netEdgeBps).toBeGreaterThan(0);
  });

  test("rejects an illiquid or too-wide pair", () => {
    expect(scoreScalpCandidate({
      symbol: "WIDEUSDT",
      lastPrice: 10,
      bidPrice: 9.9,
      askPrice: 10.1,
      turnover24h: 500_000,
      openInterestValue: 100_000,
      price24hPcnt: 0.05,
      prevPrice1h: 9.8,
      fundingRate: 0.0001,
      maxLeverage: 10,
      minuteRangeBps: 30,
    })).toBeNull();
  });

  test("rejects a pair when expected micro edge does not clear trading costs", () => {
    expect(scoreScalpCandidate({
      symbol: "THINEDGEUSDT",
      lastPrice: 100,
      bidPrice: 99.99,
      askPrice: 100.01,
      turnover24h: 5_000_000,
      openInterestValue: 3_000_000,
      price24hPcnt: 0.01,
      prevPrice1h: 99.8,
      fundingRate: 0.00005,
      maxLeverage: 25,
      minuteRangeBps: 10,
      estimatedRoundTripCostBps: 12,
      minNetEdgeBps: 3,
    })).toBeNull();
  });
});

describe("aggressive perps risk", () => {
  test("treats an empty aggressive whitelist as market-wide", () => {
    expect(evaluateAggressivePerpsRisk({
      symbol: "PEPEUSDT",
      leverage: 10,
      fundingRateBps: 1,
      notionalUsd: 100,
      stopLossBps: 20,
      limits: {
        maxLeverage: 50,
        maxFundingRateBps: 8,
        maxLossPerTradeUsd: 8,
        minEstimatedLiqBufferBps: 80,
        allowedSymbols: [],
      },
    })).toEqual({
      allowed: true,
    });
  });

  test("blocks symbols outside the aggressive whitelist", () => {
    expect(evaluateAggressivePerpsRisk({
      symbol: "PEPEUSDT",
      leverage: 25,
      fundingRateBps: 1,
      notionalUsd: 250,
      stopLossBps: 20,
      limits: {
        maxLeverage: 50,
        maxFundingRateBps: 8,
        maxLossPerTradeUsd: 8,
        minEstimatedLiqBufferBps: 80,
        allowedSymbols: ["BTCUSDT", "ETHUSDT"],
      },
    })).toEqual({
      allowed: false,
      reason: "symbol-not-allowed",
    });
  });

  test("blocks setups with too little estimated liquidation buffer", () => {
    expect(evaluateAggressivePerpsRisk({
      symbol: "BTCUSDT",
      leverage: 100,
      fundingRateBps: 1,
      notionalUsd: 500,
      stopLossBps: 40,
      limits: {
        maxLeverage: 100,
        maxFundingRateBps: 8,
        maxLossPerTradeUsd: 8,
        minEstimatedLiqBufferBps: 80,
        allowedSymbols: ["BTCUSDT", "ETHUSDT"],
      },
    })).toEqual({
      allowed: false,
      reason: "liq-buffer-too-small",
    });
  });

  test("allows an aggressive setup that stays within caps", () => {
    expect(evaluateAggressivePerpsRisk({
      symbol: "ETHUSDT",
      leverage: 25,
      fundingRateBps: 1,
      notionalUsd: 250,
      stopLossBps: 20,
      limits: {
        maxLeverage: 50,
        maxFundingRateBps: 8,
        maxLossPerTradeUsd: 8,
        minEstimatedLiqBufferBps: 80,
        allowedSymbols: ["BTCUSDT", "ETHUSDT"],
      },
    })).toEqual({
      allowed: true,
    });
  });
});

describe("exceptional leverage policy", () => {
  test("promotes to exceptional leverage when all gates pass", () => {
    expect(selectLeverageForOpportunity({
      symbol: "BTCUSDT",
      configuredLeverage: 25,
      fundingRateBps: 1,
      spreadBps: 0.3,
      hourlyMoveBps: 120,
      minuteRangeBps: 28,
      netEdgeBps: 14,
      policy: {
        allowedSymbols: ["BTCUSDT", "ETHUSDT"],
        exceptionalLeverage: 100,
        maxSpreadBps: 0.5,
        maxFundingRateBps: 2,
        minHourlyMoveBps: 100,
        minMinuteRangeBps: 20,
        minNetEdgeBps: 10,
      },
    })).toEqual({
      leverage: 100,
      exceptional: true,
      reason: "exceptional-conditions-met",
    });
  });

  test("keeps base leverage when spread gate fails", () => {
    expect(selectLeverageForOpportunity({
      symbol: "BTCUSDT",
      configuredLeverage: 25,
      fundingRateBps: 1,
      spreadBps: 1.2,
      hourlyMoveBps: 120,
      minuteRangeBps: 28,
      netEdgeBps: 14,
      policy: {
        allowedSymbols: ["BTCUSDT", "ETHUSDT"],
        exceptionalLeverage: 100,
        maxSpreadBps: 0.5,
        maxFundingRateBps: 2,
        minHourlyMoveBps: 100,
        minMinuteRangeBps: 20,
        minNetEdgeBps: 10,
      },
    })).toEqual({
      leverage: 25,
      exceptional: false,
      reason: "spread-too-wide",
    });
  });
});

describe("buildSignal - additional cases", () => {
  test("returns short when fast average is below slow average by threshold", () => {
    expect(buildSignal({
      prices: [101, 100.8, 100.6, 100.4, 100, 99.6],
      fastWindow: 3,
      slowWindow: 6,
      thresholdBps: 10,
    })).toBe("short");
  });

  test("returns flat when divergence does not reach threshold", () => {
    expect(buildSignal({
      prices: [100, 100, 100, 100, 100, 100.001],
      fastWindow: 3,
      slowWindow: 6,
      thresholdBps: 10,
    })).toBe("flat");
  });
});

describe("evaluateRisk - additional cases", () => {
  const baseLimits = {
    maxPositionUsd: 100,
    maxDailyLossUsd: 50,
    minTradeIntervalMs: 15_000,
    maxSpreadBps: 20,
  };
  const baseMarket = { lastPrice: 100, markPrice: 100 };
  const cleanState = { lastTradeAt: null, realizedPnlUsd: 0, position: null, dayStartedAt: null };

  test("allows a valid trade", () => {
    expect(evaluateRisk({
      action: "long",
      limits: baseLimits,
      market: baseMarket,
      now: 100_000,
      orderUsd: 50,
      state: cleanState,
    })).toEqual({ allowed: true });
  });

  test("blocks when action is flat", () => {
    expect(evaluateRisk({
      action: "flat",
      limits: baseLimits,
      market: baseMarket,
      now: 100_000,
      orderUsd: 50,
      state: cleanState,
    })).toEqual({ allowed: false, reason: "signal-flat" });
  });

  test("blocks when cooldown is active", () => {
    const now = 100_000;
    expect(evaluateRisk({
      action: "long",
      limits: baseLimits,
      market: baseMarket,
      now,
      orderUsd: 50,
      state: { ...cleanState, lastTradeAt: now - 5_000 },
    })).toEqual({ allowed: false, reason: "cooldown-active" });
  });

  test("blocks when daily loss limit is reached on same UTC day", () => {
    expect(evaluateRisk({
      action: "long",
      limits: baseLimits,
      market: baseMarket,
      now: 100_000,
      orderUsd: 50,
      state: { ...cleanState, realizedPnlUsd: -50, dayStartedAt: 100_000 },
    })).toEqual({ allowed: false, reason: "daily-loss-limit" });
  });

  test("does not block when realized PnL is from a prior UTC day", () => {
    expect(evaluateRisk({
      action: "long",
      limits: baseLimits,
      market: baseMarket,
      now: 100_000,
      orderUsd: 50,
      state: { ...cleanState, realizedPnlUsd: -50, dayStartedAt: null },
    })).toEqual({ allowed: true });
  });
});

describe("getExitReason", () => {
  const longState = updatePaperState({
    action: "long",
    leverage: 5,
    notionalUsd: 100,
    price: 100,
    previous: { lastTradeAt: null, realizedPnlUsd: 0, position: null, dayStartedAt: null },
    now: 1,
    stopLossBps: 20,
    takeProfitBps: 30,
  });

  const shortState = updatePaperState({
    action: "short",
    leverage: 3,
    notionalUsd: 90,
    price: 100,
    previous: { lastTradeAt: null, realizedPnlUsd: 0, position: null, dayStartedAt: null },
    now: 1,
    stopLossBps: 20,
    takeProfitBps: 30,
  });

  test("returns null when there is no open position", () => {
    expect(getExitReason({
      marketPrice: 100,
      signal: "flat",
      state: { lastTradeAt: null, realizedPnlUsd: 0, position: null, dayStartedAt: null },
    })).toBeNull();
  });

  test("returns take-profit for a long when price reaches TP", () => {
    expect(getExitReason({ marketPrice: 100.3, signal: "flat", state: longState })).toBe("take-profit");
  });

  test("returns stop-loss for a long when price reaches SL", () => {
    expect(getExitReason({ marketPrice: 99.8, signal: "flat", state: longState })).toBe("stop-loss");
  });

  test("returns signal-reversal for a long when a short signal fires", () => {
    expect(getExitReason({ marketPrice: 100.1, signal: "short", state: longState })).toBe("signal-reversal");
  });

  test("returns null for a long when no exit condition is met", () => {
    expect(getExitReason({ marketPrice: 100.1, signal: "flat", state: longState })).toBeNull();
  });

  test("returns take-profit for a short when price falls to TP", () => {
    expect(getExitReason({ marketPrice: 99.7, signal: "flat", state: shortState })).toBe("take-profit");
  });

  test("returns signal-reversal for a short when a long signal fires", () => {
    expect(getExitReason({ marketPrice: 99.9, signal: "long", state: shortState })).toBe("signal-reversal");
  });
});

describe("updatePaperState - fee tracking", () => {
  test("deducts feeRoundTripBps from realizedPnlUsd on close", () => {
    const opened = updatePaperState({
      action: "long",
      leverage: 10,
      notionalUsd: 1000,
      price: 100,
      previous: { lastTradeAt: null, realizedPnlUsd: 0, position: null, dayStartedAt: null },
      now: 1,
      stopLossBps: 20,
      takeProfitBps: 30,
    });
    expect(opened.position).not.toBeNull();
    const closed = updatePaperState({
      action: "short",
      leverage: 10,
      notionalUsd: 1000,
      price: 100.3, // +30bps gross
      previous: opened,
      now: 2,
      stopLossBps: 20,
      takeProfitBps: 30,
      reduceOnly: true,
      feeRoundTripBps: 11, // 0.11% of 1000 notional = $1.10 fee
    });
    // gross PnL = 10 units × 0.3 = 3, minus $1.10 fee = $1.90
    expect(closed.realizedPnlUsd).toBeCloseTo(1.9, 2);
  });

  test("feeRoundTripBps=0 (default) preserves legacy behaviour", () => {
    const opened = updatePaperState({
      action: "long",
      leverage: 10,
      notionalUsd: 1000,
      price: 100,
      previous: { lastTradeAt: null, realizedPnlUsd: 0, position: null, dayStartedAt: null },
      now: 1,
      stopLossBps: 20,
      takeProfitBps: 30,
    });
    const closed = updatePaperState({
      action: "short",
      leverage: 10,
      notionalUsd: 1000,
      price: 100.3,
      previous: opened,
      now: 2,
      stopLossBps: 20,
      takeProfitBps: 30,
      reduceOnly: true,
    });
    expect(closed.realizedPnlUsd).toBeCloseTo(3.0, 2);
  });
});

describe("updatePaperState - additional cases", () => {
  test("opens a short position with correct stop-loss and take-profit prices", () => {
    const state = updatePaperState({
      action: "short",
      leverage: 3,
      notionalUsd: 90,
      price: 100,
      previous: { lastTradeAt: null, realizedPnlUsd: 0, position: null, dayStartedAt: null },
      now: 1,
      stopLossBps: 20,
      takeProfitBps: 30,
    });
    expect(state.position?.side).toBe("short");
    expect(state.position?.stopLossPrice).toBeCloseTo(100.2);
    expect(state.position?.takeProfitPrice).toBeCloseTo(99.7);
  });

  test("reduceOnly with no open position is a no-op (preserves PnL, initializes dayStartedAt)", () => {
    const prev = { lastTradeAt: null as number | null, realizedPnlUsd: 5, position: null, dayStartedAt: null };
    const result = updatePaperState({
      action: "long",
      leverage: 1,
      notionalUsd: 100,
      price: 100,
      previous: prev,
      now: 1,
      stopLossBps: 20,
      takeProfitBps: 30,
      reduceOnly: true,
    });
    expect(result.position).toBeNull();
    expect(result.realizedPnlUsd).toBe(5);
    expect(result.dayStartedAt).toBe(1);
  });
});

describe("scoreScalpCandidate - additional cases", () => {
  test("returns null when any price input is zero or negative", () => {
    const base = {
      symbol: "XUSDT",
      lastPrice: 100,
      bidPrice: 0,
      askPrice: 100.01,
      turnover24h: 5_000_000,
      openInterestValue: 3_000_000,
      price24hPcnt: 0.01,
      prevPrice1h: 99.8,
      fundingRate: 0.00005,
      maxLeverage: 25,
      minuteRangeBps: 25,
    };
    expect(scoreScalpCandidate({ ...base, bidPrice: 0 })).toBeNull();
    expect(scoreScalpCandidate({ ...base, askPrice: 0 })).toBeNull();
    expect(scoreScalpCandidate({ ...base, lastPrice: 0 })).toBeNull();
  });
});

describe("evaluateAggressivePerpsRisk - additional cases", () => {
  const baseLimits = {
    maxLeverage: 50,
    maxFundingRateBps: 8,
    maxLossPerTradeUsd: 8,
    minEstimatedLiqBufferBps: 80,
    allowedSymbols: [] as string[],
  };

  test("blocks when funding rate is too high", () => {
    expect(evaluateAggressivePerpsRisk({
      symbol: "BTCUSDT",
      leverage: 10,
      fundingRateBps: 12,
      notionalUsd: 100,
      stopLossBps: 20,
      limits: baseLimits,
    })).toEqual({ allowed: false, reason: "funding-too-high" });
  });

  test("blocks when leverage exceeds the limit", () => {
    expect(evaluateAggressivePerpsRisk({
      symbol: "BTCUSDT",
      leverage: 75,
      fundingRateBps: 1,
      notionalUsd: 100,
      stopLossBps: 20,
      limits: baseLimits,
    })).toEqual({ allowed: false, reason: "leverage-too-high" });
  });

  test("blocks when estimated loss at stop exceeds per-trade limit", () => {
    expect(evaluateAggressivePerpsRisk({
      symbol: "BTCUSDT",
      leverage: 10,
      fundingRateBps: 1,
      notionalUsd: 1_000,
      stopLossBps: 100,
      limits: baseLimits,
    })).toEqual({ allowed: false, reason: "loss-per-trade-limit" });
  });
});

describe("selectLeverageForOpportunity - additional gates", () => {
  const basePolicy = {
    allowedSymbols: ["BTCUSDT", "ETHUSDT"],
    exceptionalLeverage: 100,
    maxSpreadBps: 0.5,
    maxFundingRateBps: 2,
    minHourlyMoveBps: 100,
    minMinuteRangeBps: 20,
    minNetEdgeBps: 10,
  };
  const baseParams = {
    symbol: "BTCUSDT",
    configuredLeverage: 25,
    fundingRateBps: 1,
    spreadBps: 0.3,
    hourlyMoveBps: 120,
    minuteRangeBps: 28,
    netEdgeBps: 14,
  };

  test("allows any symbol when allowedSymbols is empty", () => {
    expect(selectLeverageForOpportunity({
      ...baseParams,
      symbol: "SOLUSDT",
      policy: { ...basePolicy, allowedSymbols: [] },
    })).toMatchObject({ leverage: 100, exceptional: true, reason: "exceptional-conditions-met" });
  });

  test("keeps base leverage when symbol is not whitelisted", () => {
    expect(selectLeverageForOpportunity({
      ...baseParams,
      symbol: "SOLUSDT",
      policy: basePolicy,
    })).toMatchObject({ leverage: 25, exceptional: false, reason: "symbol-not-whitelisted" });
  });

  test("keeps base leverage when funding rate is too high", () => {
    expect(selectLeverageForOpportunity({
      ...baseParams,
      fundingRateBps: 5,
      policy: basePolicy,
    })).toMatchObject({ leverage: 25, exceptional: false, reason: "funding-too-high" });
  });

  test("keeps base leverage when hourly move is too small", () => {
    expect(selectLeverageForOpportunity({
      ...baseParams,
      hourlyMoveBps: 50,
      policy: basePolicy,
    })).toMatchObject({ leverage: 25, exceptional: false, reason: "hourly-move-too-small" });
  });

  test("keeps base leverage when minute range is too small", () => {
    expect(selectLeverageForOpportunity({
      ...baseParams,
      minuteRangeBps: 10,
      policy: basePolicy,
    })).toMatchObject({ leverage: 25, exceptional: false, reason: "minute-range-too-small" });
  });

  test("keeps base leverage when net edge is too small", () => {
    expect(selectLeverageForOpportunity({
      ...baseParams,
      netEdgeBps: 5,
      policy: basePolicy,
    })).toMatchObject({ leverage: 25, exceptional: false, reason: "net-edge-too-small" });
  });
});

describe("rolloverDailyPnlIfNeeded", () => {
  const t0 = Date.UTC(2026, 0, 15, 10, 0, 0);
  test("same UTC day leaves realized PnL unchanged", () => {
    const state = {
      lastTradeAt: t0,
      realizedPnlUsd: -25,
      position: null,
      dayStartedAt: t0,
    };
    const result = rolloverDailyPnlIfNeeded(state, t0 + 2 * 60 * 60 * 1000);
    expect(result.realizedPnlUsd).toBe(-25);
    expect(result.dayStartedAt).toBe(t0);
  });

  test("crossing UTC day resets realized PnL and updates dayStartedAt", () => {
    const state = {
      lastTradeAt: t0,
      realizedPnlUsd: -25,
      position: null,
      dayStartedAt: t0,
    };
    const nextDay = t0 + 24 * 60 * 60 * 1000;
    const result = rolloverDailyPnlIfNeeded(state, nextDay);
    expect(result.realizedPnlUsd).toBe(0);
    expect(result.dayStartedAt).toBe(nextDay);
  });

  test("initializes dayStartedAt when null", () => {
    const state = {
      lastTradeAt: null,
      realizedPnlUsd: 0,
      position: null,
      dayStartedAt: null,
    };
    const result = rolloverDailyPnlIfNeeded(state, t0);
    expect(result.dayStartedAt).toBe(t0);
    expect(result.realizedPnlUsd).toBe(0);
  });
});
