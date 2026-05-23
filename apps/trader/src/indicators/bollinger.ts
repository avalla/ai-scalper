/**
 * Bollinger Bands — middle = SMA(period), upper/lower = middle ± k * σ.
 *
 * Pure function. Returns `null` if there are fewer than `period` closes
 * (caller should treat as warmup). Uses population stddev (denominator = N)
 * to match the canonical Bollinger formulation.
 */

export interface BollingerResult {
  middle: number;
  upper: number;
  lower: number;
  stddev: number;
}

export function computeBollinger(
  closes: number[],
  period: number,
  stdDevMultiplier: number,
): BollingerResult | null {
  if (period <= 0 || !Number.isFinite(period)) return null;
  if (closes.length < period) return null;
  const window = closes.slice(closes.length - period);
  let sum = 0;
  for (const c of window) sum += c;
  const mean = sum / period;
  let varSum = 0;
  for (const c of window) {
    const d = c - mean;
    varSum += d * d;
  }
  const stddev = Math.sqrt(varSum / period);
  return {
    middle: mean,
    upper: mean + stdDevMultiplier * stddev,
    lower: mean - stdDevMultiplier * stddev,
    stddev,
  };
}
