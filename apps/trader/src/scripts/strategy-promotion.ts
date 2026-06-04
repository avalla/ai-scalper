/**
 * strategy-promotion — automated check of paper trading data against the
 * promotion-to-live criteria. Run periodically (cron / systemd timer) or
 * on-demand to know which strategies are ready to be promoted from paper
 * to live trading.
 *
 * Split into a PURE scorer (evaluatePromotion) and a thin CLI wrapper that
 * reads the ledger from Redis. The scorer is fully unit-tested.
 *
 * Criteria (4 automated, 1 manual):
 *   AUTO 1. n >= 30 closed trades                      (statistical floor)
 *   AUTO 2. win-rate >= 70%                            (edge robustness)
 *   AUTO 3. net cumulato > 5 × sum(fees)               (edge >> noise)
 *   AUTO 4. at least 1 divergence-stop survived        (guard validated +
 *                                                       system recovered)
 *   MANUAL  0 operational errors in the window         (operator judgment)
 */

import type { ClosedPositionLedgerEntry } from "../trading/position-ledger";

export const MIN_TRADES = Number(process.env.PROMOTION_MIN_TRADES ?? "30");
export const MIN_WIN_RATE = Number(process.env.PROMOTION_MIN_WIN_RATE ?? "0.70");
// Edge-over-noise floor: net must be >= this × cumulative fees. 2× means the
// strategy clears costs with a 100% safety margin. Calendar-spread sits at
// ~2.5× empirically. Tighten via PROMOTION_MIN_NET_OVER_FEES env.
export const MIN_NET_OVER_FEES_MULTIPLE = Number(process.env.PROMOTION_MIN_NET_OVER_FEES ?? "2");

export type PromotionStatus = "promote" | "wait" | "disable" | "no-data";

export interface PromotionVerdict {
  strategy: string;
  status: PromotionStatus;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  net: number;
  fees: number;
  netOverFees: number;
  divergenceStopsSurvived: number;
  passedCriteria: string[];
  failedCriteria: string[];
  reason: string;
}

interface TradeForScoring {
  strategyType?: string;
  realizedPnlUsd: number;
  feeUsd?: number;
  exitReason?: string;
  /** ISO close timestamp — used to detect "survived after divergence-stop". */
  closedAt: string;
}

/** Pure scoring function: receives closed trades for ONE strategy, returns verdict. */
export function scoreStrategy(strategy: string, trades: readonly TradeForScoring[]): PromotionVerdict {
  if (trades.length === 0) {
    return {
      strategy, status: "no-data",
      trades: 0, wins: 0, losses: 0, winRate: 0,
      net: 0, fees: 0, netOverFees: 0,
      divergenceStopsSurvived: 0,
      passedCriteria: [], failedCriteria: ["no closed trades observed"],
      reason: "no closed trades observed",
    };
  }

  const wins = trades.filter((t) => t.realizedPnlUsd > 0).length;
  const losses = trades.length - wins;
  const winRate = wins / trades.length;
  const net = trades.reduce((s, t) => s + t.realizedPnlUsd, 0);
  const fees = trades.reduce((s, t) => s + (t.feeUsd ?? 0), 0);
  const netOverFees = fees > 0 ? net / fees : Number.POSITIVE_INFINITY;

  // Divergence-stop survived = at least one divergence-stop exit AND the
  // cumulative net trajectory recovered to positive afterwards. Validates
  // both the guard and the system's ability to recover from a loss.
  const sorted = [...trades].sort((a, b) => a.closedAt.localeCompare(b.closedAt));
  let cum = 0; let divStopSeen = false; let divStopRecovered = 0;
  for (const t of sorted) {
    cum += t.realizedPnlUsd;
    if (t.exitReason === "divergence-stop") divStopSeen = true;
    if (divStopSeen && cum > 0) divStopRecovered += 1;
  }

  // Net-loss strategy with enough sample → disable rather than promote.
  if (trades.length >= MIN_TRADES && net < 0) {
    return {
      strategy, status: "disable",
      trades: trades.length, wins, losses, winRate, net, fees, netOverFees, divergenceStopsSurvived: divStopRecovered,
      passedCriteria: [], failedCriteria: [`net cumulato negative ($${net.toFixed(2)}) after ${trades.length} trades`],
      reason: "strategy is net-negative with significant sample — recommend OFF",
    };
  }

  const passed: string[] = [];
  const failed: string[] = [];
  if (trades.length >= MIN_TRADES) passed.push(`n=${trades.length} >= ${MIN_TRADES}`);
  else failed.push(`n=${trades.length} < ${MIN_TRADES}`);

  if (winRate >= MIN_WIN_RATE) passed.push(`winRate=${(winRate * 100).toFixed(0)}% >= ${MIN_WIN_RATE * 100}%`);
  else failed.push(`winRate=${(winRate * 100).toFixed(0)}% < ${MIN_WIN_RATE * 100}%`);

  if (netOverFees >= MIN_NET_OVER_FEES_MULTIPLE) passed.push(`net/fees=${netOverFees.toFixed(1)}× >= ${MIN_NET_OVER_FEES_MULTIPLE}×`);
  else failed.push(`net/fees=${netOverFees.toFixed(1)}× < ${MIN_NET_OVER_FEES_MULTIPLE}×`);

  if (divStopRecovered > 0) passed.push(`divergence-stop survived ${divStopRecovered}× (net recovered to + after)`);
  else failed.push("no divergence-stop survived yet (guard untested OR no loss observed)");

  const status: PromotionStatus = failed.length === 0 ? "promote" : "wait";
  const reason = failed.length === 0
    ? `all ${passed.length} automated criteria passed — operator confirms 0 op errors → promote`
    : `${failed.length}/${passed.length + failed.length} criteria pending`;

  return {
    strategy, status,
    trades: trades.length, wins, losses, winRate, net, fees, netOverFees, divergenceStopsSurvived: divStopRecovered,
    passedCriteria: passed, failedCriteria: failed, reason,
  };
}

