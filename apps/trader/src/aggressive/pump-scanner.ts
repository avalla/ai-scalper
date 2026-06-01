/**
 * Pump scanner — anomaly detection on the active symbol universe.
 *
 * Architecture (matches the operator's prior working LLM-analyzer workflow):
 *
 *   Bybit WS feed → SymbolWindow (rolling price+volume)
 *                ↘
 *                  qualifiesByLiquidity → universe filter
 *                ↗
 *                  detectPumpAnomaly → PumpAnomaly | null
 *
 *   Emitted PumpAnomaly is the trigger fed downstream to the LLM analyzer
 *   (session 2) which decides direction + sizing + stop/TP.
 *
 * PURE — no I/O, no randomness. Caller is responsible for sourcing data.
 * The filter is intentionally CONSERVATIVE on liquidity to avoid acting on
 * symbols where slippage would dominate the edge.
 */

/** What "tradable" means: enough volume, tight enough spread, enough book depth. */
export interface PumpScannerLiquidityCriteria {
  /** Min 24h turnover in USD. Default proposed: 10M. Below this, slippage kills any edge. */
  min24hTurnoverUsd: number;
  /** Max spread (best bid → best ask) in bps. Default: 5 bps. */
  maxSpreadBps: number;
  /**
   * Min combined book depth in USD in the ±N% range around mid.
   * Optional — if the caller doesn't have book data, set to 0 to skip the check.
   */
  minBookDepthUsd: number;
}

/** What "anomaly" means: price moved sharply on amplified volume. */
export interface PumpScannerAnomalyCriteria {
  /**
   * Min absolute price change (bps) over the rolling window to count as anomalous.
   * Default proposed: 200 bps (2%) on a 5-minute window.
   * Conservative: 300 bps. Aggressive (more triggers, more noise): 150 bps.
   */
  priceChangeBpsThreshold: number;
  /** Rolling window length in ms over which the price change is measured. */
  priceChangeWindowMs: number;
  /**
   * Required current volume multiple vs the rolling average baseline.
   * Default: 2.0 (= volume in last window ≥ 2x typical). 1.5 = lax, 3+ = strict.
   */
  volumeMultipleThreshold: number;
  /**
   * Min absolute current volume in USD (window total). Filters tiny-symbol
   * fake spikes (e.g. 5x of $100 = still $500, irrelevant).
   */
  minWindowVolumeUsd: number;
}

/** Latest ticker snapshot for one symbol (caller fetches from Bybit /v5/market/tickers). */
export interface SymbolTickerSnapshot {
  symbol: string;
  lastPrice: number;
  /** 24h turnover in QUOTE currency (USD for USDT pairs). Bybit field: turnover24h. */
  turnover24hUsd: number;
  bid1Price: number;
  ask1Price: number;
  /** Optional: caller-computed depth in USD within ±N% of mid. */
  bookBidDepthUsd?: number;
  bookAskDepthUsd?: number;
}

/** One price+volume sample within the rolling window. */
export interface PricePoint {
  /** Epoch ms. */
  ts: number;
  /** Mid or last price at this sample. */
  price: number;
  /** Incremental volume in USD between the previous sample and this one. */
  incrementalVolumeUsd: number;
}

/** Rolling window for one symbol, fed to the anomaly detector. */
export interface SymbolWindow {
  symbol: string;
  /** Time of the window snapshot (the "now"). */
  now: number;
  /** Samples sorted by ts ascending; the first sample's ts marks the window start. */
  samples: readonly PricePoint[];
  /**
   * Rolling average volume per `priceChangeWindowMs` window, measured over a
   * much longer history (e.g. last 24h). Used as the baseline for the spike
   * multiplier. Caller is responsible for maintaining this baseline.
   */
  baselineWindowVolumeUsd: number;
}

/** Output emitted when the symbol clears liquidity AND anomaly thresholds. */
export interface PumpAnomaly {
  symbol: string;
  detectedAt: number;
  /** Signed price change over the window (positive = pump, negative = dump). */
  priceChangeBps: number;
  /** Direction inferred from the sign of the price change. */
  direction: "pump" | "dump";
  /** Volume in the window / baseline. */
  volumeMultiple: number;
  /** Volume in the window in USD. */
  windowVolumeUsd: number;
  /** Best bid/ask spread in bps at scan time. */
  spreadBps: number;
  /** First and last price of the window (audit). */
  windowStartPrice: number;
  windowEndPrice: number;
}

/** Result of the liquidity gate. */
export type LiquidityCheckResult =
  | { ok: true }
  | { ok: false; reason: string };

// ─── Liquidity filter ─────────────────────────────────────────────────────

