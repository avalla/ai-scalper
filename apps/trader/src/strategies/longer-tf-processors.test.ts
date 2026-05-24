import { describe, expect, test } from "bun:test";
import type { TraderConfig } from "../config";
import type { LongerTfManageJobData } from "@ai-scalper/queueing";
import {
  createInMemoryKlineCacheStore,
  processLongerTfOpenTick,
  type LongerTfOpenProcessorDeps,
} from "./longer-tf-open-processor";
import {
  processLongerTfManageTick,
  type LongerTfManageProcessorDeps,
} from "./longer-tf-manage-processor";
import type { StrategySharedState } from "./shared/bullmq-shared-state";
import type { ClosedPositionLedgerEntry } from "../trading/position-ledger";

function makeConfig(overrides: Partial<TraderConfig> = {}): TraderConfig {
  return {
    ...({
      symbol: "BTCUSDT",
      leverage: 5,
      orderUsd: 100,
      pollMs: 5_000,
      paperTrading: true,
      feeRoundTripBps: 0,
      longerTfKlineInterval: "15",
      longerTfKlineRefreshSec: 60,
      longerTfFastWindow: 3,
      longerTfSlowWindow: 5,
      longerTfThresholdBps: 0,
      longerTfStopLossBps: 50,
      longerTfTakeProfitBps: 150,
    } as unknown as TraderConfig),
    ...overrides,
  };
}

function makeShared(opts: { hasActive?: boolean } = {}): StrategySharedState {
  return {
    async hasActivePosition() { return opts.hasActive ?? false; },
    async getActivePositionCount() { return opts.hasActive ? 1 : 0; },
    async setLastCutLossAt() {}, async getLastCutLossAt() { return 0; },
    async getCooldownRemainingMs() { return 0; },
    async setLastTradeAt() {}, async getLastTradeAt() { return 0; },
  };
}

describe("processLongerTfOpenTick", () => {
  test("skips when active position exists", async () => {
    const calls: any[] = [];
    const deps: LongerTfOpenProcessorDeps = {
      config: makeConfig(),
      client: {} as any,
      alerter: { async send() {} } as any,
      manageQueue: { async add(n: string, d: any, o: any) { calls.push({ n, d, o }); return null; } },
      sharedState: makeShared({ hasActive: true }),
      klineCacheStore: createInMemoryKlineCacheStore(),
      log: () => {}, now: () => 0,
    };
    const r = await processLongerTfOpenTick({ triggeredAt: "x", configFile: "x" }, deps);
    expect(r.status).toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  test("on first call, fetches klines, computes signal, enqueues manage job when crossover fires", async () => {
    const calls: any[] = [];
    // Build oldest-first ascending closes (will trigger long crossover).
    // klines come from Bybit newest-first as string rows of [time, open, high, low, close, volume, ...]
    const closesOldFirst = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115];
    const newestFirst = closesOldFirst.slice().reverse().map((c) => ["0", "0", "0", "0", String(c), "0"]);
    const client: any = {
      async getKlines() { return { list: newestFirst }; },
      async getTicker() { return { lastPrice: "115" }; },
      async getInstrumentInfo() { return { lotSizeFilter: { qtyStep: "0.001", minOrderQty: "0.001" } }; },
      async setLeverage() {}, async createOrder() {},
    };
    const deps: LongerTfOpenProcessorDeps = {
      config: makeConfig(),
      client, alerter: { async send() {} } as any,
      manageQueue: { async add(n: string, d: any, o: any) { calls.push({ n, d, o }); return null; } },
      sharedState: makeShared(),
      klineCacheStore: createInMemoryKlineCacheStore(),
      log: () => {}, now: () => 1_700_000_000_000,
    };
    const r = await processLongerTfOpenTick({ triggeredAt: "x", configFile: "x" }, deps);
    expect(r.status).toBe("opened");
    if (r.status === "opened") {
      expect(r.side).toBe("long");
      expect(r.symbol).toBe("BTCUSDT");
      expect(r.stopLossPrice).toBeLessThan(r.entryPrice);
      expect(r.takeProfitPrice).toBeGreaterThan(r.entryPrice);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].n).toBe("longer-tf:manage-tick");
  });

  test("skips when kline fetch fails", async () => {
    const client: any = { async getKlines() { throw new Error("net"); } };
    const deps: LongerTfOpenProcessorDeps = {
      config: makeConfig(),
      client, alerter: { async send() {} } as any,
      manageQueue: { async add() { return null; } },
      sharedState: makeShared(),
      klineCacheStore: createInMemoryKlineCacheStore(),
      log: () => {}, now: () => 0,
    };
    const r = await processLongerTfOpenTick({ triggeredAt: "x", configFile: "x" }, deps);
    expect(r.status).toBe("skipped");
    if (r.status === "skipped") expect(r.reason).toBe("kline-refresh-failed");
  });
});

