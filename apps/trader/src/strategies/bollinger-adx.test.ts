import { describe, expect, test } from "bun:test";
import {
  bollingerAdxDecide,
  type BollingerAdxKlineCache,
  type BollingerAdxPosition,
} from "./bollinger-adx";

const NOW = 1_700_000_000_000;

const base = {
  symbol: "BTCUSDT",
  now: NOW,
  refreshSec: 60,
  bbPeriod: 20,
  bbStdDev: 2,
  adxPeriod: 14,
  adxRangingThreshold: 20,
  adxTrendingThreshold: 25,
  stopLossBps: 80,
  takeProfitBps: 150,
};

function buildFlatChoppyCache(): BollingerAdxKlineCache {
  // 60 bars of low-volatility chop around 100 — low ADX.
  const highs: number[] = [];
  const lows: number[] = [];
  const closes: number[] = [];
  for (let i = 0; i < 60; i += 1) {
    const c = 100 + (i % 2 === 0 ? 0.5 : -0.5);
    closes.push(c);
    highs.push(c + 0.2);
    lows.push(c - 0.2);
  }
  return { symbol: "BTCUSDT", fetchedAt: NOW, highs, lows, closes };
}

function buildStrongUptrendCache(): BollingerAdxKlineCache {
  const highs: number[] = [];
  const lows: number[] = [];
  const closes: number[] = [];
  for (let i = 0; i < 60; i += 1) {
    const c = 100 + i;
    closes.push(c);
    highs.push(c + 0.5);
    lows.push(c - 0.5);
  }
  return { symbol: "BTCUSDT", fetchedAt: NOW, highs, lows, closes };
}

describe("bollingerAdxDecide", () => {
  test("hold:needs-refresh when klineCache is null", () => {
    const d = bollingerAdxDecide({
      ...base,
      klineCache: null,
      position: null,
      currentPrice: 100,
    });
    expect(d.kind).toBe("hold");
    if (d.kind === "hold") expect(d.reason).toBe("needs-refresh");
  });

  test("hold:warmup when not enough bars for BB / ADX", () => {
    const cache: BollingerAdxKlineCache = {
      symbol: "BTCUSDT",
      fetchedAt: NOW,
      highs: [1, 2, 3, 4, 5],
      lows: [0.5, 1.5, 2.5, 3.5, 4.5],
      closes: [1, 2, 3, 4, 5],
    };
    const d = bollingerAdxDecide({
      ...base,
      klineCache: cache,
      position: null,
      currentPrice: 5,
    });
    expect(d.kind).toBe("hold");
    if (d.kind === "hold") expect(d.reason).toBe("warmup");
  });

  test("ranging: enters long when currentPrice <= BB lower", () => {
    const cache = buildFlatChoppyCache();
    // BB centers ~100 with very small width. Force a price below lower.
    const d = bollingerAdxDecide({
      ...base,
      klineCache: cache,
      position: null,
      currentPrice: 99.0, // below any band given σ ~ 0.5
    });
    expect(d.kind).toBe("enter");
    if (d.kind === "enter") {
      expect(d.side).toBe("long");
      expect(d.regime).toBe("ranging");
    }
  });

  test("ranging: enters short when currentPrice >= BB upper", () => {
    const cache = buildFlatChoppyCache();
    const d = bollingerAdxDecide({
      ...base,
      klineCache: cache,
      position: null,
      currentPrice: 101.0,
    });
    expect(d.kind).toBe("enter");
    if (d.kind === "enter") {
      expect(d.side).toBe("short");
      expect(d.regime).toBe("ranging");
    }
  });

  test("trending: enters long on breakout above BB upper", () => {
    const cache = buildStrongUptrendCache();
    const lastClose = cache.closes[cache.closes.length - 1]!;
    const d = bollingerAdxDecide({
      ...base,
      klineCache: cache,
      position: null,
      currentPrice: lastClose + 50, // way above any BB upper
    });
    expect(d.kind).toBe("enter");
    if (d.kind === "enter") {
      expect(d.side).toBe("long");
      expect(d.regime).toBe("trending");
    }
  });

  test("ranging: exit take-profit when long position price >= BB middle", () => {
    const cache = buildFlatChoppyCache();
    const position: BollingerAdxPosition = { side: "long", entryPrice: 99.0 };
    const d = bollingerAdxDecide({
      ...base,
      klineCache: cache,
      position,
      currentPrice: 100.0, // crosses ~100 midline
    });
    expect(d.kind).toBe("exit");
    if (d.kind === "exit") expect(d.reason).toBe("take-profit");
  });

  test("exit:stop-loss when long position price falls stopLossBps below entry", () => {
    const cache = buildFlatChoppyCache();
    const entryPrice = 100;
    const slPrice = entryPrice * (1 - base.stopLossBps / 10_000); // 99.2
    const position: BollingerAdxPosition = { side: "long", entryPrice };
    const d = bollingerAdxDecide({
      ...base,
      klineCache: cache,
      position,
      currentPrice: slPrice - 0.01,
    });
    expect(d.kind).toBe("exit");
    if (d.kind === "exit") expect(d.reason).toBe("stop-loss");
  });

  test("exit:stop-loss when short position price rises stopLossBps above entry", () => {
    const cache = buildFlatChoppyCache();
    const entryPrice = 100;
    const slPrice = entryPrice * (1 + base.stopLossBps / 10_000); // 100.8
    const position: BollingerAdxPosition = { side: "short", entryPrice };
    const d = bollingerAdxDecide({
      ...base,
      klineCache: cache,
      position,
      currentPrice: slPrice + 0.01,
    });
    expect(d.kind).toBe("exit");
    if (d.kind === "exit") expect(d.reason).toBe("stop-loss");
  });
});
