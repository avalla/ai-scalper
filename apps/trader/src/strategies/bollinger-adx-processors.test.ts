import { describe, expect, test } from "bun:test";
import type { TraderConfig } from "../config";
import type { BollingerAdxManageJobData } from "@ai-scalper/queueing";
import {
  createInMemoryBollingerAdxKlineCacheStore,
  processBollingerAdxOpenTick,
  type BollingerAdxOpenProcessorDeps,
} from "./bollinger-adx-open-processor";
import {
  processBollingerAdxManageTick,
  type BollingerAdxManageProcessorDeps,
} from "./bollinger-adx-manage-processor";
import type { StrategySharedState } from "./shared/bullmq-shared-state";
import type { ClosedPositionLedgerEntry } from "../trading/position-ledger";

function makeConfig(overrides: Partial<TraderConfig> = {}): TraderConfig {
  return {
    ...({
      symbol: "BTCUSDT", leverage: 5, orderUsd: 100, pollMs: 5_000,
      paperTrading: true, feeRoundTripBps: 0,
      bollingerAdxBbPeriod: 20, bollingerAdxBbStdDev: 2,
      bollingerAdxAdxPeriod: 14,
      bollingerAdxAdxRangingThreshold: 20,
      bollingerAdxAdxTrendingThreshold: 25,
      bollingerAdxStopLossBps: 80, bollingerAdxTakeProfitBps: 150,
      bollingerAdxKlineInterval: "15", bollingerAdxKlineRefreshSec: 60,
    } as unknown as TraderConfig),
    ...overrides,
  };
}

function makeTickerSource(opts: { lastPrice?: number } = {}): any {
  return {
    async getTicker() { return { lastPrice: String(opts.lastPrice ?? 100) }; },
    peek() { return null; },
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

describe("processBollingerAdxOpenTick", () => {
  test("skips when active position exists", async () => {
    const deps: BollingerAdxOpenProcessorDeps = {
      config: makeConfig(), client: {} as any,
      tickerSource: makeTickerSource(),
      alerter: { async send() {} } as any,
      manageQueue: { async add() { return null; } },
      sharedState: makeShared({ hasActive: true }),
      klineCacheStore: createInMemoryBollingerAdxKlineCacheStore(),
      log: () => {}, now: () => 0,
    };
    const r = await processBollingerAdxOpenTick({ triggeredAt: "x", configFile: "x" }, deps);
    expect(r.status).toBe("skipped");
  });

  test("forces enter via injected decideFn and enqueues a manage job", async () => {
    const calls: any[] = [];
    const deps: BollingerAdxOpenProcessorDeps = {
      config: makeConfig(),
      client: {
        async getTicker() { return { lastPrice: "100" }; },
        async getKlines() { return { list: [["0", "0", "100", "100", "100", "0"]] }; },
        async getInstrumentInfo() { return { lotSizeFilter: { qtyStep: "0.001", minOrderQty: "0.001" } }; },
        async setLeverage() {}, async createOrder() {},
      } as any,
      tickerSource: makeTickerSource({ lastPrice: 100 }),
      alerter: { async send() {} } as any,
      manageQueue: { async add(n: string, d: any, o: any) { calls.push({ n, d, o }); return null; } },
      sharedState: makeShared(),
      klineCacheStore: createInMemoryBollingerAdxKlineCacheStore(),
      decideFn: () => ({ kind: "enter", side: "long", regime: "ranging", reason: "bb-low-touch:adx=15.0" }),
      log: () => {}, now: () => 1_700_000_000_000,
    };
    const r = await processBollingerAdxOpenTick({ triggeredAt: "x", configFile: "x" }, deps);
    expect(r.status).toBe("opened");
    if (r.status === "opened") {
      expect(r.regime).toBe("ranging");
      expect(r.stopLossPrice).toBeLessThan(r.entryPrice);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].n).toBe("bollinger-adx-manage-tick");
  });

  test("skips when injected decideFn returns hold (no enter)", async () => {
    const deps: BollingerAdxOpenProcessorDeps = {
      config: makeConfig(),
      client: {
        async getTicker() { return { lastPrice: "100" }; },
        async getKlines() { return { list: [["0", "0", "100", "100", "100", "0"]] }; },
      } as any,
      tickerSource: makeTickerSource({ lastPrice: 100 }),
      alerter: { async send() {} } as any,
      manageQueue: { async add() { return null; } },
      sharedState: makeShared(),
      klineCacheStore: createInMemoryBollingerAdxKlineCacheStore(),
      decideFn: () => ({ kind: "hold", reason: "warmup", regime: "unknown" }),
      log: () => {}, now: () => 0,
    };
    const r = await processBollingerAdxOpenTick({ triggeredAt: "x", configFile: "x" }, deps);
    expect(r.status).toBe("skipped");
    if (r.status === "skipped") expect(r.reason).toContain("decide-hold");
  });
});

function makeJob(overrides: Partial<BollingerAdxManageJobData> = {}): BollingerAdxManageJobData {
  return {
    positionId: "bollinger-adx-position:1-BTCUSDT",
    symbol: "BTCUSDT", side: "long",
    entryPrice: 100, qty: 1, qtyStep: "0.001", minOrderQty: "0.001",
    notionalUsd: 100, leverage: 1,
    openedAt: new Date(1).toISOString(),
    stopLossPrice: 99, takeProfitPrice: 101.5,
    entryRegime: "ranging", entryReasoning: "test",
    decisionsHistory: [],
    lastReviewAt: new Date(1).toISOString(),
    ...overrides,
  };
}

describe("processBollingerAdxManageTick", () => {
  test("holds when price between SL and TP", async () => {
    const entries: ClosedPositionLedgerEntry[] = [];
    const deps: BollingerAdxManageProcessorDeps = {
      config: makeConfig(),
      client: {
        async getPosition() { return { size: "1" }; },
        async getTicker() { return { lastPrice: "100.5" }; },
      } as any,
      tickerSource: makeTickerSource({ lastPrice: 100.5 }),
      alerter: { async send() {} } as any,
      sharedState: makeShared(),
      positionLedger: { async appendClosedPosition(e: any) { entries.push(e); } },
      log: () => {}, now: () => 5,
    };
    const r = await processBollingerAdxManageTick(makeJob(), deps);
    expect(r.status).toBe("continue");
    expect(entries).toHaveLength(0);
  });

  test("take-profit on long closes + ledgers + completes", async () => {
    const entries: ClosedPositionLedgerEntry[] = [];
    const deps: BollingerAdxManageProcessorDeps = {
      config: makeConfig({ feeRoundTripBps: 0 }),
      client: {
        async getPosition() { return { size: "1" }; },
        async getTicker() { return { lastPrice: "102" }; },
        async createOrder() {},
      } as any,
      tickerSource: makeTickerSource({ lastPrice: 102 }),
      alerter: { async send() {} } as any,
      sharedState: makeShared(),
      positionLedger: { async appendClosedPosition(e: any) { entries.push(e); } },
      log: () => {}, now: () => 5,
    };
    const r = await processBollingerAdxManageTick(makeJob(), deps);
    expect(r.status).toBe("complete");
    if (r.status === "complete") expect(r.reason).toBe("take-profit");
    expect(entries[0]!.strategyType).toBe("bollinger-adx");
    expect(entries[0]!.realizedPnlUsd).toBe(2);
  });
});
