/**
 * Daily-window state tracker for the aggressive subsystem.
 *
 * Tracks per-UTC-day:
 *   - dailyRealizedPnlUsd  — sum of close-time net PnL
 *   - tradesToday          — count of trades opened
 *   - dayStartEquityUsd    — equity at the start of the day (set once per day)
 *
 * Storage: Redis hash `ai-scalper:aggressive:daily:<YYYY-MM-DD>`. Rolls over
 * automatically when the date key changes (no manual reset job needed).
 *
 * Equity for the paper run is computed by `equity-tracker.ts`; this module
 * only persists the daily aggregates.
 */

import type { AggressiveGuardState } from "./types";

export interface DailyStateOptions {
  /** Redis key prefix. Default "ai-scalper:aggressive:daily". */
  keyPrefix?: string;
  /** Override the "today" derivation (tests). Defaults to () => new Date(). */
  now?: () => Date;
}

export interface DailyStateStore {
  /** Get the current snapshot. Initializes the day with `dayStartEquity` on first call of a new day. */
  getOrInitDay(dayStartEquityUsd: number): Promise<{ dailyRealizedPnlUsd: number; tradesToday: number; dayStartEquityUsd: number }>;
  /** Increment trade count (called when an order is placed). */
  recordTradeOpened(): Promise<void>;
  /** Add a net PnL realization (called when a trade closes; can be negative). */
  recordClosedPnl(netPnlUsd: number): Promise<void>;
  /** Combine current daily snapshot + supplied current equity into a guard-ready state. */
  buildGuardState(currentEquityUsd: number): Promise<AggressiveGuardState>;
}

export interface RedisLike {
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string | number): Promise<unknown>;
  hincrbyfloat(key: string, field: string, increment: number): Promise<string>;
  hincrby(key: string, field: string, increment: number): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  expire(key: string, seconds: number): Promise<unknown>;
}

const DEFAULT_PREFIX = "ai-scalper:aggressive:daily";
const KEY_TTL_SECONDS = 2 * 24 * 3_600; // keep yesterday around briefly for audit

function dayKey(prefix: string, d: Date): string {
  // YYYY-MM-DD in UTC — independent of process timezone.
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${prefix}:${yyyy}-${mm}-${dd}`;
}

export function createRedisDailyStateStore(
  redis: RedisLike,
  opts: DailyStateOptions = {},
): DailyStateStore {
  const prefix = opts.keyPrefix ?? DEFAULT_PREFIX;
  const now = opts.now ?? (() => new Date());

  const k = () => dayKey(prefix, now());

  return {
    async getOrInitDay(dayStartEquityUsd) {
      const key = k();
      const existing = await redis.hget(key, "dayStartEquityUsd");
      if (existing === null) {
        // First touch of this day — seed the start equity. Pipelined writes
        // would be nicer but RedisLike here keeps the surface tiny.
        await redis.hset(key, "dayStartEquityUsd", String(dayStartEquityUsd));
        await redis.hset(key, "dailyRealizedPnlUsd", "0");
        await redis.hset(key, "tradesToday", "0");
        await redis.expire(key, KEY_TTL_SECONDS);
        return { dailyRealizedPnlUsd: 0, tradesToday: 0, dayStartEquityUsd };
      }
      const all = await redis.hgetall(key);
      return {
        dailyRealizedPnlUsd: Number(all.dailyRealizedPnlUsd ?? "0") || 0,
        tradesToday: Number(all.tradesToday ?? "0") || 0,
        dayStartEquityUsd: Number(all.dayStartEquityUsd ?? "0") || 0,
      };
    },
    async recordTradeOpened() {
      await redis.hincrby(k(), "tradesToday", 1);
      await redis.expire(k(), KEY_TTL_SECONDS);
    },
    async recordClosedPnl(netPnlUsd) {
      await redis.hincrbyfloat(k(), "dailyRealizedPnlUsd", netPnlUsd);
      await redis.expire(k(), KEY_TTL_SECONDS);
    },
    async buildGuardState(currentEquityUsd) {
      // Use currentEquityUsd as the day-start seed if the day hasn't been initialized.
      const day = await this.getOrInitDay(currentEquityUsd);
      return {
        dailyRealizedPnlUsd: day.dailyRealizedPnlUsd,
        dayStartEquityUsd: day.dayStartEquityUsd,
        tradesToday: day.tradesToday,
        currentEquityUsd,
      };
    },
  };
}

/** In-memory variant for tests + paper-without-Redis scenarios. */
export function createInMemoryDailyStateStore(opts: DailyStateOptions = {}): DailyStateStore {
  const now = opts.now ?? (() => new Date());
  const days = new Map<string, { dayStartEquityUsd: number; dailyRealizedPnlUsd: number; tradesToday: number }>();
  const k = () => dayKey(opts.keyPrefix ?? DEFAULT_PREFIX, now());

  const getOrCreate = (key: string, seedEquity: number) => {
    let d = days.get(key);
    if (!d) { d = { dayStartEquityUsd: seedEquity, dailyRealizedPnlUsd: 0, tradesToday: 0 }; days.set(key, d); }
    return d;
  };
  return {
    async getOrInitDay(seedEquity) { return { ...getOrCreate(k(), seedEquity) }; },
    async recordTradeOpened() { getOrCreate(k(), 0).tradesToday += 1; },
    async recordClosedPnl(net) { getOrCreate(k(), 0).dailyRealizedPnlUsd += net; },
    async buildGuardState(currentEquityUsd) {
      const d = getOrCreate(k(), currentEquityUsd);
      return { dailyRealizedPnlUsd: d.dailyRealizedPnlUsd, dayStartEquityUsd: d.dayStartEquityUsd, tradesToday: d.tradesToday, currentEquityUsd };
    },
  };
}
