import { describe, expect, test } from "bun:test";
import { processAggressiveManageTick, type AggressiveManageDeps } from "./manage-processor";
import type { AggressiveManageJobData } from "./adapter";
import type { TraderConfig } from "../config";
import type { ClosedPositionLedgerEntry } from "../trading/position-ledger";
import { createInMemoryDailyStateStore } from "./daily-state";

function makeJob(overrides: Partial<AggressiveManageJobData> = {}): AggressiveManageJobData {
  return {
    positionId: "aggressive-position:1-BTCUSDT",
    symbol: "BTCUSDT", side: "long",
    entryPrice: 73000, qty: 0.01, qtyStr: "0.01",
    qtyStep: "0.001", minOrderQty: "0.001",
    notionalUsd: 50, leverage: 25,
    openedAt: new Date(1_700_000_000_000).toISOString(),
    stopPrice: 71540, takeProfitPrice: 73170, // ±2% on a long
    strategy: "liquidation-hunter", entryReason: "test",
    lastReviewAt: new Date(1_700_000_000_000).toISOString(),
    ...overrides,
  };
}

function makeConfig(overrides: Partial<TraderConfig> = {}): TraderConfig {
  return { ...({ paperTrading: true, feeRoundTripBps: 4 } as unknown as TraderConfig), ...overrides };
}

function makeDeps(overrides: Partial<AggressiveManageDeps> & { lastPrice?: number; fail?: boolean } = {}): {
  deps: AggressiveManageDeps; ledger: ClosedPositionLedgerEntry[];
} {
  const ledger: ClosedPositionLedgerEntry[] = [];
  const deps: AggressiveManageDeps = {
    config: makeConfig(overrides.config),
    client: { async createOrder() {} } as any,
    tickerSource: {
      async getTicker() { if (overrides.fail) throw new Error("net"); return { lastPrice: String(overrides.lastPrice ?? 73000) } as any; },
      peek() { return null; },
    } as any,
    alerter: { async send() {} } as any,
    ledger: { async appendClosedPosition(e) { ledger.push(e); } },
    dailyState: createInMemoryDailyStateStore(),
    log: () => {}, now: () => 1_700_000_060_000,
    ...overrides,
  };
  return { deps, ledger };
}

describe("processAggressiveManageTick", () => {
  test("continue when price between stop and TP", async () => {
    const { deps, ledger } = makeDeps({ lastPrice: 73050 });
    const r = await processAggressiveManageTick(makeJob(), deps);
    expect(r.status).toBe("continue");
    expect(ledger).toHaveLength(0);
  });

  test("HARD STOP triggers when long crosses below stopPrice", async () => {
    const { deps, ledger } = makeDeps({ lastPrice: 71500 }); // below stop 71540
    const r = await processAggressiveManageTick(makeJob(), deps);
    expect(r.status).toBe("complete");
    if (r.status === "complete") expect(r.reason).toBe("hard-stop");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.realizedPnlUsd).toBeLessThan(0);
    expect(ledger[0]!.exitReason).toBe("hard-stop");
  });

  test("TAKE PROFIT triggers when long crosses above tpPrice", async () => {
    const { deps, ledger } = makeDeps({ lastPrice: 73200 }); // above TP 73170
    const r = await processAggressiveManageTick(makeJob(), deps);
    expect(r.status).toBe("complete");
    if (r.status === "complete") expect(r.reason).toBe("take-profit");
    expect(ledger[0]!.realizedPnlUsd).toBeGreaterThan(0);
  });

  test("SHORT inverted: stop above, TP below", async () => {
    const job = makeJob({ side: "short", entryPrice: 73000, stopPrice: 74460, takeProfitPrice: 72830 });
    // Price rises above stop → hit
    const { deps, ledger } = makeDeps({ lastPrice: 74500 });
    const r = await processAggressiveManageTick(job, deps);
    expect(r.status).toBe("complete");
    if (r.status === "complete") expect(r.reason).toBe("hard-stop");
    expect(ledger[0]!.realizedPnlUsd).toBeLessThan(0);
  });

  test("max-hold triggers when elapsed exceeds maxHoldSec", async () => {
    const job = makeJob({ openedAt: new Date(1_700_000_000_000).toISOString() });
    // now is +60s in deps; set maxHoldSec=30 → elapsed=60 ≥ 30 → trigger
    const { deps, ledger } = makeDeps({ lastPrice: 73000, maxHoldSec: 30 });
    const r = await processAggressiveManageTick(job, deps);
    expect(r.status).toBe("complete");
    if (r.status === "complete") expect(r.reason).toBe("max-hold");
    expect(ledger).toHaveLength(1);
  });

  test("ticker failure keeps the job alive (don't blind-close)", async () => {
    const { deps, ledger } = makeDeps({ fail: true });
    const r = await processAggressiveManageTick(makeJob(), deps);
    expect(r.status).toBe("continue");
    expect(ledger).toHaveLength(0);
  });

  test("dailyState records the closed PnL", async () => {
    const dailyState = createInMemoryDailyStateStore();
    const { deps } = makeDeps({ lastPrice: 73200, dailyState });
    await processAggressiveManageTick(makeJob(), deps);
    const snap = await dailyState.getOrInitDay(500);
    expect(snap.dailyRealizedPnlUsd).toBeGreaterThan(0);
  });
});