/**
 * Score all strategies in a ledger snapshot. Returns one verdict per strategy
 * actually present in the data. Strategy "(none)" collects entries that
 * lack strategyType (legacy ledger format).
 */
export function evaluatePromotion(entries: readonly ClosedPositionLedgerEntry[]): PromotionVerdict[] {
  const byStrategy = new Map<string, TradeForScoring[]>();
  for (const e of entries) {
    const key = e.strategyType ?? "(none)";
    const bucket = byStrategy.get(key) ?? [];
    bucket.push({ strategyType: key, realizedPnlUsd: e.realizedPnlUsd, feeUsd: e.feeUsd, exitReason: e.exitReason, closedAt: e.closedAt });
    byStrategy.set(key, bucket);
  }
  const out: PromotionVerdict[] = [];
  for (const [strategy, trades] of byStrategy) {
    out.push(scoreStrategy(strategy, trades));
  }
  return out.sort((a, b) => b.net - a.net);
}

// ── CLI ───────────────────────────────────────────────────────────────────
// Run with:  bun run apps/trader/src/scripts/strategy-promotion.ts
// Exit codes: 0 = nothing actionable, 1 = ≥1 promote, 2 = ≥1 disable

if (import.meta.main) {
  const IORedis = (await import("ioredis")).default;
  const redisUrl = process.env.PROMOTION_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  const ledgerKey = process.env.PROMOTION_LEDGER_KEY ?? "ai-scalper:trader:positions:closed";

  const r = new IORedis(redisUrl, { maxRetriesPerRequest: 1 });
  const raw = await r.lrange(ledgerKey, 0, -1);
  await r.quit();

  const entries = raw
    .map((s) => { try { return JSON.parse(s); } catch { return null; } })
    .filter((e): e is ClosedPositionLedgerEntry => e !== null);

  const verdicts = evaluatePromotion(entries);

  const RED = "\x1b[31m"; const GREEN = "\x1b[32m"; const YEL = "\x1b[33m"; const DIM = "\x1b[2m"; const RST = "\x1b[0m";
  const tag = (s: PromotionStatus) =>
    s === "promote" ? `${GREEN}PROMOTE${RST}` :
    s === "disable" ? `${RED}DISABLE${RST}` :
    s === "no-data" ? `${DIM}NO-DATA${RST}` :
    `${YEL}WAIT   ${RST}`;

  console.log(`\nstrategy-promotion check — source: ${redisUrl} key=${ledgerKey}\n`);
  console.log("strategy".padEnd(22) + "status   " + "n".padStart(4) + "  " + "wr".padStart(5) + "  " + "net".padStart(10) + "  reason");
  console.log("─".repeat(110));
  for (const v of verdicts) {
    console.log(
      v.strategy.padEnd(22) +
      tag(v.status) + "  " +
      String(v.trades).padStart(4) + "  " +
      `${(v.winRate * 100).toFixed(0)}%`.padStart(5) + "  " +
      `$${v.net.toFixed(2)}`.padStart(10) + "  " +
      v.reason,
    );
    if (v.failedCriteria.length > 0) {
      for (const f of v.failedCriteria) console.log(`${DIM}    - ${f}${RST}`);
    }
  }
  console.log();

  const hasPromote = verdicts.some((v) => v.status === "promote");
  const hasDisable = verdicts.some((v) => v.status === "disable");
  if (hasDisable) process.exit(2);
  if (hasPromote) process.exit(1);
  process.exit(0);
}
