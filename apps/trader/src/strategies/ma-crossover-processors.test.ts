import { describe, expect, test } from "bun:test";
import type { TraderConfig } from "../config";
import type { MaCrossoverManageJobData } from "@ai-scalper/queueing";
import {
  createInMemoryPriceHistoryStore,
  processMaCrossoverOpenTick,
  type MaCrossoverOpenProcessorDeps,
} from "./ma-crossover-open-processor";
import {
  processMaCrossoverManageTick,
  type MaCrossoverManageProcessorDeps,
} from "./ma-crossover-manage-processor";
import type { StrategySharedState } from "./shared/bullmq-shared-state";
import type { ClosedPositionLedgerEntry } from "../trading/position-ledger";
import type { AllocatorStore } from "./shared/allocator-redis";
import {
  emptyAllocatorState,
  type AllocatorState,
} from "../meta/allocator";

function makeConfig(overrides: Partial<TraderConfig> = {}): TraderConfig {
  return {
    ...({
      symbol: "BTCUSDT", category: "linear",
      leverage: 5, orderUsd: 100,
      fastWindow: 3, slowWindow: 5, thresholdBps: 0,
      stopLossBps: 50, takeProfitBps: 100,
      maxPositionUsd: 1_000, maxDailyLossUsd: 100,
      maxSpreadBps: 20, minTradeIntervalMs: 0,
      pollMs: 5_000, paperTrading: true, feeRoundTripBps: 0,
      metaWarmupMinTrades: 5,
      metaIncludeAggressiveVariants: false,
      bandit_halfLifeDays: 0,
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

function makeAllocatorStore(): AllocatorStore & { state: AllocatorState | null } {
  const holder: { state: AllocatorState | null } = { state: null };
  return {
    get state() { return holder.state; },
    set state(v: AllocatorState | null) { holder.state = v; },
    async load() { return holder.state; },
    async save(s: AllocatorState) { holder.state = s; },
  } as any;
}

describe("processMaCrossoverOpenTick", () => {
  test("skips when active position exists", async () => {
    const deps: MaCrossoverOpenProcessorDeps = {
      config: makeConfig(), client: {} as any, alerter: { async send() {} } as any,
      manageQueue: { async add() { return null; } },
      sharedState: makeShared({ hasActive: true }),
      allocatorStore: makeAllocatorStore(),
      priceHistoryStore: createInMemoryPriceHistoryStore(),
      log: () => {}, now: () => 0,
    };
    const r = await processMaCrossoverOpenTick({ triggeredAt: "x", configFile: "x" }, deps);
    expect(r.status).toBe("skipped");
  });

  test("selects champion + opens with champion params; stores championIdAtEntry on manage job", async () => {
    const calls: any[] = [];
    const priceHistory = createInMemoryPriceHistoryStore();
    // Seed price history above slowWindow so signal can fire.
    for (let i = 0; i < 30; i += 1) {
      priceHistory.push("BTCUSDT", 100, 100);
    }
    const deps: MaCrossoverOpenProcessorDeps = {
      config: makeConfig(),
      client: {
        async getTicker() { return { lastPrice: "100" }; },
        async getInstrumentInfo() { return { lotSizeFilter: { qtyStep: "0.001", minOrderQty: "0.001" } }; },
        async setLeverage() {}, async createOrder() {},
      } as any,
      alerter: { async send() {} } as any,
      manageQueue: { async add(n: string, d: any, o: any) { calls.push({ n, d, o }); return null; } },
      sharedState: makeShared(),
      allocatorStore: makeAllocatorStore(),
      priceHistoryStore: priceHistory,
      // Force a deterministic signal + a known champion id.
      variantPoolFn: () => [{
        id: "test-variant", label: "test",
        params: { fastWindow: 3, slowWindow: 5, thresholdBps: 0, stopLossBps: 50, takeProfitBps: 100,
          orderUsd: 100, leverage: 5, maxPositionUsd: 1000, maxDailyLossUsd: 100, maxSpreadBps: 20, minTradeIntervalMs: 0 },
      }],
      selectChampionFn: ({ allocator }) => ({ championId: "test-variant", reason: "single-variant", allocator }),
      buildSignalFn: () => "long",
      log: () => {}, now: () => 1_700_000_000_000,
    };
    const r = await processMaCrossoverOpenTick({ triggeredAt: "x", configFile: "x" }, deps);
    expect(r.status).toBe("opened");
    if (r.status === "opened") {
      expect(r.side).toBe("long");
      expect(r.championIdAtEntry).toBe("test-variant");
      expect(r.stopLossPrice).toBeLessThan(r.entryPrice);
      expect(r.takeProfitPrice).toBeGreaterThan(r.entryPrice);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].n).toBe("ma-crossover-manage-tick");
    expect(calls[0].d.championIdAtEntry).toBe("test-variant");
    expect(calls[0].d.championParams).toEqual({
      fastWindow: 3, slowWindow: 5, thresholdBps: 0, stopLossBps: 50, takeProfitBps: 100,
    });
  });

  test("skips when champion has symbolFilter that excludes the configured symbol", async () => {
    const deps: MaCrossoverOpenProcessorDeps = {
      config: makeConfig({ symbol: "ETHUSDT" }),
      client: {} as any,
      alerter: { async send() {} } as any,
      manageQueue: { async add() { return null; } },
      sharedState: makeShared(),
      allocatorStore: makeAllocatorStore(),
      priceHistoryStore: createInMemoryPriceHistoryStore(),
      variantPoolFn: () => [{
        id: "btc-only", label: "btc-only",
        params: { fastWindow: 3, slowWindow: 5, thresholdBps: 0, stopLossBps: 50, takeProfitBps: 100,
          orderUsd: 100, leverage: 5, maxPositionUsd: 1000, maxDailyLossUsd: 100, maxSpreadBps: 20, minTradeIntervalMs: 0 },
        symbolFilter: ["BTCUSDT"],
      }],
      selectChampionFn: ({ allocator }) => ({ championId: "btc-only", reason: "single-variant", allocator }),
      log: () => {}, now: () => 0,
    };
    const r = await processMaCrossoverOpenTick({ triggeredAt: "x", configFile: "x" }, deps);
    expect(r.status).toBe("skipped");
    if (r.status === "skipped") expect(r.reason).toContain("champion-symbol-filtered");
  });
});

function makeJob(overrides: Partial<MaCrossoverManageJobData> = {}): MaCrossoverManageJobData {
  return {
    positionId: "ma-crossover-position:1-BTCUSDT",
    symbol: "BTCUSDT", side: "long",
    entryPrice: 100, qty: 1, qtyStep: "0.001", minOrderQty: "0.001",
    notionalUsd: 100, leverage: 5,
    openedAt: new Date(1).toISOString(),
    championIdAtEntry: "test-variant",
    championParams: { fastWindow: 3, slowWindow: 5, thresholdBps: 0, stopLossBps: 50, takeProfitBps: 100 },
    stopLossPrice: 99, takeProfitPrice: 102,
    entryReasoning: "test",
    decisionsHistory: [],
    lastReviewAt: new Date(1).toISOString(),
    ...overrides,
  };
}

describe("processMaCrossoverManageTick", () => {
  test("on TP hit: closes, ledgers championIdAtEntry, updates allocator via recordClosedTrade", async () => {
    const entries: ClosedPositionLedgerEntry[] = [];
    const store = makeAllocatorStore();
    await store.save(emptyAllocatorState());
    const deps: MaCrossoverManageProcessorDeps = {
      config: makeConfig({ paperTrading: false, feeRoundTripBps: 0 }),
      client: {
        async getPosition() { return { size: "1" }; },
        async getTicker() { return { lastPrice: "102" }; },
        async createOrder() {},
      } as any,
      alerter: { async send() {} } as any,
      sharedState: makeShared(),
      positionLedger: { async appendClosedPosition(e: any) { entries.push(e); } },
      allocatorStore: store,
      log: () => {}, now: () => 5,
    };
    const r = await processMaCrossoverManageTick(makeJob(), deps);
    expect(r.status).toBe("complete");
    if (r.status === "complete") expect(r.reason).toBe("take-profit");
    expect(entries[0]!.strategyType).toBe("ma-crossover");
    expect(entries[0]!.championIdAtEntry).toBe("test-variant");
    // Allocator should now have a closedTrades=1 entry for the champion.
    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.stats["test-variant"]!.closedTrades).toBe(1);
    expect(loaded!.stats["test-variant"]!.realizedPnlUsd).toBe(2); // (102-100)*1
  });

  test("hold path keeps job alive without touching allocator", async () => {
    const store = makeAllocatorStore();
    await store.save(emptyAllocatorState());
    const deps: MaCrossoverManageProcessorDeps = {
      config: makeConfig({ paperTrading: true }),
      client: {
        async getPosition() { return { size: "1" }; },
        async getTicker() { return { lastPrice: "100.5" }; },
      } as any,
      alerter: { async send() {} } as any,
      sharedState: makeShared(),
      positionLedger: { async appendClosedPosition() {} },
      allocatorStore: store,
      log: () => {}, now: () => 5,
    };
    const r = await processMaCrossoverManageTick(makeJob(), deps);
    expect(r.status).toBe("continue");
    const loaded = await store.load();
    expect(loaded!.stats["test-variant"]).toBeUndefined();
  });
});