export function qualifiesByLiquidity(
  ticker: SymbolTickerSnapshot,
  criteria: PumpScannerLiquidityCriteria,
): LiquidityCheckResult {
  if (!Number.isFinite(ticker.lastPrice) || ticker.lastPrice <= 0) {
    return { ok: false, reason: "invalid-last-price" };
  }
  if (!Number.isFinite(ticker.turnover24hUsd) || ticker.turnover24hUsd < criteria.min24hTurnoverUsd) {
    return { ok: false, reason: `low-turnover:${ticker.turnover24hUsd.toFixed(0)}<${criteria.min24hTurnoverUsd}` };
  }
  const bid = ticker.bid1Price; const ask = ticker.ask1Price;
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) {
    return { ok: false, reason: "invalid-book" };
  }
  const mid = (bid + ask) / 2;
  const spreadBps = (ask - bid) / mid * 10_000;
  if (spreadBps > criteria.maxSpreadBps) {
    return { ok: false, reason: `wide-spread:${spreadBps.toFixed(2)}bps>${criteria.maxSpreadBps}` };
  }
  if (criteria.minBookDepthUsd > 0) {
    const bidDepth = ticker.bookBidDepthUsd ?? 0;
    const askDepth = ticker.bookAskDepthUsd ?? 0;
    const combined = bidDepth + askDepth;
    if (combined < criteria.minBookDepthUsd) {
      return { ok: false, reason: `low-depth:${combined.toFixed(0)}<${criteria.minBookDepthUsd}` };
    }
  }
  return { ok: true };
}

// ─── Anomaly detector ─────────────────────────────────────────────────────

/**
 * Inspect the rolling window for an anomaly. Returns null when nothing
 * trigger-worthy; otherwise a PumpAnomaly with the audit fields populated.
 *
 * Filters in priority order:
 *   1. Window must have ≥ 2 samples and span ≥ priceChangeWindowMs (else stale).
 *   2. Absolute price change must exceed priceChangeBpsThreshold.
 *   3. Window volume must exceed both minWindowVolumeUsd AND volumeMultipleThreshold × baseline.
 */
export function detectPumpAnomaly(
  window: SymbolWindow,
  ticker: SymbolTickerSnapshot,
  criteria: PumpScannerAnomalyCriteria,
): PumpAnomaly | null {
  if (window.samples.length < 2) return null;
  const first = window.samples[0]!;
  const last = window.samples[window.samples.length - 1]!;
  if (last.ts - first.ts < criteria.priceChangeWindowMs) return null;
  if (!Number.isFinite(first.price) || first.price <= 0 || !Number.isFinite(last.price) || last.price <= 0) return null;

  const priceChangeBps = (last.price - first.price) / first.price * 10_000;
  if (Math.abs(priceChangeBps) < criteria.priceChangeBpsThreshold) return null;

  const windowVolumeUsd = window.samples.reduce((acc, s) => acc + (Number.isFinite(s.incrementalVolumeUsd) ? Math.max(0, s.incrementalVolumeUsd) : 0), 0);
  if (windowVolumeUsd < criteria.minWindowVolumeUsd) return null;
  if (window.baselineWindowVolumeUsd > 0) {
    const multiple = windowVolumeUsd / window.baselineWindowVolumeUsd;
    if (multiple < criteria.volumeMultipleThreshold) return null;
  }
  const volumeMultiple = window.baselineWindowVolumeUsd > 0 ? windowVolumeUsd / window.baselineWindowVolumeUsd : Number.POSITIVE_INFINITY;

  const mid = (ticker.bid1Price + ticker.ask1Price) / 2;
  const spreadBps = mid > 0 ? (ticker.ask1Price - ticker.bid1Price) / mid * 10_000 : 0;

  return {
    symbol: window.symbol,
    detectedAt: window.now,
    priceChangeBps,
    direction: priceChangeBps > 0 ? "pump" : "dump",
    volumeMultiple,
    windowVolumeUsd,
    spreadBps,
    windowStartPrice: first.price,
    windowEndPrice: last.price,
  };
}

// ─── Convenience: combined scan ───────────────────────────────────────────

/**
 * One-shot scan: applies liquidity gate FIRST (cheap), then anomaly detection
 * (slightly more compute). Returns the anomaly or a reason string for skip.
 */
export type ScanResult =
  | { kind: "anomaly"; anomaly: PumpAnomaly }
  | { kind: "skipped"; reason: string };

export function scanSymbol(params: {
  ticker: SymbolTickerSnapshot;
  window: SymbolWindow;
  liquidity: PumpScannerLiquidityCriteria;
  anomaly: PumpScannerAnomalyCriteria;
}): ScanResult {
  const liq = qualifiesByLiquidity(params.ticker, params.liquidity);
  if (!liq.ok) return { kind: "skipped", reason: liq.reason };
  const anomaly = detectPumpAnomaly(params.window, params.ticker, params.anomaly);
  if (!anomaly) return { kind: "skipped", reason: "no-anomaly" };
  return { kind: "anomaly", anomaly };
}

// ─── Defaults the operator can use as a starting point ─────────────────────

export const DEFAULT_LIQUIDITY_CRITERIA: PumpScannerLiquidityCriteria = {
  min24hTurnoverUsd: 10_000_000,
  maxSpreadBps: 5,
  minBookDepthUsd: 0,
};

export const DEFAULT_ANOMALY_CRITERIA: PumpScannerAnomalyCriteria = {
  priceChangeBpsThreshold: 200, // 2%
  priceChangeWindowMs: 5 * 60_000, // 5 min
  volumeMultipleThreshold: 2.0,
  minWindowVolumeUsd: 50_000,
};
