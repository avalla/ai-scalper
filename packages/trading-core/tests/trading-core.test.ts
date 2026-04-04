import { describe, expect, test } from "bun:test";
import {
  evaluateAggressivePerpsRisk,
  buildSignal,
  evaluateRisk,
  getExitReason,
  selectLeverageForOpportunity,
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