function makeJob(overrides: Partial<LongerTfManageJobData> = {}): LongerTfManageJobData {
  return {
    positionId: "longer-tf-position:1-BTCUSDT",
    symbol: "BTCUSDT", side: "long",
    entryPrice: 100,
    qty: 1, qtyStep: "0.001", minOrderQty: "0.001",
    notionalUsd: 100, leverage: 1,
    openedAt: new Date(1).toISOString(),
    stopLossPrice: 99,
    takeProfitPrice: 101,
    entryReasoning: "long",
    decisionsHistory: [],
    lastReviewAt: new Date(1).toISOString(),
    ...overrides,
  };
}

describe("processLongerTfManageTick", () => {
  test("holds when price strictly between SL and TP", async () => {
    const entries: ClosedPositionLedgerEntry[] = [];
    const deps: LongerTfManageProcessorDeps = {
      config: makeConfig(),
      client: {
        async getPosition() { return { size: "1" }; },
        async getTicker() { return { lastPrice: "100.5" }; },
      } as any,
      alerter: { async send() {} } as any,
      sharedState: makeShared(),
      positionLedger: { async appendClosedPosition(e: ClosedPositionLedgerEntry) { entries.push(e); } },
      log: () => {}, now: () => 5,
    };
    const r = await processLongerTfManageTick(makeJob(), deps);
    expect(r.status).toBe("continue");
    expect(entries).toHaveLength(0);
  });

  test("take-profit hit (long): closes + ledgers + complete", async () => {
    const entries: ClosedPositionLedgerEntry[] = [];
    const deps: LongerTfManageProcessorDeps = {
      config: makeConfig({ feeRoundTripBps: 0 }),
      client: {
        async getPosition() { return { size: "1" }; },
        async getTicker() { return { lastPrice: "101" }; },
        async createOrder() {},
      } as any,
      alerter: { async send() {} } as any,
      sharedState: makeShared(),
      positionLedger: { async appendClosedPosition(e: ClosedPositionLedgerEntry) { entries.push(e); } },
      log: () => {}, now: () => 5,
    };
    const r = await processLongerTfManageTick(makeJob(), deps);
    expect(r.status).toBe("complete");
    if (r.status === "complete") expect(r.reason).toBe("take-profit");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.realizedPnlUsd).toBe(1);
    expect(entries[0]!.strategyType).toBe("longer-tf");
  });

  test("stop-loss hit (short): closes with negative pnl", async () => {
    const entries: ClosedPositionLedgerEntry[] = [];
    const deps: LongerTfManageProcessorDeps = {
      config: makeConfig({ feeRoundTripBps: 0 }),
      client: {
        async getPosition() { return { size: "1" }; },
        async getTicker() { return { lastPrice: "101" }; },
        async createOrder() {},
      } as any,
      alerter: { async send() {} } as any,
      sharedState: makeShared(),
      positionLedger: { async appendClosedPosition(e: ClosedPositionLedgerEntry) { entries.push(e); } },
      log: () => {}, now: () => 5,
    };
    const r = await processLongerTfManageTick(makeJob({ side: "short", stopLossPrice: 101, takeProfitPrice: 99 }), deps);
    expect(r.status).toBe("complete");
    if (r.status === "complete") expect(r.reason).toBe("stop-loss");
    expect(entries[0]!.realizedPnlUsd).toBeLessThan(0);
  });
});
