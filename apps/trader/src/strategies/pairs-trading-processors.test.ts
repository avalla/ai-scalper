import { describe, expect, test } from "bun:test";
import type { TraderConfig } from "../config";
import type { PairsTradingManageJobData } from "@ai-scalper/queueing";
import {
  createInMemoryPairsCacheStore,
  processPairsTradingOpenTick,
  type PairsTradingOpenProcessorDeps,
} from "./pairs-trading-open-processor";
import {
  processPairsTradingManageTick,
  type PairsTradingManageProcessorDeps,
} from "./pairs-trading-manage-processor";
import type { StrategySharedState } from "./shared/bullmq-shared-state";
import type { ClosedPositionLedgerEntry } from "../trading/position-ledger";

function makeConfig(overrides: Partial<TraderConfig> = {}): TraderConfig {
  return {
    ...({
      pairsLeg1Symbol: "BTCUSDT", pairsLeg2Symbol: "ETHUSDT",
      pairsWindowSize: 50, pairsEntryZ: 2.0, pairsExitZ: 0.3,
      pairsMaxHoldMinutes: 480,
      pairsMaxNotionalUsdPerLeg: 100,
      pairsKlineInterval: "5", pairsKlineRefreshSec: 30,
      pollMs: 5_000, paperTrading: true, feeRoundTripBps: 0,
    } as unknown as TraderConfig),
    ...overrides,
  };
}

