import { describe, expect, test } from "bun:test";
import type { TraderConfig } from "../config";
import type { LiquidationCascadeManageJobData } from "@ai-scalper/queueing";
import {
  processLiquidationCascadeManageTick,
  type LiquidationCascadeManageProcessorDeps,
  type LiquidationCascadeManageProcessorLedger,
} from "./liquidation-cascade-manage-processor";
import type { ClosedPositionLedgerEntry } from "../trading/position-ledger";
import type { StrategySharedState } from "./shared/bullmq-shared-state";

function makeConfig(overrides: Partial<TraderConfig> = {}): TraderConfig {
  const base = {
    category: "linear",
    symbol: "BTCUSDT",
    pollMs: 5_000,
    paperTrading: true,
    feeRoundTripBps: 11,
  };
  return { ...(base as unknown as TraderConfig), ...overrides };
}

function makeJobData(overrides: Partial<LiquidationCascadeManageJobData> = {}): LiquidationCascadeManageJobData {
  return {
    positionId: "liquidation-cascade-position:1700000000000-BTCUSDT",
    symbol: "BTCUSDT",
    side: "long",
    qty: 0.0002,
    qtyStep: "0.000001",
    minOrderQty: "0.000001",
    entryPrice: 50_000,
    notionalUsd: 30,
    leverage: 3,
    openedAt: new Date(1_700_000_000_000).toISOString(),
    stopLossPrice: 49_750, // 50 bps below entry
    takeProfitPrice: 50_400, // 80 bps above entry
    maxHoldSec: 60,
    decisionsHistory: [],
    lastReviewAt: new Date(1_700_000_000_000).toISOString(),
    ...overrides,
  };
}

function makeShared(): StrategySharedState & { lastTradeAt: number } {
  let last = 0;
  return {
    lastTradeAt: 0,
    async hasActivePosition() { return false; },
    async getActivePositionCount() { return 0; },
    async setLastCutLossAt() {},
    async getLastCutLossAt() { return 0; },
    async getCooldownRemainingMs() { return 0; },
    async setLastTradeAt(now: number) { last = now; (this as any).lastTradeAt = now; },
    async getLastTradeAt() { return last; },
  };
}

function makeLedger(): LiquidationCascadeManageProcessorLedger & { entries: ClosedPositionLedgerEntry[] } {
  const entries: ClosedPositionLedgerEntry[] = [];
  return {
    entries,
    async appendClosedPosition(e) { entries.push(e); },
  };
}

function makeClient(opts: { lastPrice?: number; positionSize?: number } = {}) {
  return {
    async getTicker() { return { lastPrice: String(opts.lastPrice ?? 50_000) }; },
    async getPosition() {
      return opts.positionSize !== undefined
        ? { size: String(opts.positionSize) }
        : null;
    },
    async createOrder() {},
  } as any;
}

function makeTickerSource(opts: { lastPrice?: number; fail?: boolean } = {}) {
  return {
    async getTicker() {
      if (opts.fail) throw new Error("net");
      return { lastPrice: String(opts.lastPrice ?? 50_000) } as any;
    },
    peek() { return null; },
  };
}

function makeAlerter() { return { async send() {} } as any; }

function makeDeps(overrides: Partial<LiquidationCascadeManageProcessorDeps> = {}) {
  const _ledger = makeLedger();
  const _shared = makeShared();
  const deps: LiquidationCascadeManageProcessorDeps = {
    config: makeConfig(),
    client: makeClient(),
    tickerSource: makeTickerSource(),
    alerter: makeAlerter(),
    sharedState: _shared,
    positionLedger: _ledger,
    log: () => {},
    now: () => 1_700_000_000_000 + 30_000, // 30s after open, well within window
    ...overrides,
  };
  return Object.assign(deps as any, { _ledger, _shared }) as LiquidationCascadeManageProcessorDeps & {
    _ledger: ReturnType<typeof makeLedger>;
    _shared: ReturnType<typeof makeShared>;
  };
}

describe("processLiquidationCascadeManageTick", () => {
  test("holds (continue) when no exit condition met (mid-window, no SL/TP touched)", async () => {
    const deps = makeDeps();
    const result = await processLiquidationCascadeManageTick(makeJobData(), deps);
    expect(result.status).toBe("continue");
    if (result.status === "continue") {
      expect(result.updatedData.decisionsHistory.at(-1)!.action).toBe("hold");
    }
    expect(deps._ledger.entries).toHaveLength(0);
  });

  test("completes with 'liquidation-max-hold' when held past maxHoldSec", async () => {
    const deps = makeDeps({
      now: () => 1_700_000_000_000 + 60 * 1000 + 1, // past 60s window
      client: makeClient({ lastPrice: 50_010 }),
      tickerSource: makeTickerSource({ lastPrice: 50_010 }),
    });
    const result = await processLiquidationCascadeManageTick(makeJobData(), deps);
    expect(result.status).toBe("complete");
    if (result.status === "complete") expect(result.reason).toBe("liquidation-max-hold");
    expect(deps._ledger.entries).toHaveLength(1);
    const e = deps._ledger.entries[0]!;
    expect(e.strategyType).toBe("liquidation-cascade");
    expect(e.symbol).toBe("BTCUSDT");
    expect(e.exitPrice).toBe(50_010);
    expect(deps._shared.lastTradeAt).toBeGreaterThan(0);
  });

  test("completes with 'take-profit' when price exceeds TP for a long", async () => {
    const deps = makeDeps({
      client: makeClient({ lastPrice: 50_500 }), // > TP 50_400
      tickerSource: makeTickerSource({ lastPrice: 50_500 }),
    });
    const result = await processLiquidationCascadeManageTick(makeJobData(), deps);
    expect(result.status).toBe("complete");
    if (result.status === "complete") expect(result.reason).toBe("take-profit");
    expect(deps._ledger.entries).toHaveLength(1);
    expect(deps._ledger.entries[0]!.realizedPnlUsd).toBeGreaterThan(0);
  });

  test("ticker error keeps the job alive without closing", async () => {
    const deps = makeDeps({ tickerSource: makeTickerSource({ fail: true }) });
    const result = await processLiquidationCascadeManageTick(makeJobData(), deps);
    expect(result.status).toBe("continue");
    expect(deps._ledger.entries).toHaveLength(0);
  });
});
