/**
 * calendar-rotator — picks the nearest dated linear future for calendar-spread
 * and refreshes the choice periodically so the strategy never needs a manual
 * config edit when a quarterly settles.
 *
 * Two layers:
 *   - pickNextQuarterly(): pure function, sorts dated instruments by deliveryTime
 *     and returns the nearest one whose settlement is still > minHoursAhead
 *     away. Tested in isolation.
 *   - createCalendarRotator(): runtime wrapper that calls listInstruments at
 *     bounded cadence and caches the pick. getCurrent() always returns the
 *     last good pick (or null if nothing usable was ever resolved).
 *
 * Why "minHoursAhead": the calendar strategy already refuses to OPEN when
 * <preSettlementCloseHours+1 (default 25h) remain. The rotator uses the same
 * floor so the picked symbol is always a contract the strategy will actually
 * trade. Open positions are pinned to the symbol that was in their job state
 * and are NOT migrated by the rotator (the manage processor reads from job
 * data, not from this helper).
 */

import type { createBybitClient, InstrumentInfo } from "@ai-scalper/bybit-client";

type BybitClient = ReturnType<typeof createBybitClient>;

export interface CalendarPick {
  symbol: string;
  deliveryAt: number;
}

export interface PickOpts {
  /** Settlement must be at least this many hours in the future (default 25). */
  minHoursAhead?: number;
  /** Filter on baseCoin (e.g. "BTC"). Required — we never want to mix coins. */
  baseCoin: string;
  /** Quote — typically "USDT". Defaults to USDT. */
  quoteCoin?: string;
}

const HOUR_MS = 3_600_000;

/**
 * Pure picker. Given a list of instrument descriptors and the current time,
 * return the nearest valid dated future or null.
 *
 * "Valid" = LinearFutures contractType, matching base/quote coin, deliveryTime
 * parses as a number, deliveryTime > now + minHoursAhead.
 */
export function pickNextQuarterly(
  instruments: InstrumentInfo[],
  now: number,
  opts: PickOpts,
): CalendarPick | null {
  const minHoursAhead = opts.minHoursAhead ?? 25;
  const quote = opts.quoteCoin ?? "USDT";
  const floor = now + minHoursAhead * HOUR_MS;
  const candidates: CalendarPick[] = [];
  for (const inst of instruments) {
    if (inst.contractType !== "LinearFutures") continue;
    if (inst.baseCoin && inst.baseCoin !== opts.baseCoin) continue;
    if (inst.quoteCoin && inst.quoteCoin !== quote) continue;
    if (inst.status && inst.status !== "Trading") continue;
    const dt = Number(inst.deliveryTime ?? "0");
    if (!Number.isFinite(dt) || dt <= 0) continue;
    if (dt <= floor) continue;
    candidates.push({ symbol: inst.symbol, deliveryAt: dt });
  }
  candidates.sort((a, b) => a.deliveryAt - b.deliveryAt);
  return candidates[0] ?? null;
}

export interface RotatorOpts extends PickOpts {
  /** Refresh interval in ms (default 1h). REST cost is negligible. */
  refreshMs?: number;
  category?: "linear" | "inverse";
  log?: (payload: Record<string, unknown>) => void;
  now?: () => number;
}

export interface CalendarRotator {
  /** Return the cached pick, refreshing if stale. Never throws. */
  getCurrent(): Promise<CalendarPick | null>;
  /** Force refresh — primarily for tests / bootstrap. */
  refresh(): Promise<CalendarPick | null>;
}

export function createCalendarRotator(client: BybitClient, opts: RotatorOpts): CalendarRotator {
  const log = opts.log ?? ((p) => console.log(JSON.stringify(p)));
  const now = opts.now ?? Date.now;
  const refreshMs = opts.refreshMs ?? 60 * 60_000;
  const category = opts.category ?? "linear";

  let cached: CalendarPick | null = null;
  let lastRefreshAt = 0;
  let inflight: Promise<CalendarPick | null> | null = null;

  async function doRefresh(): Promise<CalendarPick | null> {
    try {
      const list = await client.listInstruments({ category, baseCoin: opts.baseCoin });
      const pick = pickNextQuarterly(list, now(), opts);
      lastRefreshAt = now();
      if (pick && (!cached || cached.symbol !== pick.symbol)) {
        log({
          event: "calendar-rotator-pick-changed",
          previous: cached?.symbol ?? null,
          current: pick.symbol,
          deliveryAt: pick.deliveryAt,
          hoursAhead: Math.round((pick.deliveryAt - now()) / HOUR_MS),
        });
      }
      if (!pick && cached) {
        log({ event: "calendar-rotator-no-candidate", previous: cached.symbol });
      }
      cached = pick;
      return pick;
    } catch (err) {
      log({ event: "calendar-rotator-refresh-failed", err: err instanceof Error ? err.message : String(err) });
      // Keep cached value; next tick retries.
      return cached;
    }
  }

  return {
    async getCurrent() {
      if (!cached || now() - lastRefreshAt > refreshMs) {
        if (!inflight) inflight = doRefresh().finally(() => { inflight = null; });
        return inflight;
      }
      return cached;
    },
    async refresh() {
      if (!inflight) inflight = doRefresh().finally(() => { inflight = null; });
      return inflight;
    },
  };
}
