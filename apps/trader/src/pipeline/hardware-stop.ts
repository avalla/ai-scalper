/**
 * hardware-stop — exchange-side stop-loss helper for leveraged positions.
 *
 * Purpose: backup safety net for catastrophic events. If the bot crashes
 * or loses connectivity while a position is open, the broker still has a
 * pre-set stop that will close the leg without our intervention. The logical
 * spreadDivergenceStopBps guard in the manage processor is the PRIMARY
 * protection; this is the secondary, exchange-side layer.
 *
 * CAVEAT for calendar-spread (hedged positions):
 *   Single-leg hardware stops fire on directional moves of the underlying,
 *   not on spread divergence. A tight stop (e.g. 100 bps) WILL trigger on
 *   normal BTC moves while the spread itself is fine → leaves the other leg
 *   naked (very bad at high leverage). To avoid this:
 *     - Use WIDE widths (≥500 bps recommended at leverage 10x). At 5%, a
 *       single-leg stop only fires on tail events where BTC moves > 5%
 *       between two manage ticks — i.e. crash + flash-move co-occurrence.
 *     - Default OFF (widthBps === 0 means no hardware stop applied).
 *
 * Best-effort semantics: setTradingStop failures are LOGGED and swallowed.
 * Hardware stops are a safety net; their absence degrades to "no exchange-side
 * protection" which is the pre-helper baseline — not a trade-blocking error.
 */

import type { createBybitClient } from "@ai-scalper/bybit-client";

type BybitClient = ReturnType<typeof createBybitClient>;

export interface HardwareStopLeg {
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  tickSize: string;
  category: "linear" | "inverse";
}

/**
 * Compute the stop-loss price at `widthBps` from `entry`, rounded DOWN to the
 * tick for protective safety:
 *   - long position: stop BELOW entry → round down (more aggressive trigger).
 *   - short position: stop ABOVE entry → round up (more aggressive trigger).
 * Returns the price as a fixed-decimal string formatted at the same precision
 * as tickSize (Bybit rejects mismatched precision).
 */
export function computeStopPrice(entry: number, side: "long" | "short", widthBps: number, tickSize: string): string {
  if (widthBps <= 0) throw new Error(`computeStopPrice: widthBps must be > 0 (got ${widthBps})`);
  if (!Number.isFinite(entry) || entry <= 0) throw new Error(`computeStopPrice: invalid entry ${entry}`);
  const tick = Number(tickSize);
  if (!Number.isFinite(tick) || tick <= 0) throw new Error(`computeStopPrice: invalid tickSize ${tickSize}`);

  const raw = side === "long"
    ? entry * (1 - widthBps / 10_000)
    : entry * (1 + widthBps / 10_000);

  // Snap to tick — protective direction (further from entry).
  const ticks = side === "long" ? Math.floor(raw / tick) : Math.ceil(raw / tick);
  const snapped = ticks * tick;

  // Decimal count of tickSize for stable string formatting.
  const decimals = (tickSize.split(".")[1] ?? "").length;
  return snapped.toFixed(decimals);
}

export interface ApplyHardwareStopsParams {
  client: BybitClient;
  legs: readonly HardwareStopLeg[];
  widthBps: number;
  log?: (payload: Record<string, unknown>) => void;
}

export interface ApplyHardwareStopsResult {
  appliedCount: number;
  failedCount: number;
}

/**
 * Apply protective hardware stops to one or more open positions. Failures on
 * individual legs are LOGGED and don't propagate — never block the caller.
 * Returns counts for caller-side observability.
 */
export async function applyHardwareStops(params: ApplyHardwareStopsParams): Promise<ApplyHardwareStopsResult> {
  const log = params.log ?? ((p) => console.log(JSON.stringify(p)));
  if (params.widthBps <= 0) {
    return { appliedCount: 0, failedCount: 0 };
  }

  let appliedCount = 0;
  let failedCount = 0;
  for (const leg of params.legs) {
    let stopPrice: string;
    try {
      stopPrice = computeStopPrice(leg.entryPrice, leg.side, params.widthBps, leg.tickSize);
    } catch (err) {
      log({ event: "hardware-stop-compute-failed", symbol: leg.symbol, err: err instanceof Error ? err.message : String(err) });
      failedCount += 1;
      continue;
    }
    try {
      const r = await params.client.setTradingStop({ category: leg.category, symbol: leg.symbol, stopLoss: stopPrice });
      if (r.retCode === 0 || r.retCode === 34040 /* already set */) {
        log({ event: "hardware-stop-applied", symbol: leg.symbol, side: leg.side, entryPrice: leg.entryPrice, stopPrice, widthBps: params.widthBps });
        appliedCount += 1;
      } else {
        log({ event: "hardware-stop-rejected", symbol: leg.symbol, side: leg.side, stopPrice, retCode: r.retCode, retMsg: r.retMsg });
        failedCount += 1;
      }
    } catch (err) {
      log({ event: "hardware-stop-call-failed", symbol: leg.symbol, side: leg.side, stopPrice, err: err instanceof Error ? err.message : String(err) });
      failedCount += 1;
    }
  }
  return { appliedCount, failedCount };
}
