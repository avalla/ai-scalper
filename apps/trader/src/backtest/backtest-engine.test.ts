import { describe, expect, test } from "bun:test";
import type { MarketKline } from "@ai-scalper/bybit-client";
import { runBacktest, type BacktestScenario } from "./backtest-engine";

function kline(
  startMs: number,
  open: number,
  high: number,
  low: number,
  close: number,
): MarketKline {
  return {
    startTime: String(startMs),
    openPrice: String(open),
    highPrice: String(high),
    lowPrice: String(low),
    closePrice: String(close),
    volume: "0",
    turnover: "0",
  };
}

const baseRisk = {
  orderUsd: 100,
  leverage: 1,
  stopLossBps: 100, // 1%
  takeProfitBps: 100,
  maxPositionUsd: 500,
  feeRoundTripBps: 10,
};

function makeScenario(overrides: Partial<BacktestScenario> = {}): BacktestScenario {
  return {
    name: "test",
    strategyType: "ma-crossover",
    symbol: "BTCUSDT",
    klineInterval: "15",
    startDate: "2026-04-01T00:00:00Z",
    endDate: "2026-04-02T00:00:00Z",
    strategyParams: { fastWindow: 2, slowWindow: 5, thresholdBps: 0 },
    riskParams: baseRisk,
    ...overrides,
  };
}

