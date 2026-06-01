import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ANOMALY_CRITERIA,
  DEFAULT_LIQUIDITY_CRITERIA,
  detectPumpAnomaly,
  qualifiesByLiquidity,
  scanSymbol,
  type SymbolTickerSnapshot,
  type SymbolWindow,
} from "./pump-scanner";

const NOW = 1_700_000_000_000;
const WINDOW = 5 * 60_000;

const baseTicker = (overrides: Partial<SymbolTickerSnapshot> = {}): SymbolTickerSnapshot => ({
  symbol: "BTCUSDT",
  lastPrice: 73_000,
  turnover24hUsd: 50_000_000,
  bid1Price: 72_998,
  ask1Price: 73_002,
  ...overrides,
});

const buildWindow = (priceStart: number, priceEnd: number, windowVolUsd: number, baseline: number): SymbolWindow => ({
  symbol: "BTCUSDT",
  now: NOW,
  baselineWindowVolumeUsd: baseline,
  samples: [
    { ts: NOW - WINDOW, price: priceStart, incrementalVolumeUsd: 0 },
    { ts: NOW - WINDOW / 2, price: (priceStart + priceEnd) / 2, incrementalVolumeUsd: windowVolUsd / 2 },
    { ts: NOW, price: priceEnd, incrementalVolumeUsd: windowVolUsd / 2 },
  ],
});

// ── qualifiesByLiquidity ─────────────────────────────────────────────────

