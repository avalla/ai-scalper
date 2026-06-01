/**
 * Per-symbol rolling window of price + incremental volume samples.
 *
 * Fed by the runtime (ticker stream → push at each update). The scanner
 * consumes the resulting SymbolWindow snapshot. In-memory, no I/O — one
 * RollingWindowStore per worker process is enough.
 *
 * Memory is bounded: each symbol keeps at most `samplesPerWindow` recent
 * samples within `windowMs`. Older samples are pruned on push.
 */

import type { PricePoint, SymbolWindow } from "./pump-scanner";

export interface RollingWindowStoreOptions {
  /** Length of the rolling window in ms (anomaly detection horizon). */
  windowMs: number;
  /**
   * Soft cap on samples per symbol. Prevents pathological growth from very
   * high tick rates. Default 600 — at one sample/sec on a 5-min window that
   * fits 300, so 600 is plenty of headroom.
   */
  samplesPerWindow?: number;
  /**
   * Length of the baseline window in ms (longer history used to compute the
   * volume baseline against which spikes are measured). Default 24h.
   */
  baselineWindowMs?: number;
  /** Override now() for tests. */
  now?: () => number;
}

export interface PushSample {
  ts: number;
  price: number;
  /** Cumulative 24h volume in USD as reported by the ticker — store delta'd in push(). */
  cumulativeVolumeUsd?: number;
  /** Alternatively, the incremental volume since the last sample. */
  incrementalVolumeUsd?: number;
}

export interface RollingWindowStore {
  /** Push a sample for `symbol`. Stores incremental volume if both numbers are usable. */
  push(symbol: string, sample: PushSample): void;
  /** Build a SymbolWindow snapshot at `now`. Returns null if no samples yet. */
  snapshot(symbol: string): SymbolWindow | null;
  /** List symbols currently tracked. */
  symbols(): string[];
  /** Forcibly clear a symbol (e.g. delisted). */
  drop(symbol: string): void;
}

interface PerSymbolState {
  /** Stored samples, ordered ts ascending. */
  samples: PricePoint[];
  /** Last cumulative volume value (used to compute incremental on push). */
  lastCumulativeVolumeUsd: number | null;
  /** Running baseline samples from the LARGER window — kept compact. */
  baselineSamples: Array<{ ts: number; volumeUsd: number }>;
}

export function createRollingWindowStore(opts: RollingWindowStoreOptions): RollingWindowStore {
  const windowMs = opts.windowMs;
  const samplesPerWindow = opts.samplesPerWindow ?? 600;
  const baselineWindowMs = opts.baselineWindowMs ?? 24 * 3_600_000;
  const now = opts.now ?? Date.now;
  const store = new Map<string, PerSymbolState>();

  const getOrCreate = (symbol: string): PerSymbolState => {
    let s = store.get(symbol);
    if (!s) { s = { samples: [], lastCumulativeVolumeUsd: null, baselineSamples: [] }; store.set(symbol, s); }
    return s;
  };

  const pruneOld = (state: PerSymbolState, t: number) => {
    const cutoff = t - windowMs;
    let i = 0;
    while (i < state.samples.length && state.samples[i]!.ts < cutoff) i += 1;
    if (i > 0) state.samples.splice(0, i);
    if (state.samples.length > samplesPerWindow) {
      state.samples.splice(0, state.samples.length - samplesPerWindow);
    }
    // Baseline window (longer)
    const bcutoff = t - baselineWindowMs;
    let j = 0;
    while (j < state.baselineSamples.length && state.baselineSamples[j]!.ts < bcutoff) j += 1;
    if (j > 0) state.baselineSamples.splice(0, j);
  };

  return {
    push(symbol, sample) {
      if (!Number.isFinite(sample.ts) || !Number.isFinite(sample.price) || sample.price <= 0) return;
      const s = getOrCreate(symbol);
      let incrUsd = 0;
      if (typeof sample.incrementalVolumeUsd === "number" && sample.incrementalVolumeUsd >= 0) {
        incrUsd = sample.incrementalVolumeUsd;
      } else if (typeof sample.cumulativeVolumeUsd === "number" && sample.cumulativeVolumeUsd >= 0) {
        if (s.lastCumulativeVolumeUsd !== null && sample.cumulativeVolumeUsd >= s.lastCumulativeVolumeUsd) {
          incrUsd = sample.cumulativeVolumeUsd - s.lastCumulativeVolumeUsd;
        }
        s.lastCumulativeVolumeUsd = sample.cumulativeVolumeUsd;
      }
      s.samples.push({ ts: sample.ts, price: sample.price, incrementalVolumeUsd: incrUsd });
      s.baselineSamples.push({ ts: sample.ts, volumeUsd: incrUsd });
      pruneOld(s, sample.ts);
    },
    snapshot(symbol) {
      const s = store.get(symbol);
      if (!s || s.samples.length === 0) return null;
      const t = now();
      pruneOld(s, t);
      if (s.samples.length === 0) return null;
      // Baseline: estimate "typical volume per windowMs" from the longer history.
      // Take total baseline volume * (windowMs / baselineWindowMs).
      const baselineTotal = s.baselineSamples.reduce((acc, b) => acc + b.volumeUsd, 0);
      const baselineSpan = Math.max(1, (s.baselineSamples[s.baselineSamples.length - 1]?.ts ?? t) - (s.baselineSamples[0]?.ts ?? t));
      const baselineVolumePerWindow = baselineSpan > 0 ? baselineTotal * (windowMs / baselineSpan) : 0;
      return {
        symbol,
        now: t,
        samples: s.samples.slice(),
        baselineWindowVolumeUsd: baselineVolumePerWindow,
      };
    },
    symbols() { return Array.from(store.keys()); },
    drop(symbol) { store.delete(symbol); },
  };
}
