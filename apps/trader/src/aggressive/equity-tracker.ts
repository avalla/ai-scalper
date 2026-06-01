/**
 * Equity tracker (paper).
 *
 * Returns the current equity for the aggressive subsystem. In paper mode:
 *   equity = startingEquity + sum(realizedPnlUsd over aggressive ledger)
 *
 * Live mode (out of scope for this MVP) would call client.getWalletBalance and
 * filter to the relevant coin/equity field — same interface, different impl.
 *
 * The aggressive ledger is namespaced separately from the conservative one:
 *   key: `ai-scalper:aggressive:positions:closed`  (Redis LIST)
 */

export interface EquityTracker {
  getCurrentEquityUsd(): Promise<number>;
}

export interface EquityTrackerRedisLike {
  lrange(key: string, start: number, stop: number): Promise<string[]>;
}

export interface PaperEquityTrackerOptions {
  /** Aggressive ledger Redis key. */
  ledgerKey?: string;
  /** Starting equity for the aggressive subsystem (USD). */
  startingEquityUsd: number;
}

const DEFAULT_LEDGER_KEY = "ai-scalper:aggressive:positions:closed";

export function createPaperEquityTracker(
  redis: EquityTrackerRedisLike,
  opts: PaperEquityTrackerOptions,
): EquityTracker {
  const key = opts.ledgerKey ?? DEFAULT_LEDGER_KEY;
  return {
    async getCurrentEquityUsd() {
      const rows = await redis.lrange(key, 0, -1);
      let sum = 0;
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row) as { realizedPnlUsd?: number };
          if (typeof parsed.realizedPnlUsd === "number") sum += parsed.realizedPnlUsd;
        } catch { /* skip malformed */ }
      }
      return opts.startingEquityUsd + sum;
    },
  };
}

/** In-memory tracker for tests — caller controls the equity. */
export function createInMemoryEquityTracker(initialEquityUsd: number): EquityTracker & { set(v: number): void } {
  let eq = initialEquityUsd;
  return {
    async getCurrentEquityUsd() { return eq; },
    set(v) { eq = v; },
  };
}
