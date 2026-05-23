/**
 * Welles Wilder's Average Directional Index (ADX) plus +DI / -DI.
 *
 * Implementation follows the standard Wilder smoothing recipe:
 *   1. True Range, +DM, -DM at each bar.
 *   2. Wilder's smoothing (RMA) of TR / +DM / -DM over `period` bars.
 *   3. +DI = 100 · smoothed(+DM) / smoothed(TR)
 *      -DI = 100 · smoothed(-DM) / smoothed(TR)
 *   4. DX  = 100 · |+DI - -DI| / (+DI + -DI)
 *   5. ADX = Wilder smoothing of DX over `period` bars.
 *
 * Pure function. Returns `null` when there is not enough data to produce a
 * fully-smoothed ADX value (we need at least `period * 2 + 1` closes since
 * each Wilder smoothing pass eats `period` initial bars and there's an
 * additional one-bar lag from the TR / DM computation).
 *
 * Inputs are oldest-first arrays; the returned ADX / DI values are for the
 * most-recent bar only (no series output — we only need the latest reading
 * for regime detection).
 */

export interface AdxResult {
  /** 0-100; high values = strong trend (either direction). */
  adx: number;
  plusDi: number;
  minusDi: number;
}

export interface AdxInput {
  /** Oldest-first. */
  highs: number[];
  lows: number[];
  closes: number[];
  /** Wilder period, typically 14. */
  period: number;
}

export function computeAdx(input: AdxInput): AdxResult | null {
  const { highs, lows, closes, period } = input;
  if (period <= 0 || !Number.isFinite(period)) return null;
  const n = closes.length;
  if (highs.length !== n || lows.length !== n) return null;
  // We need `period` bars to seed TR/+DM/-DM averages, then another `period`
  // bars of DX to seed the ADX average. Plus one bar of look-back for the
  // very first TR / DM. So minimum length is 2 * period + 1.
  if (n < period * 2 + 1) return null;

  // Per-bar TR, +DM, -DM (i refers to the bar at index i; index 0 has no
  // prior bar so we start at i=1).
  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  for (let i = 1; i < n; i += 1) {
    const high = highs[i]!;
    const low = lows[i]!;
    const prevClose = closes[i - 1]!;
    const prevHigh = highs[i - 1]!;
    const prevLow = lows[i - 1]!;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    );
    const upMove = high - prevHigh;
    const downMove = prevLow - low;
    const plusDM = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;
    trs.push(tr);
    plusDMs.push(plusDM);
    minusDMs.push(minusDM);
  }

  // Wilder smoothing (RMA) — seed with simple sum over first `period` values.
  // After the seed, each subsequent step is: smoothed = prev - prev/period + cur.
  let trSm = 0;
  let plusSm = 0;
  let minusSm = 0;
  for (let i = 0; i < period; i += 1) {
    trSm += trs[i]!;
    plusSm += plusDMs[i]!;
    minusSm += minusDMs[i]!;
  }

  // Compute DX series after seeding.
  const dxs: number[] = [];
  // First DX from seed values.
  let plusDi = trSm > 0 ? (100 * plusSm) / trSm : 0;
  let minusDi = trSm > 0 ? (100 * minusSm) / trSm : 0;
  let diSum = plusDi + minusDi;
  let dx = diSum > 0 ? (100 * Math.abs(plusDi - minusDi)) / diSum : 0;
  dxs.push(dx);

  // Step through remaining bars with Wilder smoothing.
  for (let i = period; i < trs.length; i += 1) {
    trSm = trSm - trSm / period + trs[i]!;
    plusSm = plusSm - plusSm / period + plusDMs[i]!;
    minusSm = minusSm - minusSm / period + minusDMs[i]!;
    plusDi = trSm > 0 ? (100 * plusSm) / trSm : 0;
    minusDi = trSm > 0 ? (100 * minusSm) / trSm : 0;
    diSum = plusDi + minusDi;
    dx = diSum > 0 ? (100 * Math.abs(plusDi - minusDi)) / diSum : 0;
    dxs.push(dx);
  }

  // We need at least `period` DX values to seed ADX.
  if (dxs.length < period) return null;
  let adx = 0;
  for (let i = 0; i < period; i += 1) {
    adx += dxs[i]!;
  }
  adx /= period;
  for (let i = period; i < dxs.length; i += 1) {
    adx = (adx * (period - 1) + dxs[i]!) / period;
  }

  return { adx, plusDi, minusDi };
}
