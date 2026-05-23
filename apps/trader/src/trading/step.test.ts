import { describe, expect, test } from "bun:test";
import type { InstrumentInfo, MarketTicker } from "@ai-scalper/bybit-client";
import type { TraderState } from "@ai-scalper/trading-core";
import { step, type StepParams } from "./step";
import type { AggressivePerpsLimits } from "@ai-scalper/trading-core";

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
    nextFundingTime: "0",
    bid1Price: lastPrice.toString(),
    ask1Price: lastPrice.toString(),
    bid1Size: "0",
    ask1Size: "0",
  };
}

const baseParams: StepParams = {
  fastWindow: 3,
  slowWindow: 6,
  thresholdBps: 10,
  stopLossBps: 20,
  takeProfitBps: 30,
  leverage: 1,
  orderUsd: 100,
  maxPositionUsd: 1_000,
  maxDailyLossUsd: 100,
  maxSpreadBps: 50,
  minTradeIntervalMs: 0,
};

const emptyState: TraderState = {
  lastTradeAt: null,
  realizedPnlUsd: 0,
  position: null,
  dayStartedAt: null,
};

describe("step", () => {
  test("returns flat with no position when there is insufficient history", () => {
    const history: number[] = [];
    const result = step(
      {
        symbol: "BTCUSDT",
        ticker: makeTicker(100),
        instrument,
        now: 1,
        priceHistory: history,
      },
      baseParams,
      emptyState,
    );

    expect(result.action).toBe("flat");
    expect(result.state.position).toBeNull();
    expect(result.fillPrice).toBeNull();
    expect(history).toEqual([100]);
  });

  test("opens a long position when fast > slow + threshold", () => {
    // Build a history that already has slowWindow points and slopes up sharply
    // so the next tick at 101.4 triggers a long entry.
    const history = [100, 100.2, 100.4, 100.6, 101];
    let state: TraderState = emptyState;
    const result = step(
      {
        symbol: "BTCUSDT",
        ticker: makeTicker(101.4),
        instrument,
        now: 1_000,
        priceHistory: history,
      },
      baseParams,
      state,
    );

    expect(result.action).toBe("long");
    expect(result.riskReason).toBe("allowed");
    expect(result.state.position).not.toBeNull();
    expect(result.state.position?.side).toBe("long");
    expect(result.state.position?.entryPrice).toBeCloseTo(101.4);
    expect(result.fillPrice).toBeCloseTo(101.4);
  });

  test("closes a long position on take-profit hit", () => {
    // Seed an open long position via a prior step.
    const history = [100, 100.2, 100.4, 100.6, 101];
    let state = step(
      {
        symbol: "BTCUSDT",
        ticker: makeTicker(101.4),
        instrument,
        now: 1_000,
        priceHistory: history,
      },
      baseParams,
      emptyState,
    ).state;

    expect(state.position?.side).toBe("long");
    const tpPrice = state.position!.takeProfitPrice;

    // Next tick prints at or above take-profit price → close.
    // Use a long cooldown so the post-close tick doesn't immediately re-enter
    // on the still-bullish signal.
    const result = step(
      {
        symbol: "BTCUSDT",
        ticker: makeTicker(tpPrice + 0.5),
        instrument,
        now: 2_000,
        priceHistory: history,
      },
      { ...baseParams, minTradeIntervalMs: 60_000 },
      state,
    );

    expect(result.exitReason).toBe("take-profit");
    expect(result.state.position).toBeNull();
    expect(result.state.realizedPnlUsd).toBeGreaterThan(0);
  });

  test("aggressive cap rejects a 100x variant when stopLoss eats the liq buffer", () => {
    // 100x → liq distance ≈ 10000/100 = 100bps. Min buffer 50bps required.
    // stopLossBps = 80 → buffer after stop = 100 - 80 = 20bps < 50bps → reject.
    const history = [100, 100.2, 100.4, 100.6, 101];
    const aggParams: StepParams = {
      ...baseParams,
      leverage: 100,
      stopLossBps: 80,
      takeProfitBps: 100,
      orderUsd: 1, // notional = 100; loss-at-stop = 100 * 80/10000 = 0.8usd → OK
    };
    const limits: AggressivePerpsLimits = {
      maxLeverage: 100,
      maxFundingRateBps: 50,
      maxLossPerTradeUsd: 50,
      minEstimatedLiqBufferBps: 50,
      allowedSymbols: ["BTCUSDT"],
    };
    const result = step(
      {
        symbol: "BTCUSDT",
        ticker: makeTicker(101.4),
        instrument,
        now: 1_000,
        priceHistory: history,
        aggressivePerpsLimits: limits,
        fundingRateBps: 0,
      },
      aggParams,
      emptyState,
    );

    expect(result.action).toBe("long");
    expect(result.riskReason).toBe("liq-buffer-too-small");
    expect(result.state.position).toBeNull();
  });

  test("aggressive cap allows the same 100x variant when stopLoss is tight enough", () => {
    // 100x → liq distance ≈ 100bps. stopLossBps = 6 → buffer = 94bps ≥ 50bps → allow.
    const history = [100, 100.2, 100.4, 100.6, 101];
    const aggParams: StepParams = {
      ...baseParams,
      leverage: 100,
      stopLossBps: 6,
      takeProfitBps: 12,
      orderUsd: 1,
    };
    const limits: AggressivePerpsLimits = {
      maxLeverage: 100,
      maxFundingRateBps: 50,
      maxLossPerTradeUsd: 50,
      minEstimatedLiqBufferBps: 50,
      allowedSymbols: ["BTCUSDT"],
    };
    const result = step(
      {
        symbol: "BTCUSDT",
        ticker: makeTicker(101.4),
        instrument,
        now: 1_000,
        priceHistory: history,
        aggressivePerpsLimits: limits,
        fundingRateBps: 0,
      },
      aggParams,
      emptyState,
    );

    expect(result.action).toBe("long");
    expect(result.riskReason).toBe("allowed");
    expect(result.state.position).not.toBeNull();
    expect(result.state.position?.side).toBe("long");
  });

  test("rejects entry when spread is too wide", () => {
    const history = [100, 100.2, 100.4, 100.6, 101];
    // lastPrice diverges from markPrice → spread far exceeds maxSpreadBps=5.
    const tightSpreadParams: StepParams = { ...baseParams, maxSpreadBps: 5 };
    const result = step(
      {
        symbol: "BTCUSDT",
        ticker: makeTicker(101.4, 100),
        instrument,
        now: 1_000,
        priceHistory: history,
      },
      tightSpreadParams,
      emptyState,
    );

    expect(result.action).toBe("long");
    expect(result.riskReason).toBe("spread-too-wide");
    expect(result.state.position).toBeNull();
    expect(result.fillPrice).toBeNull();
  });
});