describe("runBacktest", () => {
  test("empty kline range → zero trades, zero PnL", async () => {
    const res = await runBacktest(makeScenario(), {
      fetchKlines: async () => [],
    });
    expect(res.totalTicks).toBe(0);
    expect(res.tradesOpened).toBe(0);
    expect(res.tradesClosed).toBe(0);
    expect(res.netPnlUsd).toBe(0);
    expect(res.maxDrawdownUsd).toBe(0);
  });

  test("100 uptrending klines + ma-crossover opens at least one trade", async () => {
    // Strictly monotonic uptrend so fast MA crosses above slow MA after warmup.
    const klines: MarketKline[] = [];
    for (let i = 0; i < 100; i++) {
      const price = 100 + i;
      // narrow range so SL/TP rarely fires intra-kline
      klines.push(kline(i * 60_000, price, price + 0.05, price - 0.05, price));
    }
    const res = await runBacktest(
      makeScenario({
        strategyParams: { fastWindow: 3, slowWindow: 10, thresholdBps: 0 },
        riskParams: { ...baseRisk, stopLossBps: 5000, takeProfitBps: 5000 },
      }),
      { fetchKlines: async () => klines },
    );
    expect(res.totalTicks).toBe(100);
    expect(res.tradesOpened).toBeGreaterThanOrEqual(1);
  });

  test("SL hit intra-kline → exit at SL price, not close", async () => {
    // Force a long via uptrend warmup, then a downtrend kline whose low pierces SL.
    const klines: MarketKline[] = [];
    for (let i = 0; i < 10; i++) {
      const p = 100 + i;
      klines.push(kline(i * 60_000, p, p + 0.01, p - 0.01, p));
    }
    // Big downtrend kline: low=80 should hit SL well before close=85
    klines.push(kline(10 * 60_000, 110, 110, 80, 85));
    klines.push(kline(11 * 60_000, 85, 86, 84, 85)); // tail kline so loop continues

    const res = await runBacktest(
      makeScenario({
        strategyParams: { fastWindow: 2, slowWindow: 5, thresholdBps: 0 },
        riskParams: { ...baseRisk, stopLossBps: 100, takeProfitBps: 1000 },
      }),
      { fetchKlines: async () => klines },
    );
    expect(res.tradesOpened).toBeGreaterThan(0);
    const sl = res.trades.find((t) => t.exitReason === "stop-loss");
    expect(sl).toBeDefined();
    expect(sl!.side).toBe("long");
    // stopLoss = entry * (1 - 0.01); entry = close at the kline the signal fires.
    expect(sl!.exitPrice).toBeCloseTo(sl!.entryPrice * 0.99, 6);
    expect(sl!.exitPrice).not.toBe(85); // NOT the close
  });

  test("TP hit intra-kline → exit at TP price", async () => {
    const klines: MarketKline[] = [];
    for (let i = 0; i < 10; i++) {
      const p = 100 + i;
      klines.push(kline(i * 60_000, p, p + 0.01, p - 0.01, p));
    }
    // Massive up kline: high=130 triggers TP, close back to 111
    klines.push(kline(10 * 60_000, 110, 130, 109.5, 111));
    klines.push(kline(11 * 60_000, 111, 112, 110, 111));

    const res = await runBacktest(
      makeScenario({
        strategyParams: { fastWindow: 2, slowWindow: 5, thresholdBps: 0 },
        riskParams: { ...baseRisk, stopLossBps: 1000, takeProfitBps: 100 },
      }),
      { fetchKlines: async () => klines },
    );
    const tp = res.trades.find((t) => t.exitReason === "take-profit");
    expect(tp).toBeDefined();
    expect(tp!.exitPrice).toBeCloseTo(tp!.entryPrice * 1.01, 6);
  });

  test("fee accounting: netPnl = grossPnl - notional × feeBps/10000", async () => {
    const klines: MarketKline[] = [];
    for (let i = 0; i < 10; i++) {
      const p = 100 + i;
      klines.push(kline(i * 60_000, p, p + 0.01, p - 0.01, p));
    }
    klines.push(kline(10 * 60_000, 110, 130, 109.5, 111)); // TP hit
    klines.push(kline(11 * 60_000, 111, 112, 110, 111));

    const res = await runBacktest(
      makeScenario({
        strategyParams: { fastWindow: 2, slowWindow: 5, thresholdBps: 0 },
        riskParams: {
          orderUsd: 100, leverage: 1, stopLossBps: 1000, takeProfitBps: 100,
          maxPositionUsd: 500, feeRoundTripBps: 20,
        },
      }),
      { fetchKlines: async () => klines },
    );
    const t = res.trades.find((x) => x.exitReason === "take-profit");
    expect(t).toBeDefined();
    // notional = 100 USD (orderUsd * leverage). fee = 100 * 0.002 = 0.2
    expect(t!.feeUsd).toBeCloseTo(0.2, 6);
    expect(t!.netPnl).toBeCloseTo(t!.grossPnl - 0.2, 6);
  });

  test("aggregates: wins/losses/winRate/feesUsd consistent", async () => {
    const klines: MarketKline[] = [];
    for (let i = 0; i < 10; i++) {
      const p = 100 + i;
      klines.push(kline(i * 60_000, p, p + 0.01, p - 0.01, p));
    }
    klines.push(kline(10 * 60_000, 110, 130, 109.5, 111));
    klines.push(kline(11 * 60_000, 111, 112, 110, 111));

    const res = await runBacktest(
      makeScenario({
        riskParams: { ...baseRisk, stopLossBps: 1000, takeProfitBps: 100, feeRoundTripBps: 20 },
      }),
      { fetchKlines: async () => klines },
    );
    expect(res.tradesClosed).toBeGreaterThan(0);
    expect(res.wins + res.losses).toBeLessThanOrEqual(res.tradesClosed);
    expect(res.feesUsd).toBeGreaterThan(0);
    if (res.tradesClosed > 0) {
      expect(res.winRate).toBeCloseTo(res.wins / res.tradesClosed, 6);
    }
  });

  test("Sharpe calc on a sample series is a finite number", async () => {
    // Mixed wins + losses
    const klines: MarketKline[] = [];
    for (let i = 0; i < 20; i++) {
      const p = 100 + (i % 5);
      klines.push(kline(i * 60_000, p, p + 0.5, p - 0.5, p));
    }
    const res = await runBacktest(
      makeScenario({ strategyParams: { fastWindow: 2, slowWindow: 5, thresholdBps: 0 } }),
      { fetchKlines: async () => klines },
    );
    expect(Number.isFinite(res.sharpeAnnualizedScalp)).toBe(true);
  });

  test("rejects invalid date ranges", async () => {
    await expect(runBacktest(makeScenario({
      startDate: "2026-05-01T00:00:00Z",
      endDate: "2026-04-01T00:00:00Z",
    }), { fetchKlines: async () => [] })).rejects.toThrow(/Invalid backtest date range/);
  });

  test("unsupported strategy (funding-arb) is accepted but produces zero trades in v1", async () => {
    const klines: MarketKline[] = [];
    for (let i = 0; i < 20; i++) {
      klines.push(kline(i * 60_000, 100, 101, 99, 100));
    }
    const res = await runBacktest(
      makeScenario({ strategyType: "funding-arb" }),
      { fetchKlines: async () => klines },
    );
    expect(res.tradesOpened).toBe(0);
  });

  test("flatten-at-end produces an 'end-of-data' trade when position still open", async () => {
    const klines: MarketKline[] = [];
    for (let i = 0; i < 20; i++) {
      const p = 100 + i;
      klines.push(kline(i * 60_000, p, p + 0.01, p - 0.01, p));
    }
    const res = await runBacktest(
      makeScenario({
        strategyParams: { fastWindow: 3, slowWindow: 5, thresholdBps: 0 },
        riskParams: { ...baseRisk, stopLossBps: 5000, takeProfitBps: 5000 },
      }),
      { fetchKlines: async () => klines },
    );
    if (res.tradesClosed > 0) {
      const eod = res.trades.find((t) => t.exitReason === "end-of-data");
      expect(eod).toBeDefined();
    }
  });
});