describe("qualifiesByLiquidity", () => {
  test("accepts a clean BTC-grade ticker", () => {
    expect(qualifiesByLiquidity(baseTicker(), DEFAULT_LIQUIDITY_CRITERIA).ok).toBe(true);
  });

  test("rejects when 24h turnover below threshold", () => {
    const r = qualifiesByLiquidity(baseTicker({ turnover24hUsd: 100_000 }), DEFAULT_LIQUIDITY_CRITERIA);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("low-turnover");
  });

  test("rejects when spread too wide", () => {
    // bid 73000, ask 73100 → ~13.7 bps spread, above 5 bps default
    const r = qualifiesByLiquidity(baseTicker({ bid1Price: 73_000, ask1Price: 73_100 }), DEFAULT_LIQUIDITY_CRITERIA);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("wide-spread");
  });

  test("rejects an invalid book (ask < bid)", () => {
    const r = qualifiesByLiquidity(baseTicker({ bid1Price: 73_002, ask1Price: 72_998 }), DEFAULT_LIQUIDITY_CRITERIA);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid-book");
  });

  test("respects minBookDepthUsd when set (>0)", () => {
    const tk = baseTicker({ bookBidDepthUsd: 5_000, bookAskDepthUsd: 5_000 });
    const r = qualifiesByLiquidity(tk, { ...DEFAULT_LIQUIDITY_CRITERIA, minBookDepthUsd: 50_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("low-depth");
  });

  test("skips depth check when criteria is 0", () => {
    const r = qualifiesByLiquidity(baseTicker(), DEFAULT_LIQUIDITY_CRITERIA); // depth=0 in defaults
    expect(r.ok).toBe(true);
  });
});

// ── detectPumpAnomaly ─────────────────────────────────────────────────────

describe("detectPumpAnomaly", () => {
  test("triggers on a 3% pump with 3x volume spike", () => {
    const win = buildWindow(73_000, 75_190, 300_000, 100_000); // ~300 bps, 3x baseline
    const a = detectPumpAnomaly(win, baseTicker(), DEFAULT_ANOMALY_CRITERIA);
    expect(a).not.toBeNull();
    expect(a!.direction).toBe("pump");
    expect(a!.priceChangeBps).toBeGreaterThan(200);
    expect(a!.volumeMultiple).toBeGreaterThan(2);
    expect(a!.symbol).toBe("BTCUSDT");
  });

  test("triggers on a 3% dump (negative direction)", () => {
    const win = buildWindow(73_000, 70_810, 300_000, 100_000);
    const a = detectPumpAnomaly(win, baseTicker(), DEFAULT_ANOMALY_CRITERIA);
    expect(a).not.toBeNull();
    expect(a!.direction).toBe("dump");
    expect(a!.priceChangeBps).toBeLessThan(-200);
  });

  test("null when price move below threshold", () => {
    // 1.5% only → below 2% threshold
    const win = buildWindow(73_000, 74_095, 300_000, 100_000);
    expect(detectPumpAnomaly(win, baseTicker(), DEFAULT_ANOMALY_CRITERIA)).toBeNull();
  });

  test("null when volume spike below multiple threshold", () => {
    // Strong price move (3%) but volume only 1.5x baseline (< 2x)
    const win = buildWindow(73_000, 75_190, 150_000, 100_000);
    expect(detectPumpAnomaly(win, baseTicker(), DEFAULT_ANOMALY_CRITERIA)).toBeNull();
  });

  test("null when window absolute volume too low (fake shitcoin spike)", () => {
    // 10x baseline of 1k = 10k, still < minWindowVolumeUsd=50k
    const win = buildWindow(73_000, 75_190, 10_000, 1_000);
    expect(detectPumpAnomaly(win, baseTicker(), DEFAULT_ANOMALY_CRITERIA)).toBeNull();
  });

  test("null when window not full (less than priceChangeWindowMs)", () => {
    const win: SymbolWindow = {
      symbol: "BTCUSDT", now: NOW, baselineWindowVolumeUsd: 100_000,
      samples: [
        { ts: NOW - 60_000, price: 73_000, incrementalVolumeUsd: 0 },
        { ts: NOW, price: 75_190, incrementalVolumeUsd: 300_000 },
      ],
    };
    expect(detectPumpAnomaly(win, baseTicker(), DEFAULT_ANOMALY_CRITERIA)).toBeNull();
  });

  test("null when fewer than 2 samples", () => {
    const win: SymbolWindow = {
      symbol: "BTCUSDT", now: NOW, baselineWindowVolumeUsd: 100_000,
      samples: [{ ts: NOW, price: 73_000, incrementalVolumeUsd: 0 }],
    };
    expect(detectPumpAnomaly(win, baseTicker(), DEFAULT_ANOMALY_CRITERIA)).toBeNull();
  });

  test("triggers without baseline (zero) when other gates pass — volumeMultiple becomes Infinity", () => {
    const win = buildWindow(73_000, 75_190, 300_000, 0);
    const a = detectPumpAnomaly(win, baseTicker(), DEFAULT_ANOMALY_CRITERIA);
    expect(a).not.toBeNull();
    expect(a!.volumeMultiple).toBe(Number.POSITIVE_INFINITY);
  });

  test("captures spread bps from ticker into the anomaly", () => {
    const win = buildWindow(73_000, 75_190, 300_000, 100_000);
    const a = detectPumpAnomaly(win, baseTicker({ bid1Price: 73_000, ask1Price: 73_005 }), DEFAULT_ANOMALY_CRITERIA);
    expect(a!.spreadBps).toBeCloseTo((5 / 73_002.5) * 10_000, 1);
  });
});

// ── scanSymbol (combined) ─────────────────────────────────────────────────

describe("scanSymbol", () => {
  test("liquidity gate short-circuits before anomaly compute", () => {
    const r = scanSymbol({
      ticker: baseTicker({ turnover24hUsd: 1000 }), // too small
      window: buildWindow(73_000, 75_190, 300_000, 100_000), // would trigger
      liquidity: DEFAULT_LIQUIDITY_CRITERIA,
      anomaly: DEFAULT_ANOMALY_CRITERIA,
    });
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toContain("low-turnover");
  });

  test("passes liquidity + anomaly → returns the anomaly", () => {
    const r = scanSymbol({
      ticker: baseTicker(),
      window: buildWindow(73_000, 75_190, 300_000, 100_000),
      liquidity: DEFAULT_LIQUIDITY_CRITERIA,
      anomaly: DEFAULT_ANOMALY_CRITERIA,
    });
    expect(r.kind).toBe("anomaly");
    if (r.kind === "anomaly") {
      expect(r.anomaly.direction).toBe("pump");
      expect(r.anomaly.symbol).toBe("BTCUSDT");
    }
  });

  test("passes liquidity but no anomaly → skipped:no-anomaly", () => {
    const r = scanSymbol({
      ticker: baseTicker(),
      window: buildWindow(73_000, 73_100, 50_000, 100_000), // flat-ish
      liquidity: DEFAULT_LIQUIDITY_CRITERIA,
      anomaly: DEFAULT_ANOMALY_CRITERIA,
    });
    expect(r.kind).toBe("skipped");
    if (r.kind === "skipped") expect(r.reason).toBe("no-anomaly");
  });
});
