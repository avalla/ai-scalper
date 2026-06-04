import { describe, expect, test } from "bun:test";
import type { TraderConfig } from "../config";
import type { CalendarSpreadManageJobData } from "@ai-scalper/queueing";
import {
  processCalendarSpreadOpenTick,
  type CalendarSpreadOpenProcessorDeps,
} from "./calendar-spread-open-processor";
import {
  processCalendarSpreadManageTick,
  type CalendarSpreadManageProcessorDeps,
} from "./calendar-spread-manage-processor";
import type { StrategySharedState } from "./shared/bullmq-shared-state";
import type { ClosedPositionLedgerEntry } from "../trading/position-ledger";

const DELIVERY_AT = Date.now() + 30 * 24 * 3_600_000; // 30 days out

function makeConfig(overrides: Partial<TraderConfig> = {}): TraderConfig {
  return {
    ...({
      calendarPerpSymbol: "BTCUSDT", calendarDatedSymbol: "BTC-26SEP25",
      calendarDatedDeliveryAt: DELIVERY_AT,
      calendarEntryThresholdBps: 30, calendarExitThresholdBps: 5,
      calendarPreSettlementCloseHours: 24,
      calendarMaxNotionalUsdPerLeg: 200,
      calendarPollSec: 60,
      pollMs: 5_000, paperTrading: true, feeRoundTripBps: 0,
    } as unknown as TraderConfig),
    ...overrides,
  };
}

