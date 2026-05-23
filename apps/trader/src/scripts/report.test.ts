import { describe, expect, it } from "bun:test";
import { computeReport, type ReportEntry } from "./report";

function makeEntry(opts: Partial<ReportEntry> & { realizedPnlUsd: number; closedAt: string }): ReportEntry {
  return {
    closedAt: opts.closedAt,
    cumulativeRealizedPnlUsd: opts.cumulativeRealizedPnlUsd ?? 0,
    entryPrice: opts.entryPrice ?? 100,
    exitPrice: opts.exitPrice ?? 100,
    exitReason: opts.exitReason ?? "take-profit",
    leverage: opts.leverage ?? 5,
    notionalUsd: opts.notionalUsd ?? 100,
    openedAt: opts.openedAt ?? opts.closedAt,
    quantity: opts.quantity ?? 1,
    realizedPnlUsd: opts.realizedPnlUsd,
    side: opts.side ?? "long",
    stopLossPrice: opts.stopLossPrice ?? 99,
    symbol: opts.symbol ?? "BTCUSDT",
    takeProfitPrice: opts.takeProfitPrice ?? 101,
    championIdAtEntry: opts.championIdAtEntry,
    strategyType: opts.strategyType,
  };
}

describe("computeReport", () => {
  it("returns zero report on empty input", () => {
    const r = computeReport([]);
    expect(r.totalTrades).toBe(0);
    expect(r.winRate).toBe(0);
    expect(r.totalPnl).toBe(0);
  });

  it("computes win-rate, total PnL, buckets, and streak", () => {
    const entries: ReportEntry[] = [
      makeEntry({ realizedPnlUsd: 5, closedAt: "2026-05-23T10:00:00Z", openedAt: "2026-05-23T09:55:00Z", symbol: "BTCUSDT", championIdAtEntry: "ma-5-20-th4" }),
      makeEntry({ realizedPnlUsd: -3, closedAt: "2026-05-23T11:00:00Z", openedAt: "2026-05-23T10:50:00Z", symbol: "ETHUSDT", championIdAtEntry: "ma-3-15-th3" }),
      makeEntry({ realizedPnlUsd: 7, closedAt: "2026-05-23T12:00:00Z", openedAt: "2026-05-23T11:55:00Z", symbol: "BTCUSDT", championIdAtEntry: "ma-5-20-th4" }),
      makeEntry({ realizedPnlUsd: 2, closedAt: "2026-05-23T13:00:00Z", openedAt: "2026-05-23T12:58:00Z", symbol: "BTCUSDT", championIdAtEntry: "ma-5-20-th4" }),
    ];

    const r = computeReport(entries);

    expect(r.totalTrades).toBe(4);
    expect(r.wins).toBe(3);
    expect(r.losses).toBe(1);
    expect(r.winRate).toBeCloseTo(0.75, 5);
    expect(r.totalPnl).toBeCloseTo(11, 5);
    expect(r.largestWin).toBe(7);
    expect(r.largestLoss).toBe(-3);

    // Per-symbol
    expect(r.buckets.bySymbol.BTCUSDT?.trades).toBe(3);
    expect(r.buckets.bySymbol.BTCUSDT?.pnl).toBeCloseTo(14, 5);
    expect(r.buckets.bySymbol.ETHUSDT?.trades).toBe(1);

    // Per-variant
    expect(r.buckets.byVariant["ma-5-20-th4"]?.trades).toBe(3);
    expect(r.buckets.byVariant["ma-3-15-th3"]?.pnl).toBeCloseTo(-3, 5);

    // Current streak (tail = 2 wins → win × 2)
    expect(r.currentStreak.kind).toBe("win");
    expect(r.currentStreak.length).toBe(2);

    // Max drawdown: cumulative 5, 2, 9, 11 → peak after first = 5, drop to 2 = dd 3.
    expect(r.maxDrawdown).toBeCloseTo(3, 5);
  });

  it("buckets by strategyType when present, defaulting to ma-crossover otherwise", () => {
    const entries: ReportEntry[] = [
      makeEntry({ realizedPnlUsd: 3, closedAt: "2026-05-23T10:00:00Z", strategyType: "funding-arb" }),
      makeEntry({ realizedPnlUsd: -1, closedAt: "2026-05-23T11:00:00Z", strategyType: "funding-arb" }),
      makeEntry({ realizedPnlUsd: 4, closedAt: "2026-05-23T12:00:00Z", strategyType: "longer-tf" }),
      // No strategyType => defaults to ma-crossover
      makeEntry({ realizedPnlUsd: 2, closedAt: "2026-05-23T13:00:00Z", championIdAtEntry: "ma-5-20-th4" }),
    ];
    const r = computeReport(entries);
    expect(r.buckets.byStrategy["funding-arb"]?.trades).toBe(2);
    expect(r.buckets.byStrategy["funding-arb"]?.pnl).toBeCloseTo(2, 5);
    expect(r.buckets.byStrategy["longer-tf"]?.trades).toBe(1);
    expect(r.buckets.byStrategy["ma-crossover"]?.trades).toBe(1);
  });

  it("falls back variant bucket to strategyType when championIdAtEntry is null", () => {
    const entries: ReportEntry[] = [
      makeEntry({ realizedPnlUsd: 5, closedAt: "2026-05-23T10:00:00Z", strategyType: "funding-arb" }),
      makeEntry({ realizedPnlUsd: -2, closedAt: "2026-05-23T11:00:00Z", strategyType: "longer-tf" }),
    ];
    const r = computeReport(entries);
    expect(r.buckets.byVariant["funding-arb"]?.trades).toBe(1);
    expect(r.buckets.byVariant["funding-arb"]?.pnl).toBeCloseTo(5, 5);
    expect(r.buckets.byVariant["longer-tf"]?.trades).toBe(1);
    expect(r.buckets.byVariant["single"]).toBeUndefined();
  });
});