function makeTickerSource(opts: { leg1Price?: number; leg2Price?: number } = {}): any {
  return {
    async getTicker(symbol: string) {
      const isLeg1 = symbol === "BTCUSDT";
      return { lastPrice: String(isLeg1 ? (opts.leg1Price ?? 50000) : (opts.leg2Price ?? 3000)) };
    },
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

describe("processPairsTradingOpenTick", () => {
  test("enters when injected decideFn returns enter and enqueues manage job", async () => {
    const calls: any[] = [];
    const deps: PairsTradingOpenProcessorDeps = {
      config: makeConfig({ paperTrading: true }),
      client: {
        async getKlines() { return { list: [["0", "0", "0", "0", "100", "0"]] }; },
        async getTicker(p: any) { return { lastPrice: p.symbol === "BTCUSDT" ? "50000" : "3000" }; },
        async getInstrumentInfo() { return { lotSizeFilter: { qtyStep: "0.001", minOrderQty: "0.001" } }; },
        async createOrder() {},
      } as any,
      tickerSource: makeTickerSource({ leg1Price: 50000, leg2Price: 3000 }),
      alerter: { async send() {} } as any,
      manageQueue: { async add(n: string, d: any, o: any) { calls.push({ n, d, o }); return null; } },
      sharedState: makeShared(),
      pairsCacheStore: createInMemoryPairsCacheStore(),
      decideFn: () => ({ kind: "enter", leg1Side: "long", leg2Side: "short", z: 2.5, hedgeRatio: 1.1, spread: 0.05, reason: "z=2.5" }),
      log: () => {}, now: () => 1_700_000_000_000,
    };
    const r = await processPairsTradingOpenTick({ triggeredAt: "x", configFile: "x" }, deps);
    expect(r.status).toBe("opened");
    if (r.status === "opened") {
      expect(r.leg1Symbol).toBe("BTCUSDT");
      expect(r.leg2Symbol).toBe("ETHUSDT");
      expect(r.leg1Side).toBe("long");
      expect(r.leg2Side).toBe("short");
      expect(r.entryZ).toBe(2.5);
      expect(r.hedgeRatio).toBe(1.1);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].n).toBe("pairs-trading-manage-tick");
  });

  test("compensates leg1 when leg2 placement fails (live mode)", async () => {
    let compensated = false;
    const deps: PairsTradingOpenProcessorDeps = {
      config: makeConfig({ paperTrading: false }),
      client: {
        async getKlines() { return { list: [["0", "0", "0", "0", "100", "0"]] }; },
        async getTicker(p: any) { return { lastPrice: p.symbol === "BTCUSDT" ? "50000" : "3000" }; },
        async getInstrumentInfo() { return { lotSizeFilter: { qtyStep: "0.001", minOrderQty: "0.001" } }; },
        async createOrder(args: any) {
          if (args.symbol === "ETHUSDT" && !args.reduceOnly) throw new Error("eth venue down");
          if (args.symbol === "BTCUSDT" && args.reduceOnly) { compensated = true; }
        },
      } as any,
      tickerSource: makeTickerSource({ leg1Price: 50000, leg2Price: 3000 }),
      alerter: { async send() {} } as any,
      manageQueue: { async add() { return null; } },
      sharedState: makeShared(),
      pairsCacheStore: createInMemoryPairsCacheStore(),
      decideFn: () => ({ kind: "enter", leg1Side: "long", leg2Side: "short", z: 2.5, hedgeRatio: 1, spread: 0, reason: "z=2.5" }),
      log: () => {}, now: () => 0,
    };
    const r = await processPairsTradingOpenTick({ triggeredAt: "x", configFile: "x" }, deps);
    expect(r.status).toBe("compensated");
    expect(compensated).toBe(true);
  });
});

function makeJob(overrides: Partial<PairsTradingManageJobData> = {}): PairsTradingManageJobData {
  return {
    positionId: "pairs-trading-position:1-BTCUSDT-ETHUSDT",
    leg1Symbol: "BTCUSDT", leg1Side: "long", leg1EntryPrice: 50_000, leg1Qty: 0.001,
    leg2Symbol: "ETHUSDT", leg2Side: "short", leg2EntryPrice: 3_000, leg2Qty: 0.01,
    hedgeRatio: 1, entryZ: 2.5,
    notionalPerLegUsd: 100,
    openedAt: new Date(1_700_000_000_000).toISOString(),
    decisionsHistory: [],
    lastReviewAt: new Date(1_700_000_000_000).toISOString(),
    ...overrides,
  };
}

describe("processPairsTradingManageTick", () => {
  test("hold path keeps job alive", async () => {
    const deps: PairsTradingManageProcessorDeps = {
      config: makeConfig({ paperTrading: true }),
      client: {
        async getKlines() { return { list: [] }; },
        async getTicker(p: any) { return { lastPrice: p.symbol === "BTCUSDT" ? "50000" : "3000" }; },
      } as any,
      tickerSource: makeTickerSource({ leg1Price: 50000, leg2Price: 3000 }),
      alerter: { async send() {} } as any,
      sharedState: makeShared(),
      positionLedger: { async appendClosedPosition() {} },
      pairsCacheStore: createInMemoryPairsCacheStore(),
      decideFn: () => ({ kind: "hold", reason: "waiting-convergence", z: 1.9 }),
      log: () => {}, now: () => 1_700_000_060_000,
    };
    const r = await processPairsTradingManageTick(makeJob(), deps);
    expect(r.status).toBe("continue");
    if (r.status === "continue") expect(r.updatedData.decisionsHistory.at(-1)!.action).toBe("hold");
  });

  test("exit closes both legs reduce-only + ledgers + complete", async () => {
    const entries: ClosedPositionLedgerEntry[] = [];
    const orders: any[] = [];
    const deps: PairsTradingManageProcessorDeps = {
      config: makeConfig({ paperTrading: false }),
      client: {
        async getPosition() { return { size: "0.01" }; },
        async getKlines() { return { list: [] }; },
        async getTicker(p: any) { return { lastPrice: p.symbol === "BTCUSDT" ? "50100" : "2995" }; },
        async createOrder(args: any) { orders.push(args); },
      } as any,
      tickerSource: makeTickerSource({ leg1Price: 50100, leg2Price: 2995 }),
      alerter: { async send() {} } as any,
      sharedState: makeShared(),
      positionLedger: { async appendClosedPosition(e: any) { entries.push(e); } },
      pairsCacheStore: createInMemoryPairsCacheStore(),
      decideFn: () => ({ kind: "exit", reason: "z-converged", currentZ: 0.1 }),
      log: () => {}, now: () => 1_700_000_060_000,
    };
    const r = await processPairsTradingManageTick(makeJob(), deps);
    expect(r.status).toBe("complete");
    if (r.status === "complete") expect(r.reason).toBe("z-converged");
    expect(orders).toHaveLength(2);
    expect(orders[0].reduceOnly).toBe(true);
    expect(orders[1].reduceOnly).toBe(true);
    expect(orders[0].symbol).toBe("BTCUSDT");
    expect(orders[1].symbol).toBe("ETHUSDT");
    expect(entries[0]!.strategyType).toBe("pairs-trading");
    expect(entries[0]!.pairsLeg2Symbol).toBe("ETHUSDT");
    expect(entries[0]!.pairsExitZ).toBe(0.1);
  });

  test("external close when leg1 size is 0 → complete", async () => {
    const entries: ClosedPositionLedgerEntry[] = [];
    const deps: PairsTradingManageProcessorDeps = {
      config: makeConfig({ paperTrading: false }),
      client: {
        async getPosition(p: any) { return p.symbol === "BTCUSDT" ? { size: "0" } : { size: "0.01" }; },
        async getKlines() { return { list: [] }; },
        async getTicker(p: any) { return { lastPrice: p.symbol === "BTCUSDT" ? "50000" : "3000" }; },
        async createOrder() {},
      } as any,
      tickerSource: makeTickerSource({ leg1Price: 50000, leg2Price: 3000 }),
      alerter: { async send() {} } as any,
      sharedState: makeShared(),
      positionLedger: { async appendClosedPosition(e: any) { entries.push(e); } },
      pairsCacheStore: createInMemoryPairsCacheStore(),
      log: () => {}, now: () => 1_700_000_060_000,
    };
    const r = await processPairsTradingManageTick(makeJob(), deps);
    expect(r.status).toBe("complete");
    if (r.status === "complete") expect(r.reason).toBe("external-close");
    expect(entries).toHaveLength(1);
  });
});