function makeTickerSource(opts: { perpPrice?: number; datedPrice?: number } = {}): any {
  return {
    async getTicker(symbol: string) {
      const isPerp = symbol === "BTCUSDT";
      return { lastPrice: String(isPerp ? (opts.perpPrice ?? 50000) : (opts.datedPrice ?? 50300)) };
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

describe("processCalendarSpreadOpenTick", () => {
  test("skips when dated symbol not configured", async () => {
    const deps: CalendarSpreadOpenProcessorDeps = {
      config: makeConfig({ calendarDatedSymbol: "", calendarDatedDeliveryAt: 0 }),
      client: {} as any, tickerSource: makeTickerSource(),
      alerter: { async send() {} } as any,
      manageQueue: { async add() { return null; } },
      sharedState: makeShared(),
      log: () => {}, now: () => 0,
    };
    const r = await processCalendarSpreadOpenTick({ triggeredAt: "x", configFile: "x" }, deps);
    expect(r.status).toBe("skipped");
    if (r.status === "skipped") expect(r.reason).toBe("dated-symbol-or-delivery-not-configured");
  });

  test("enters perp-long/dated-short when dated rich (positive spread > threshold)", async () => {
    const calls: any[] = [];
    const deps: CalendarSpreadOpenProcessorDeps = {
      config: makeConfig({ paperTrading: true }),
      client: {
        async getTicker(p: any) {
          // perp 50_000, dated 50_300 → spread = +60 bps (> 30 threshold)
          return { lastPrice: p.symbol === "BTCUSDT" ? "50000" : "50300" };
        },
        async getInstrumentInfo() { return { lotSizeFilter: { qtyStep: "0.001", minOrderQty: "0.001" } }; },
        async createOrder() {},
      } as any,
      tickerSource: makeTickerSource({ perpPrice: 50000, datedPrice: 50300 }),
      alerter: { async send() {} } as any,
      manageQueue: { async add(n: string, d: any, o: any) { calls.push({ n, d, o }); return null; } },
      sharedState: makeShared(),
      log: () => {}, now: () => Date.now(),
    };
    const r = await processCalendarSpreadOpenTick({ triggeredAt: "x", configFile: "x" }, deps);
    expect(r.status).toBe("opened");
    if (r.status === "opened") {
      expect(r.perpSide).toBe("long");
      expect(r.datedSide).toBe("short");
      expect(r.entrySpreadBps).toBeGreaterThan(30);
    }
    expect(calls).toHaveLength(1);
  });

  test("compensates perp leg when dated open fails (live mode)", async () => {
    let compensated = false;
    const deps: CalendarSpreadOpenProcessorDeps = {
      config: makeConfig({ paperTrading: false }),
      client: {
        async getTicker(p: any) { return { lastPrice: p.symbol === "BTCUSDT" ? "50000" : "50300" }; },
        async getInstrumentInfo() { return { lotSizeFilter: { qtyStep: "0.001", minOrderQty: "0.001" } }; },
        async createOrder(args: any) {
          if (args.symbol.startsWith("BTC-") && !args.reduceOnly) throw new Error("dated venue down");
          if (args.symbol === "BTCUSDT" && args.reduceOnly) { compensated = true; }
        },
      } as any,
      tickerSource: makeTickerSource({ perpPrice: 50000, datedPrice: 50300 }),
      alerter: { async send() {} } as any,
      manageQueue: { async add() { return null; } },
      sharedState: makeShared(),
      log: () => {}, now: () => Date.now(),
    };
    const r = await processCalendarSpreadOpenTick({ triggeredAt: "x", configFile: "x" }, deps);
    expect(r.status).toBe("compensated");
    expect(compensated).toBe(true);
  });
});

function makeJob(overrides: Partial<CalendarSpreadManageJobData> = {}): CalendarSpreadManageJobData {
  return {
    positionId: "calendar-spread-position:1-BTCUSDT-BTC26SEP25",
    perpSymbol: "BTCUSDT", datedSymbol: "BTC-26SEP25",
    perpSide: "long", datedSide: "short",
    perpEntryPrice: 50_000, datedEntryPrice: 50_300,
    qty: 0.001, qtyStep: "0.001", minOrderQty: "0.001",
    notionalPerLegUsd: 200,
    openedAt: new Date(Date.now() - 60_000).toISOString(),
    entrySpreadBps: 60,
    datedDeliveryAt: DELIVERY_AT,
    decisionsHistory: [],
    lastReviewAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("processCalendarSpreadManageTick", () => {
  test("exits both legs reduce-only on convergence", async () => {
    const entries: ClosedPositionLedgerEntry[] = [];
    const orders: any[] = [];
    const deps: CalendarSpreadManageProcessorDeps = {
      config: makeConfig({ paperTrading: false }),
      client: {
        async getPosition() { return { size: "0.001" }; },
        async getTicker(p: any) {
          // perp 50_000, dated 50_010 → spread = ~2 bps (≤ exit threshold 5)
          return { lastPrice: p.symbol === "BTCUSDT" ? "50000" : "50010" };
        },
        async createOrder(args: any) { orders.push(args); },
      } as any,
      tickerSource: makeTickerSource({ perpPrice: 50000, datedPrice: 50010 }),
      alerter: { async send() {} } as any,
      sharedState: makeShared(),
      positionLedger: { async appendClosedPosition(e: any) { entries.push(e); } },
      log: () => {}, now: () => Date.now(),
    };
    const r = await processCalendarSpreadManageTick(makeJob(), deps);
    expect(r.status).toBe("complete");
    if (r.status === "complete") expect(r.reason).toBe("spread-converged");
    expect(orders).toHaveLength(2);
    expect(orders[0].reduceOnly).toBe(true);
    expect(orders[1].reduceOnly).toBe(true);
    expect(entries[0]!.strategyType).toBe("calendar-spread");
    expect(entries[0]!.calendarDatedSymbol).toBe("BTC-26SEP25");
  });

  test("divergence stop fires when spread widens beyond entry+stopBps (leveraged safety)", async () => {
    // entry spread 60 bps; current perp 50000 / dated 50800 → spread ~+160 bps → widened by 100
    const entries: ClosedPositionLedgerEntry[] = [];
    const deps: CalendarSpreadManageProcessorDeps = {
      config: makeConfig({ paperTrading: true, calendarSpreadDivergenceStopBps: 50 }),
      client: {
        async getPosition() { return { size: "0.001" }; },
        async getTicker(p: any) { return { lastPrice: p.symbol === "BTCUSDT" ? "50000" : "50800" }; },
        async createOrder() {},
      } as any,
      tickerSource: makeTickerSource({ perpPrice: 50000, datedPrice: 50800 }),
      alerter: { async send() {} } as any,
      sharedState: makeShared(),
      positionLedger: { async appendClosedPosition(e: any) { entries.push(e); } },
      log: () => {}, now: () => Date.now(),
    };
    const r = await processCalendarSpreadManageTick(makeJob({ entrySpreadBps: 60 }), deps);
    expect(r.status).toBe("complete");
    if (r.status === "complete") expect(r.reason).toBe("divergence-stop");
    expect(entries).toHaveLength(1);
  });

  test("pin-risk-loss-suspect fires when loss closes within 48h of settlement", async () => {
    // dated delivers 24h from now; divergence-stop forces a loss
    const NEAR_DELIVERY = Date.now() + 24 * 3_600_000;
    const events: any[] = [];
    const deps: CalendarSpreadManageProcessorDeps = {
      config: makeConfig({ paperTrading: true, calendarSpreadDivergenceStopBps: 50 }),
      client: {
        async getPosition() { return { size: "0.001" }; },
        async getTicker(p: any) { return { lastPrice: p.symbol === "BTCUSDT" ? "50000" : "50800" }; },
        async createOrder() {},
      } as any,
      tickerSource: makeTickerSource({ perpPrice: 50000, datedPrice: 50800 }),
      alerter: { async send() {} } as any,
      sharedState: makeShared(),
      positionLedger: { async appendClosedPosition() {} },
      log: (p: any) => events.push(p), now: () => Date.now(),
    };
    await processCalendarSpreadManageTick(makeJob({ entrySpreadBps: 60, datedDeliveryAt: NEAR_DELIVERY }), deps);
    const flag = events.find((e) => e.event === "pin-risk-loss-suspect");
    expect(flag).toBeDefined();
    expect(flag.hoursToSettlement).toBeLessThan(48);
    expect(flag.netPnl).toBeLessThan(0);
  });

  test("pin-risk-loss-suspect does NOT fire when settlement is far (>48h)", async () => {
    const FAR_DELIVERY = Date.now() + 30 * 24 * 3_600_000;
    const events: any[] = [];
    const deps: CalendarSpreadManageProcessorDeps = {
      config: makeConfig({ paperTrading: true, calendarSpreadDivergenceStopBps: 50 }),
      client: {
        async getPosition() { return { size: "0.001" }; },
        async getTicker(p: any) { return { lastPrice: p.symbol === "BTCUSDT" ? "50000" : "50800" }; },
        async createOrder() {},
      } as any,
      tickerSource: makeTickerSource({ perpPrice: 50000, datedPrice: 50800 }),
      alerter: { async send() {} } as any,
      sharedState: makeShared(),
      positionLedger: { async appendClosedPosition() {} },
      log: (p: any) => events.push(p), now: () => Date.now(),
    };
    await processCalendarSpreadManageTick(makeJob({ entrySpreadBps: 60, datedDeliveryAt: FAR_DELIVERY }), deps);
    expect(events.find((e) => e.event === "pin-risk-loss-suspect")).toBeUndefined();
  });

  test("pin-risk-loss-suspect does NOT fire on a WIN close near settlement", async () => {
    const NEAR_DELIVERY = Date.now() + 24 * 3_600_000;
    const events: any[] = [];
    const deps: CalendarSpreadManageProcessorDeps = {
      config: makeConfig({ paperTrading: true }),
      client: {
        async getPosition() { return { size: "0.001" }; },
        async getTicker(p: any) { return { lastPrice: p.symbol === "BTCUSDT" ? "50000" : "50010" }; },
        async createOrder() {},
      } as any,
      tickerSource: makeTickerSource({ perpPrice: 50000, datedPrice: 50010 }),
      alerter: { async send() {} } as any,
      sharedState: makeShared(),
      positionLedger: { async appendClosedPosition() {} },
      log: (p: any) => events.push(p), now: () => Date.now(),
    };
    await processCalendarSpreadManageTick(makeJob({ entrySpreadBps: 60, datedDeliveryAt: NEAR_DELIVERY }), deps);
    expect(events.find((e) => e.event === "pin-risk-loss-suspect")).toBeUndefined();
  });

  test("external close detected when either leg vanishes", async () => {
    const entries: ClosedPositionLedgerEntry[] = [];
    const deps: CalendarSpreadManageProcessorDeps = {
      config: makeConfig({ paperTrading: false }),
      client: {
        async getPosition(p: any) { return p.symbol === "BTCUSDT" ? { size: "0.001" } : { size: "0" }; },
        async getTicker(p: any) { return { lastPrice: p.symbol === "BTCUSDT" ? "50000" : "50000" }; },
        async createOrder() {},
      } as any,
      tickerSource: makeTickerSource({ perpPrice: 50000, datedPrice: 50000 }),
      alerter: { async send() {} } as any,
      sharedState: makeShared(),
      positionLedger: { async appendClosedPosition(e: any) { entries.push(e); } },
      log: () => {}, now: () => Date.now(),
    };
    const r = await processCalendarSpreadManageTick(makeJob(), deps);
    expect(r.status).toBe("complete");
    if (r.status === "complete") expect(r.reason).toBe("external-close");
    expect(entries).toHaveLength(1);
  });
});
