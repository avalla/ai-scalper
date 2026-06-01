/**
 * Daily PnL report — builds the report and POSTs it to the alert webhook.
 * Designed to be invoked from cron / systemd timer (see deploy/).
 * Webhook URL is read from ALERT_WEBHOOK_URL env var; if absent the report
 * is printed to stdout only (still useful for log-scraper setups).
 */

import { createWebhookAlerter } from "../alerts/webhook";
import { createPositionLedgerClient, type ClosedPositionLedgerEntry } from "../trading/position-ledger";
import {
  createCostTracker,
  type CostRedisLike,
  type CostSnapshot,
} from "../observability/cost-tracker";
import { computeReport, type ReportEntry, type ReportResult } from "./report";

const TOP_N = 5;

interface DailyReportPayload {
  report: ReportResult;
  cost: CostSnapshot | null;
  windowHours: number;
}

export function formatDailyReport(p: DailyReportPayload, isoDate: string): string {
  const { report, cost, windowHours } = p;
  const lines: string[] = [];
  lines.push(`📊 Daily PnL — ${isoDate} (last ${windowHours}h)`);
  lines.push(`Trades: ${report.totalTrades} | Net PnL: ${formatUsd(report.totalPnl)} | Win rate: ${(report.winRate * 100).toFixed(1)}%`);
  if (report.avgTimeInPositionMs > 0) {
    lines.push(`Avg hold: ${formatDuration(report.avgTimeInPositionMs)}`);
  }

  const top = (bucket: Record<string, { trades: number; pnl: number }>): string => {
    const sorted = Object.entries(bucket)
      .sort((a, b) => b[1].pnl - a[1].pnl)
      .slice(0, TOP_N);
    if (sorted.length === 0) return "  (none)";
    return sorted.map(([k, v]) => `  ${k}: ${formatUsd(v.pnl)} (${v.trades}t)`).join("\n");
  };

  lines.push("");
  lines.push("By strategy:");
  lines.push(top(report.buckets.byStrategy));
  lines.push("");
  lines.push(`Top ${TOP_N} symbols:`);
  lines.push(top(report.buckets.bySymbol));

  if (cost) {
    lines.push("");
    lines.push(`Costs: fees ${formatUsd(cost.bybitFeesUsd)} | LLM ${formatUsd(cost.anthropicCostUsd)} (${cost.anthropicCalls} calls)`);
    lines.push(`Net PnL (post-LLM): ${formatUsd(report.totalPnl - cost.anthropicCostUsd)}`);
  }
  return lines.join("\n");
}

function formatUsd(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}$${n.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  const min = ms / 60_000;
  if (min < 60) return `${min.toFixed(1)}m`;
  return `${(min / 60).toFixed(1)}h`;
}

async function loadRecentEntries(windowMs: number): Promise<ReportEntry[]> {
  const client = createPositionLedgerClient() as unknown as {
    lrange(key: string, start: number, stop: number): Promise<string[]>;
    quit(): Promise<unknown>;
    disconnect(): void;
  };
  const cutoff = Date.now() - windowMs;
  try {
    const raw = await client.lrange("position-ledger:closed", 0, -1);
    const entries: ReportEntry[] = [];
    for (const line of raw) {
      try {
        const parsed = JSON.parse(line) as ClosedPositionLedgerEntry;
        const closedAt = Date.parse(parsed.closedAt);
        if (Number.isFinite(closedAt) && closedAt >= cutoff) {
          entries.push(parsed as ReportEntry);
        }
      } catch {
        // skip malformed
      }
    }
    return entries;
  } finally {
    await client.quit().catch(() => {});
    client.disconnect();
  }
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
      await client.quit().catch(() => {});
      client.disconnect();
    }
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const windowHours = Number(process.env.DAILY_REPORT_WINDOW_HOURS ?? "24");
  const windowMs = windowHours * 3_600_000;
  const entries = await loadRecentEntries(windowMs).catch(() => [] as ReportEntry[]);
  const report = computeReport(entries);
  const cost = await loadCostSnapshot();
  const isoDate = new Date().toISOString().slice(0, 10);
  const message = formatDailyReport({ report, cost, windowHours }, isoDate);

  console.log(message);

  const url = process.env.ALERT_WEBHOOK_URL ?? "";
  if (!url) {
    console.log("\n[daily-report] ALERT_WEBHOOK_URL not set — stdout only.");
    return;
  }
  const alerter = createWebhookAlerter(url);
  await alerter.send(message);
}

if (import.meta.main) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
