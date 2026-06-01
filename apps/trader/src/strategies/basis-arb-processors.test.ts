import { describe, expect, test } from "bun:test";
import type { TraderConfig } from "../config";
import type { BasisArbManageJobData } from "@ai-scalper/queueing";
import {
  processBasisArbOpenTick,
  type BasisArbOpenProcessorDeps,
} from "./basis-arb-open-processor";
import {
  processBasisArbManageTick,
  type BasisArbManageProcessorDeps,
} from "./basis-arb-manage-processor";
import type { StrategySharedState } from "./shared/bullmq-shared-state";
import type { ClosedPositionLedgerEntry } from "../trading/position-ledger";

function makeConfig(overrides: Partial<TraderConfig> = {}): TraderConfig {
  return {
    ...({
      symbol: "BTCUSDT", pollMs: 5_000, paperTrading: false,
      feeRoundTripBps: 0,
      basisArbEntryThresholdBps: 8, basisArbExitThresholdBps: 2,
      basisArbMaxNotionalUsd: 100, basisArbMaxHoldMinutes: 240,
    } as unknown as TraderConfig),
    ...overrides,
  };
}

function makeTickerSource(opts: { perpPrice?: number; spotPrice?: number } = {}): any {
  return {
    async getTicker(_symbol: string, callOpts?: { category?: string }) {
      const isLinear = (callOpts?.category ?? "linear") === "linear";
      return {
        lastPrice: String(isLinear ? (opts.perpPrice ?? 50100) : (opts.spotPrice ?? 50000)),
        fundingRate: "0",
      };
    },
    peek() { return null; },
  };
}

function makeShared(opts: { hasActive?: boolean } = {}): StrategySharedState & { last: number } {
  let last = 0;
  return {
    last: 0,
    async hasActivePosition() { return opts.hasActive ?? false; },
    async getActivePositionCount() { return opts.hasActive ? 1 : 0; },
    async setLastCutLossAt() {}, async getLastCutLossAt() { return 0; },
    async getCooldownRemainingMs() { return 0; },
    async setLastTradeAt(n: number) { last = n; (this as any).last = n; },
    async getLastTradeAt() { return last; },
  } as any;
}

