import { describe, expect, test } from "bun:test";
import { auditExecution, type ExecutionFill, type LedgerCloseEntry } from "./execution-auditor";

const WINDOW_START = Date.now() - 60 * 60_000;
const WINDOW_END = Date.now();

function mkFill(o: Partial<ExecutionFill> = {}): ExecutionFill {
  return {
    symbol: "BTCUSDT",
    side: "Buy",
    isMaker: false,
    execFeeUsd: 0.21,
    execValueUsd: 376,
    execPrice: 62000,
    execTimeMs: (WINDOW_START + WINDOW_END) / 2,
    ...o,
  };
}

function mkClose(o: Partial<LedgerCloseEntry> = {}): LedgerCloseEntry {
  return {
    strategyType: "calendar-spread",
    closedAt: new Date((WINDOW_START + WINDOW_END) / 2).toISOString(),
    realizedPnlUsd: 0.5,
    feeUsd: 0.30,
    ...o,
  };
}

describe("auditExecution", () => {
  test("empty input yields zero counts + no-data flags", () => {
    const r = auditExecution({ fills: [], ledgerEntries: [], windowStartMs: WINDOW_START, windowEndMs: WINDOW_END });
    expect(r.fillCount).toBe(0);
    expect(r.ledgerTradeCount).toBe(0);
    expect(r.flags).toContain("no fills observed in window");
  });

  test("flags high taker ratio", () => {
    const fills = [
      mkFill({ isMaker: false }), mkFill({ isMaker: false }),
      mkFill({ isMaker: false }), mkFill({ isMaker: true }),
    ];
    const r = auditExecution({ fills, ledgerEntries: [mkClose()], windowStartMs: WINDOW_START, windowEndMs: WINDOW_END });
    expect(r.flags.some((f) => f.startsWith("high-taker-ratio"))).toBe(true);
    expect(r.takerFillCount).toBe(3);
    expect(r.makerFillCount).toBe(1);
  });

  test("flags real fees too high vs estimate", () => {
    const fills = [mkFill({ execFeeUsd: 1.50 }), mkFill({ execFeeUsd: 1.50 })];
    const ledger = [mkClose({ feeUsd: 0.30 })];
    const r = auditExecution({ fills, ledgerEntries: ledger, windowStartMs: WINDOW_START, windowEndMs: WINDOW_END });
    expect(r.realFeesUsd).toBeCloseTo(3.0, 5);
    expect(r.estimatedFeesUsd).toBeCloseTo(0.3, 5);
    expect(r.flags.some((f) => f.startsWith("real-fees-"))).toBe(true);
  });

  test("computes per-trade gap from wallet delta vs ledger", () => {
    // 2 closed trades, ledger says +$2, wallet went -$1 → gap = -$3 over 2 trades = -$1.50/trade
    const ledger = [mkClose({ realizedPnlUsd: 1 }), mkClose({ realizedPnlUsd: 1 })];
    const r = auditExecution({
      fills: [], ledgerEntries: ledger,
      walletStartUsd: 100, walletEndUsd: 99,
      windowStartMs: WINDOW_START, windowEndMs: WINDOW_END,
    });
    expect(r.perTradeGapUsd).toBeCloseTo(-1.5, 5);
    expect(r.flags.some((f) => f.includes("per-trade loss"))).toBe(true);
  });

  test("ignores fills outside the window", () => {
    const fills = [
      mkFill({ execTimeMs: WINDOW_START - 1000 }), // before
      mkFill({ execTimeMs: WINDOW_END + 1000 }),   // after
      mkFill({ execTimeMs: WINDOW_END - 1000 }),   // inside
    ];
    const r = auditExecution({ fills, ledgerEntries: [], windowStartMs: WINDOW_START, windowEndMs: WINDOW_END });
    expect(r.fillCount).toBe(1);
  });
});
