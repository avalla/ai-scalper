import { describe, expect, test } from "bun:test";
import { evaluatePromotion, scoreStrategy } from "./strategy-promotion";
import type { ClosedPositionLedgerEntry } from "../trading/position-ledger";

const mkTrade = (over: Partial<ClosedPositionLedgerEntry> & { closedAt?: string; realizedPnlUsd: number }): ClosedPositionLedgerEntry => ({
  closedAt: over.closedAt ?? "2026-06-01T00:00:00.000Z",
  cumulativeRealizedPnlUsd: 0, entryPrice: 70000, exitPrice: 70010,
  exitReason: over.exitReason ?? "spread-converged",
  leverage: 1, notionalUsd: 2000,
  openedAt: "2026-06-01T00:00:00.000Z",
  quantity: 0.001,
  side: "long" as const, stopLossPrice: 0, symbol: "BTCUSDT", takeProfitPrice: 0,
  strategyType: over.strategyType ?? "calendar-spread",
  realizedPnlUsd: over.realizedPnlUsd,
  feeUsd: over.feeUsd ?? 0.5,
  ...over,
});

const winningSeries = (n: number, strat: string): ClosedPositionLedgerEntry[] => {
  const out: ClosedPositionLedgerEntry[] = [];
  for (let i = 0; i < n; i += 1) {
    const d = new Date(Date.parse("2026-06-01T00:00:00.000Z") + i * 3600_000).toISOString();
    out.push(mkTrade({ strategyType: strat as any, realizedPnlUsd: 3, feeUsd: 0.5, closedAt: d }));
  }
  return out;
};

describe("scoreStrategy", () => {
  test("status:no-data when zero trades", () => {
    const v = scoreStrategy("x", []);
    expect(v.status).toBe("no-data");
  });

  test("status:wait when n < 30 even if every trade is a win", () => {
    const trades = winningSeries(10, "calendar-spread");
    const v = scoreStrategy("calendar-spread", trades);
    expect(v.status).toBe("wait");
    expect(v.failedCriteria.some((s) => s.includes("n=10 < 30"))).toBe(true);
  });

  test("status:wait when winrate < 70%", () => {
    // 30 trades, 50% win
    const t: ClosedPositionLedgerEntry[] = [];
    for (let i = 0; i < 30; i += 1) {
      t.push(mkTrade({ realizedPnlUsd: i % 2 === 0 ? 3 : -1, closedAt: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`, exitReason: "spread-converged" }));
    }
    const v = scoreStrategy("calendar-spread", t);
    expect(v.status).toBe("wait");
    expect(v.failedCriteria.some((s) => s.includes("winRate"))).toBe(true);
  });

  test("status:wait when net/fees < 5×", () => {
    // 30 wins of $0.30, fees $0.50 each → net=9, fees=15, ratio 0.6 < 5
    const t: ClosedPositionLedgerEntry[] = [];
    for (let i = 0; i < 30; i += 1) {
      t.push(mkTrade({ realizedPnlUsd: 0.30, feeUsd: 0.50, closedAt: `2026-06-${String(i % 28 + 1).padStart(2, "0")}T00:00:00.000Z`, exitReason: "divergence-stop" }));
    }
    // ensure recovery: add divergence-stop in middle, net ends positive
    const v = scoreStrategy("calendar-spread", t);
    expect(v.failedCriteria.some((s) => s.includes("net/fees"))).toBe(true);
  });

  test("status:wait when no divergence-stop has been seen yet", () => {
    // 30 wins, big net, no divergence-stop in history
    const trades = winningSeries(30, "calendar-spread");
    // make sure exitReason is spread-converged everywhere
    const v = scoreStrategy("calendar-spread", trades);
    expect(v.failedCriteria.some((s) => s.includes("divergence-stop"))).toBe(true);
  });

  test("status:promote when ALL criteria met (incl. divergence-stop survived)", () => {
    const trades = winningSeries(35, "calendar-spread");
    // inject 1 divergence-stop loss in middle; cum stays positive thanks to surrounding wins
    trades[10] = mkTrade({ realizedPnlUsd: -2, feeUsd: 0.5, exitReason: "divergence-stop", closedAt: trades[10]!.closedAt });
    const v = scoreStrategy("calendar-spread", trades);
    expect(v.status).toBe("promote");
    expect(v.divergenceStopsSurvived).toBeGreaterThan(0);
    expect(v.failedCriteria).toHaveLength(0);
  });

  test("status:disable when n>=30 but net<0", () => {
    const t: ClosedPositionLedgerEntry[] = [];
    for (let i = 0; i < 30; i += 1) {
      t.push(mkTrade({ realizedPnlUsd: -0.10, feeUsd: 0.5, closedAt: `2026-06-${String(i % 28 + 1).padStart(2, "0")}T00:00:00.000Z` }));
    }
    const v = scoreStrategy("basis-arb", t);
    expect(v.status).toBe("disable");
    expect(v.reason).toContain("net-negative");
  });

  test("divergenceStopsSurvived counts CLOSES-after-divstop while cum>0", () => {
    const trades = winningSeries(20, "x");
    // place divergence-stop at index 5; cum at index 5 = sum(5 wins of $3) - $2 = $13
    trades[5] = mkTrade({ realizedPnlUsd: -2, exitReason: "divergence-stop", closedAt: trades[5]!.closedAt });
    const v = scoreStrategy("x", trades);
    // After divstop at index 5, we count entries [5..19] while cum>0 → all 15 entries.
    expect(v.divergenceStopsSurvived).toBe(15);
  });
});

describe("evaluatePromotion", () => {
  test("groups by strategyType + sorts by net desc", () => {
    const entries = [
      ...winningSeries(35, "calendar-spread"),
      mkTrade({ strategyType: "basis-arb", realizedPnlUsd: -0.5 }),
      mkTrade({ strategyType: "basis-arb", realizedPnlUsd: -0.5 }),
    ];
    const verdicts = evaluatePromotion(entries);
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0].strategy).toBe("calendar-spread");
    expect(verdicts[1].strategy).toBe("basis-arb");
  });

  test("entries without strategyType bucket as '(none)'", () => {
    const e = mkTrade({ realizedPnlUsd: 1 });
    delete (e as any).strategyType;
    const verdicts = evaluatePromotion([e]);
    expect(verdicts.find((v) => v.strategy === "(none)")).toBeDefined();
  });
});