describe("processBasisArbOpenTick", () => {
  test("enters short-perp / long-spot when positive basis exceeds threshold, enqueues manage job", async () => {
    const calls: any[] = [];
    const deps: BasisArbOpenProcessorDeps = {
      config: makeConfig({ paperTrading: true }),
      client: {
        async getTicker(p: any) {
          // perp 50_100, spot 50_000 → basis ≈ +20 bps (> 8 entry threshold)
          return { lastPrice: p.category === "linear" ? "50100" : "50000", fundingRate: "0" };
        },
        async getInstrumentInfo() { return { lotSizeFilter: { qtyStep: "0.001", minOrderQty: "0.001" } }; },
        async createOrder() {},
      } as any,
      tickerSource: makeTickerSource({ perpPrice: 50100, spotPrice: 50000 }),
      alerter: { async send() {} } as any,
      manageQueue: { async add(n: string, d: any, o: any) { calls.push({ n, d, o }); return null; } },
      sharedState: makeShared(),
      log: () => {}, now: () => 1_700_000_000_000,
    };
    const r = await processBasisArbOpenTick({ triggeredAt: "x", configFile: "x" }, deps);
    expect(r.status).toBe("opened");
    if (r.status === "opened") {
      expect(r.perpSide).toBe("short");
      expect(r.spotSide).toBe("long");
      expect(r.entryBasisBps).toBeGreaterThan(8);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].n).toBe("basis-arb-manage-tick");
  });

  test("compensates leg1 when leg2 (spot) order placement fails (live mode)", async () => {
    let perpOrders = 0; let spotOrders = 0;
    let compensationReduceOnly = false;
    const calls: any[] = [];
    const deps: BasisArbOpenProcessorDeps = {
      config: makeConfig({ paperTrading: false }),
      client: {
        async getTicker(p: any) { return { lastPrice: p.category === "linear" ? "50100" : "50000", fundingRate: "0" }; },
        async getInstrumentInfo() { return { lotSizeFilter: { qtyStep: "0.001", minOrderQty: "0.001" } }; },
        async createOrder(args: any) {
          if (args.category === "linear" && !args.reduceOnly) { perpOrders += 1; return; }
          if (args.category === "linear" && args.reduceOnly) { compensationReduceOnly = true; return; }
          if (args.category === "spot") { spotOrders += 1; throw new Error("spot venue down"); }
        },
      } as any,
      tickerSource: makeTickerSource({ perpPrice: 50100, spotPrice: 50000 }),
      alerter: { async send() {} } as any,
      manageQueue: { async add(n: string, d: any, o: any) { calls.push({ n, d, o }); return null; } },
      sharedState: makeShared(),
      log: () => {}, now: () => 1_700_000_000_000,
    };
    const r = await processBasisArbOpenTick({ triggeredAt: "x", configFile: "x" }, deps);
    expect(r.status).toBe("compensated");
    if (r.status === "compensated") expect(r.reason).toBe("spot-open-failed");
    expect(perpOrders).toBe(1);
    expect(spotOrders).toBe(1);
    expect(compensationReduceOnly).toBe(true);
    expect(calls).toHaveLength(0); // no manage job enqueued
  });

  test("retries compensation up to 3x and succeeds on attempt 2", async () => {
    let perpOpenOrders = 0;
    let compAttempts = 0;
    const deps: BasisArbOpenProcessorDeps = {
      config: makeConfig({ paperTrading: false }),
      client: {
        async getTicker(p: any) { return { lastPrice: p.category === "linear" ? "50100" : "50000", fundingRate: "0" }; },
        async getInstrumentInfo() { return { lotSizeFilter: { qtyStep: "0.001", minOrderQty: "0.001" } }; },
        async createOrder(args: any) {
          if (args.category === "linear" && !args.reduceOnly) { perpOpenOrders += 1; return; }
          if (args.category === "linear" && args.reduceOnly) {
            compAttempts += 1;
            if (compAttempts < 2) throw new Error("transient venue glitch");
            return;
          }
          if (args.category === "spot") throw new Error("spot venue down");
        },
      } as any,
      tickerSource: makeTickerSource({ perpPrice: 50100, spotPrice: 50000 }),
      alerter: { async send() {} } as any,
      manageQueue: { async add() { return null; } },
      sharedState: makeShared(),
      log: () => {}, now: () => 1_700_000_000_000,
    };
    const r = await processBasisArbOpenTick({ triggeredAt: "x", configFile: "x" }, deps);
    expect(r.status).toBe("compensated");
    expect(perpOpenOrders).toBe(1);
    expect(compAttempts).toBe(2);
  });

  test("alerts CRITICAL when compensation exhausted after 3 attempts", async () => {
    let compAttempts = 0;
    const alerts: string[] = [];
    const deps: BasisArbOpenProcessorDeps = {
      config: makeConfig({ paperTrading: false }),
      client: {
        async getTicker(p: any) { return { lastPrice: p.category === "linear" ? "50100" : "50000", fundingRate: "0" }; },
        async getInstrumentInfo() { return { lotSizeFilter: { qtyStep: "0.001", minOrderQty: "0.001" } }; },
        async createOrder(args: any) {
          if (args.category === "linear" && !args.reduceOnly) return;
          if (args.category === "linear" && args.reduceOnly) {
            compAttempts += 1;
            throw new Error("venue down hard");
          }
          if (args.category === "spot") throw new Error("spot venue down");
        },
      } as any,
      tickerSource: makeTickerSource({ perpPrice: 50100, spotPrice: 50000 }),
      alerter: { async send(msg: string) { alerts.push(msg); } } as any,
      manageQueue: { async add() { return null; } },
      sharedState: makeShared(),
      log: () => {}, now: () => 1_700_000_000_000,
    };
    const r = await processBasisArbOpenTick({ triggeredAt: "x", configFile: "x" }, deps);
    expect(r.status).toBe("compensated");
    expect(compAttempts).toBe(3);
    expect(alerts.some((m) => m.includes("CRITICAL") && m.includes("EXHAUSTED"))).toBe(true);
  });

  test("skips when basis below entry threshold", async () => {
    const deps: BasisArbOpenProcessorDeps = {
      config: makeConfig({ paperTrading: true, basisArbEntryThresholdBps: 100 }),
      client: {
        async getTicker(p: any) { return { lastPrice: p.category === "linear" ? "50010" : "50000", fundingRate: "0" }; },
        async getInstrumentInfo() { return { lotSizeFilter: { qtyStep: "0.001", minOrderQty: "0.001" } }; },
        async createOrder() {},
      } as any,
      tickerSource: makeTickerSource({ perpPrice: 50010, spotPrice: 50000 }),
      alerter: { async send() {} } as any,
      manageQueue: { async add() { return null; } },
      sharedState: makeShared(),
      log: () => {}, now: () => 0,
    };
    const r = await processBasisArbOpenTick({ triggeredAt: "x", configFile: "x" }, deps);
    expect(r.status).toBe("skipped");
  });
});

