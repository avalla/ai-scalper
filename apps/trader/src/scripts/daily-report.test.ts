import { describe, expect, test } from "bun:test";
import { formatDailyReport } from "./daily-report";
import { computeReport, type ReportEntry } from "./report";

function makeEntry(over: Partial<ReportEntry> = {}): ReportEntry {
  return {
    positionId: "p1",
    symbol: "BTCUSDT",
    side: "Buy",
    openedAt: new Date(1_700_000_000_000).toISOString(),
    closedAt: new Date(1_700_000_600_000).toISOString(),
    entryPrice: 50_000,
    exitPrice: 50_500,
    qty: 0.01,
    realizedPnlUsd: 5,
    grossPnlUsd: 5,
    feeUsd: 0.05,
    strategyType: "funding-arb",
    ...over,
  } as ReportEntry;
}

describe("formatDailyReport", () => {
  test("renders headline + per-strategy + per-symbol buckets", () => {
    const entries: ReportEntry[] = [
      makeEntry({ realizedPnlUsd: 5, symbol: "BTCUSDT", strategyType: "funding-arb" }),
      makeEntry({ realizedPnlUsd: -2, symbol: "ETHUSDT", strategyType: "longer-tf" }),
      makeEntry({ realizedPnlUsd: 3, symbol: "BTCUSDT", strategyType: "funding-arb" }),
    ];
    const report = computeReport(entries);
    const msg = formatDailyReport(
      { report, cost: null, windowHours: 24 },
      "2026-05-28",
    );
    expect(msg).toContain("Daily PnL — 2026-05-28");
    expect(msg).toContain("Trades: 3");
    expect(msg).toContain("Net PnL: +$6.00");
    expect(msg).toContain("Win rate: 66.7%");
    expect(msg).toContain("funding-arb");
    expect(msg).toContain("BTCUSDT");
  });

  test("includes cost line when snapshot provided", () => {
    const report = computeReport([makeEntry({ realizedPnlUsd: 10 })]);
    const msg = formatDailyReport(
      {
        report,
        cost: {
          bybitFeesUsd: 0.5,
          anthropicInputTokens: 1000,
          anthropicCachedTokens: 0,
          anthropicOutputTokens: 200,
          anthropicCostUsd: 0.3,
          anthropicCalls: 4,
          totalCostUsd: 0.8,
        } as any,
        windowHours: 24,
      },
      "2026-05-28",
    );
    expect(msg).toContain("Costs:");
    expect(msg).toContain("LLM +$0.30");
    expect(msg).toContain("Net PnL (post-LLM): +$9.70");
  });

  test("handles empty trade window gracefully", () => {
    const report = computeReport([]);
    const msg = formatDailyReport(
      { report, cost: null, windowHours: 24 },
      "2026-05-28",
    );
    expect(msg).toContain("Trades: 0");
    expect(msg).toContain("Net PnL: +$0.00");
  });
});
