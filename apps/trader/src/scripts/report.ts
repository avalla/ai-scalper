/**
 * Trade-journal report script. Reads closed-position entries (from Redis or
 * a JSONL fallback) and prints human-readable per-symbol, per-hour, per-champion
 * summaries plus aggregate stats. Run via `bun run report`.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolveProjectPath } from "@ai-scalper/trading-core";
import {
  createPositionLedgerClient,
  type ClosedPositionLedgerEntry,
} from "../trading/position-ledger";
import {
  createCostTracker,
  type CostRedisLike,
  type CostSnapshot,
} from "../observability/cost-tracker";

// `championIdAtEntry` is not currently persisted on the ledger entry; treat it
// as an optional extension so the report still groups it when added later.
export type ReportEntry = ClosedPositionLedgerEntry & {
  championIdAtEntry?: string;
  strategyType?: "ma-crossover" | "funding-arb" | "longer-tf" | "basis-arb";
};

export interface ReportBuckets {
  byVariant: Record<string, { trades: number; pnl: number }>;
  bySymbol: Record<string, { trades: number; pnl: number }>;
  byHour: Record<string, { trades: number; pnl: number }>;
  byStrategy: Record<string, { trades: number; pnl: number }>;
}

export interface ReportResult {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;        // net (post-fee)
  totalGrossPnl: number;   // pre-fee
  totalFees: number;
  maxDrawdown: number;
  currentStreak: { kind: "win" | "loss" | "none"; length: number };
  largestWin: number;
  largestLoss: number;
  avgTimeInPositionMs: number;
  pnlMean: number;
  pnlStddev: number;
  sharpeAnnualizedScalp: number;
  buckets: ReportBuckets;
}

export function computeReport(entries: ReportEntry[]): ReportResult {
  if (entries.length === 0) {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      totalPnl: 0,
      totalGrossPnl: 0,
      totalFees: 0,
      maxDrawdown: 0,
      currentStreak: { kind: "none", length: 0 },
      largestWin: 0,
      largestLoss: 0,
      avgTimeInPositionMs: 0,
      pnlMean: 0,
      pnlStddev: 0,
      sharpeAnnualizedScalp: 0,
      buckets: { byVariant: {}, bySymbol: {}, byHour: {}, byStrategy: {} },
    };
  }

  // Sort by closedAt ascending so streak/drawdown reflect chronological order.
  const sorted = [...entries].sort((a, b) => {
    const ta = Date.parse(a.closedAt);
    const tb = Date.parse(b.closedAt);
    return ta - tb;
  });

  let wins = 0;
  let losses = 0;
  let totalPnl = 0;
  let totalGrossPnl = 0;
  let totalFees = 0;
  let largestWin = 0;
  let largestLoss = 0;
  let peak = 0;
  let cumulative = 0;
  let maxDrawdown = 0;
  let totalTimeInPositionMs = 0;
  const pnlSeries: number[] = [];
  const byVariant: ReportBuckets["byVariant"] = {};
  const bySymbol: ReportBuckets["bySymbol"] = {};
  const byHour: ReportBuckets["byHour"] = {};
  const byStrategy: ReportBuckets["byStrategy"] = {};

  for (const entry of sorted) {
    const pnl = entry.realizedPnlUsd;
    pnlSeries.push(pnl);
    totalPnl += pnl;
    totalGrossPnl += entry.grossPnlUsd ?? pnl;
    totalFees += entry.feeUsd ?? 0;
    cumulative += pnl;
    if (cumulative > peak) peak = cumulative;
    const dd = peak - cumulative;
    if (dd > maxDrawdown) maxDrawdown = dd;

    if (pnl > 0) {
      wins += 1;
      if (pnl > largestWin) largestWin = pnl;
    } else if (pnl < 0) {
      losses += 1;
      if (pnl < largestLoss) largestLoss = pnl;
    }

    const closedTs = Date.parse(entry.closedAt);
    const openedTs = Date.parse(entry.openedAt);
    if (Number.isFinite(closedTs) && Number.isFinite(openedTs) && closedTs >= openedTs) {
      totalTimeInPositionMs += closedTs - openedTs;
    }

    // If no champion (non-MA strategies bypass the bandit), bucket the
    // variant by strategyType so the byVariant report still shows attribution.
    const variantKey = entry.championIdAtEntry ?? entry.strategyType ?? "single";
    const v = byVariant[variantKey] ?? { trades: 0, pnl: 0 };
    v.trades += 1;
    v.pnl += pnl;
    byVariant[variantKey] = v;

    const strategyKey = entry.strategyType ?? "ma-crossover";
    const st = byStrategy[strategyKey] ?? { trades: 0, pnl: 0 };
    st.trades += 1;
    st.pnl += pnl;
    byStrategy[strategyKey] = st;

    const s = bySymbol[entry.symbol] ?? { trades: 0, pnl: 0 };
    s.trades += 1;
    s.pnl += pnl;
    bySymbol[entry.symbol] = s;

    const hour = Number.isFinite(closedTs) ? new Date(closedTs).getUTCHours() : 0;
    const hourKey = String(hour).padStart(2, "0");
    const h = byHour[hourKey] ?? { trades: 0, pnl: 0 };
    h.trades += 1;
    h.pnl += pnl;
    byHour[hourKey] = h;
  }

  const totalTrades = sorted.length;
  const winRate = totalTrades > 0 ? wins / totalTrades : 0;
  const avgTimeInPositionMs = totalTrades > 0 ? totalTimeInPositionMs / totalTrades : 0;

  const pnlMean = pnlSeries.reduce((a, b) => a + b, 0) / pnlSeries.length;
  const pnlStddev = pnlSeries.length > 1
    ? Math.sqrt(
      pnlSeries.reduce((a, b) => a + (b - pnlMean) * (b - pnlMean), 0) / (pnlSeries.length - 1),
    )
    : 0;
  // Scalp-friendly annualisation: 252 trading days × 24 hours = 6048 trades/year reference.
  const sharpeAnnualizedScalp = pnlStddev > 0
    ? (pnlMean / pnlStddev) * Math.sqrt(252 * 24)
    : 0;

  // Current streak (from the tail of sorted).
  let streakKind: "win" | "loss" | "none" = "none";
  let streakLength = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const pnl = sorted[i]!.realizedPnlUsd;
    const kind: "win" | "loss" | "none" = pnl > 0 ? "win" : pnl < 0 ? "loss" : "none";
    if (kind === "none") break;
    if (streakKind === "none") {
      streakKind = kind;
      streakLength = 1;
    } else if (streakKind === kind) {
      streakLength += 1;
    } else {
      break;
    }
  }

  return {
    totalTrades,
    wins,
    losses,
    winRate,
    totalPnl,
    totalGrossPnl,
    totalFees,
    maxDrawdown,
    currentStreak: { kind: streakKind, length: streakLength },
    largestWin,
    largestLoss,
    avgTimeInPositionMs,
    pnlMean,
    pnlStddev,
    sharpeAnnualizedScalp,
    buckets: { byVariant, bySymbol, byHour, byStrategy },
  };
}

function formatUsd(n: number): string {
  return (n >= 0 ? " " : "") + n.toFixed(4);
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}m`;
  const h = m / 60;
  return `${h.toFixed(2)}h`;
}

function printBucket(
  title: string,
  bucket: Record<string, { trades: number; pnl: number }>,
  keyLabel: string,
): void {
  const rows = Object.entries(bucket).sort((a, b) => b[1].pnl - a[1].pnl);
  if (rows.length === 0) return;
  console.log(`\n${title}`);
  console.log(`  ${keyLabel.padEnd(20)} ${"trades".padStart(8)}  ${"pnlUsd".padStart(12)}`);
  for (const [k, v] of rows) {
    console.log(`  ${k.padEnd(20)} ${String(v.trades).padStart(8)}  ${formatUsd(v.pnl).padStart(12)}`);
  }
}

export function printReport(report: ReportResult): void {
  if (report.totalTrades === 0) {
    console.log("No closed trades yet.");
    return;
  }

  console.log("─── Trade Journal Report ────────────────────────────────");
  console.log(`Total trades        : ${report.totalTrades}`);
  console.log(`Wins / Losses       : ${report.wins} / ${report.losses}`);
  console.log(`Win rate            : ${(report.winRate * 100).toFixed(2)}%`);
  console.log(`Gross PnL (pre-fee) : ${formatUsd(report.totalGrossPnl)} USD`);
  console.log(`Fees paid           : ${formatUsd(report.totalFees)} USD`);
  console.log(`Net PnL (post-fee)  : ${formatUsd(report.totalPnl)} USD`);
  console.log(`Max drawdown        : ${formatUsd(report.maxDrawdown)} USD`);
  console.log(
    `Current streak      : ${report.currentStreak.kind} × ${report.currentStreak.length}`,
  );
  console.log(`Largest win         : ${formatUsd(report.largestWin)} USD`);
  console.log(`Largest loss        : ${formatUsd(report.largestLoss)} USD`);
  console.log(`Avg time in position: ${formatDurationMs(report.avgTimeInPositionMs)}`);
  console.log(`PnL mean / stddev   : ${formatUsd(report.pnlMean)} / ${formatUsd(report.pnlStddev)}`);
  console.log(`Sharpe (scalp×252h) : ${report.sharpeAnnualizedScalp.toFixed(3)}`);

  printBucket("PnL by champion variant", report.buckets.byVariant, "variant");
  printBucket("PnL by strategy", report.buckets.byStrategy, "strategy");
  printBucket("PnL by symbol", report.buckets.bySymbol, "symbol");
  printBucket("PnL by hour (UTC)", report.buckets.byHour, "hour");
  console.log("─────────────────────────────────────────────────────────");
}

function parseJsonl(raw: string): ReportEntry[] {
  const out: ReportEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as ReportEntry);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

async function loadEntries(): Promise<ReportEntry[]> {
  // Optional explicit override via env (mainly for tests).
  const explicit = process.env.REPORT_INPUT_PATH;
  if (explicit && existsSync(explicit)) {
    return parseJsonl(readFileSync(explicit, "utf8"));
  }

  // Fallback JSONL location (kept compatible with brief).
  const jsonlPath = resolveProjectPath("apps/trader/data/runtime/closed-positions.jsonl");
  if (existsSync(jsonlPath)) {
    return parseJsonl(readFileSync(jsonlPath, "utf8"));
  }

  // Primary: Redis ledger.
  try {
    const client = createPositionLedgerClient();
    try {
      // CLOSED_POSITIONS_KEY is private; rebuild here to keep coupling minimal.
      const raw = await (client as unknown as {
        lrange(key: string, start: number, stop: number): Promise<string[]>;
      }).lrange("ai-scalper:trader:positions:closed", 0, -1);
      const entries: ReportEntry[] = [];
      for (const r of raw) {
        try {
          entries.push(JSON.parse(r) as ReportEntry);
        } catch {
          // skip
        }
      }
      return entries;
    } finally {
      await client.quit().catch(() => {});
      client.disconnect();
    }
  } catch {
    return [];
  }
}

function formatUsdShort(n: number): string {
  return `$${n.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function printCostSnapshot(snap: CostSnapshot, netPnlUsd: number): void {
  console.log("─── Costs (last 24h) ────────────────────────────────────");
  console.log(`Bybit fees       : ${formatUsdShort(snap.bybitFeesUsd)}`);
  console.log(
    `Anthropic tokens : ${formatTokens(snap.anthropicInputTokens)} in / `
    + `${formatTokens(snap.anthropicCachedTokens)} cached / `
    + `${formatTokens(snap.anthropicOutputTokens)} out`
    + ` (${snap.anthropicCalls} calls)`,
  );
  console.log(`Anthropic cost   : ${formatUsdShort(snap.anthropicCostUsd)}`);
  console.log(`TOTAL COST       : ${formatUsdShort(snap.totalCostUsd)}`);
  console.log(`Net PnL (post-fee post-llm) : ${formatUsdShort(netPnlUsd - snap.anthropicCostUsd)}`);
  console.log("─────────────────────────────────────────────────────────");
}

async function loadCostSnapshot(): Promise<CostSnapshot | null> {
  try {
    const client = createPositionLedgerClient() as unknown as CostRedisLike & {
      quit(): Promise<unknown>;
      disconnect(): void;
    };
    try {
      const tracker = createCostTracker(client);
      return await tracker.getDaily();
    } finally {
      await (client as unknown as { quit(): Promise<unknown> }).quit().catch(() => {});
      (client as unknown as { disconnect(): void }).disconnect();
    }
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const entries = await loadEntries();
  if (entries.length === 0) {
    console.log("No closed trades yet.");
    return;
  }
  const report = computeReport(entries);
  printReport(report);
  const costSnap = await loadCostSnapshot();
  if (costSnap) {
    printCostSnapshot(costSnap, report.totalPnl);
  }
}

if (import.meta.main) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