function makeJob(overrides: Partial<BasisArbManageJobData> = {}): BasisArbManageJobData {
  return {
    positionId: "basis-arb-position:1-BTCUSDT",
    symbol: "BTCUSDT",
    perpSide: "short", spotSide: "long",
    perpEntryPrice: 50_100, spotEntryPrice: 50_000,
    qty: 0.01, qtyStep: "0.001", minOrderQty: "0.001",
    notionalUsd: 100,
    openedAt: new Date(1_700_000_000_000).toISOString(),
    entryBasisBps: 20, fundingRateAtEntryBps: 0,
    decisionsHistory: [],
    lastReviewAt: new Date(1_700_000_000_000).toISOString(),
    ...overrides,
  };
}

describe("processBasisArbManageTick", () => {
  test("closes both legs reduce-only on convergence", async () => {
    const entries: ClosedPositionLedgerEntry[] = [];
    const orders: Array<{ category: string; reduceOnly?: boolean }> = [];
    const deps: BasisArbManageProcessorDeps = {
      config: makeConfig({ paperTrading: false }),
      client: {
        async getPosition() { return { size: "0.01" }; },
        async getTicker(p: any) {
          // perp 50_010, spot 50_000 → basis ≈ +2 bps (== exitThreshold 2)
          return { lastPrice: p.category === "linear" ? "50010" : "50000", fundingRate: "0" };
        },
        async createOrder(args: any) { orders.push({ category: args.category, reduceOnly: args.reduceOnly }); },
      } as any,
      tickerSource: makeTickerSource({ perpPrice: 50010, spotPrice: 50000 }),
      alerter: { async send() {} } as any,
      sharedState: makeShared(),
      positionLedger: { async appendClosedPosition(e: ClosedPositionLedgerEntry) { entries.push(e); } },
      log: () => {}, now: () => 1_700_000_060_000,
    };
    const r = await processBasisArbManageTick(makeJob(), deps);
    expect(r.status).toBe("complete");
    if (r.status === "complete") expect(r.reason).toBe("basis-converged");
    expect(orders).toEqual([
      { category: "linear", reduceOnly: true },
      { category: "spot", reduceOnly: undefined },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.strategyType).toBe("basis-arb");
    expect(entries[0]!.basisEntryBps).toBe(20);
  });

  test("holds when basis still wide", async () => {
    const deps: BasisArbManageProcessorDeps = {
      config: makeConfig({ paperTrading: true }),
      client: {
        async getPosition() { return { size: "0.01" }; },
        async getTicker(p: any) { return { lastPrice: p.category === "linear" ? "50100" : "50000", fundingRate: "0" }; },
        async createOrder() {},
      } as any,
      tickerSource: makeTickerSource({ perpPrice: 50100, spotPrice: 50000 }),
      alerter: { async send() {} } as any,
      sharedState: makeShared(),
      positionLedger: { async appendClosedPosition() {} },
      log: () => {}, now: () => 1_700_000_060_000,
    };
    const r = await processBasisArbManageTick(makeJob(), deps);
    expect(r.status).toBe("continue");
  });

  test("divergence stop fires when basis widens beyond entry+stopBps (leveraged safety)", async () => {
    const entries: ClosedPositionLedgerEntry[] = [];
    // entry basis was 20 bps; current perp 50500 / spot 50000 → basis ≈ +100 bps → widened by 80
    const deps: BasisArbManageProcessorDeps = {
      config: makeConfig({ paperTrading: true, basisArbSpreadDivergenceStopBps: 30 }),
      client: {
        async getPosition() { return { size: "0.01" }; },
        async getTicker(p: any) { return { lastPrice: p.category === "linear" ? "50500" : "50000", fundingRate: "0" }; },
        async createOrder() {},
      } as any,
      tickerSource: makeTickerSource({ perpPrice: 50500, spotPrice: 50000 }),
      alerter: { async send() {} } as any,
      sharedState: makeShared(),
      positionLedger: { async appendClosedPosition(e: any) { entries.push(e); } },
      log: () => {}, now: () => 1_700_000_060_000,
    };
    const r = await processBasisArbManageTick(makeJob({ entryBasisBps: 20 }), deps);
    expect(r.status).toBe("complete");
    if (r.status === "complete") expect(r.reason).toBe("divergence-stop");
    expect(entries).toHaveLength(1);
  });

  test("divergence stop does NOT fire when stop=0 (disabled) even on wide divergence", async () => {
    const deps: BasisArbManageProcessorDeps = {
      config: makeConfig({ paperTrading: true, basisArbSpreadDivergenceStopBps: 0 }),
      client: {
        async getPosition() { return { size: "0.01" }; },
        async getTicker(p: any) { return { lastPrice: p.category === "linear" ? "50500" : "50000", fundingRate: "0" }; },
        async createOrder() {},
      } as any,
      tickerSource: makeTickerSource({ perpPrice: 50500, spotPrice: 50000 }),
      alerter: { async send() {} } as any,
      sharedState: makeShared(),
      positionLedger: { async appendClosedPosition() {} },
      log: () => {}, now: () => 1_700_000_060_000,
    };
    const r = await processBasisArbManageTick(makeJob({ entryBasisBps: 20 }), deps);
    // basis 100 bps still > exit threshold (2), still wide → hold
    expect(r.status).toBe("continue");
  });

  test("external close detected (live perp size 0) → complete + ledgered", async () => {
    const entries: ClosedPositionLedgerEntry[] = [];
    const deps: BasisArbManageProcessorDeps = {
      config: makeConfig({ paperTrading: false }),
      client: {
        async getPosition() { return { size: "0" }; },
        async getTicker(p: any) { return { lastPrice: p.category === "linear" ? "50000" : "50000", fundingRate: "0" }; },
        async createOrder() {},
      } as any,
      tickerSource: makeTickerSource({ perpPrice: 50000, spotPrice: 50000 }),
      alerter: { async send() {} } as any,
      sharedState: makeShared(),
      positionLedger: { async appendClosedPosition(e: any) { entries.push(e); } },
      log: () => {}, now: () => 1_700_000_060_000,
    };
    const r = await processBasisArbManageTick(makeJob(), deps);
    expect(r.status).toBe("complete");
    if (r.status === "complete") expect(r.reason).toBe("external-close");
    expect(entries).toHaveLength(1);
  });
});
