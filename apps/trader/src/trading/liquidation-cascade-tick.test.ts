import { describe, expect, it } from "bun:test";
import type { TraderConfig } from "../config";
import type { ClosedPositionLedgerEntry } from "./position-ledger";
import type { TraderState } from "@ai-scalper/trading-core";
import {
  runLiquidationCascadeTick,
  type LiquidationCascadeLedger,
  type LiquidationCascadeTickDeps,
  type LiquidationCascadeTickerSource,
} from "./liquidation-cascade-tick";
import type { LiquidationsReader } from "../strategies/liquidations-cache-reader";

function makeConfig(overrides: Partial<TraderConfig> = {}): TraderConfig {
  return {
    apiKey: "k",
    apiSecret: "s",
    paperTrading: true,
    baseUrl: "https://api-testnet.bybit.com",
    scanBaseUrl: "https://api.bybit.com",
    requestTimeoutMs: 5_000,
    category: "linear",
    symbol: "BTCUSDT",
    pollMs: 100,
    orderUsd: 10,
    leverage: 3,
    feeRoundTripBps: 11,
    slippageTolerancePercent: 0.1,
    positionMode: "one-way",
    maxPositionUsd: 200,
    maxDailyLossUsd: 100,
    maxSpreadBps: 20,
    minTradeIntervalMs: 0,
    requireLocalMaConfirmation: false,
    strategyType: "liquidation-cascade",
    liquidationWindowMs: 30_000,
    liquidationMinClusterUsd: 50_000,
    liquidationMinCount: 3,
    liquidationCheckIntervalMs: 5_000,
    liquidationOrderUsd: 10,
    liquidationLeverage: 3,
    liquidationStopLossBps: 50,
    liquidationTakeProfitBps: 80,
    liquidationMaxHoldSec: 60,
    liquidationAllowedSymbols: ["BTCUSDT"],
    useBullmqJobs: false,
    useWebSocket: true,
    ...overrides,
  } as unknown as TraderConfig;
}

function makeState(overrides: Partial<TraderState> = {}): TraderState {
  return {
    lastTradeAt: null,
    realizedPnlUsd: 0,
    position: null,
    dayStartedAt: null,
    ...overrides,
  };
}

function makeRef<T>(initial: T) {
  let v = initial;
  return {
    get: () => v,
    set: (nv: T) => { v = nv; },
  };
}

function makeReader(byMember: Record<string, Array<{ ts: number; side: "Buy" | "Sell"; sizeUsd: number }>>): LiquidationsReader {
  return {
    async getRecent(symbol) {
      return byMember[symbol.toUpperCase()] ?? [];
    },
  };
}

function makeTicker(price: number, opts: { fail?: boolean } = {}): LiquidationCascadeTickerSource {
  return {
    async getTicker() {
      if (opts.fail) throw new Error("ticker boom");
      return {
        symbol: "BTCUSDT",
        lastPrice: String(price),
        bid1Price: String(price - 0.5),
        ask1Price: String(price + 0.5),
      } as unknown as Awaited<ReturnType<LiquidationCascadeTickerSource["getTicker"]>>;
    },
  };
}

function makeClient(opts: { qtyStep?: string; minQty?: string } = {}) {
  return {
    async getInstrumentInfo() {
      return {
        symbol: "BTCUSDT",
        lotSizeFilter: {
          qtyStep: opts.qtyStep ?? "0.000001",
          minOrderQty: opts.minQty ?? "0.000001",
        },
      };
    },
    async setLeverage() { return { alreadySet: false }; },
    async createOrder() { return { orderId: "x", orderLinkId: "y" }; },
  } as unknown as LiquidationCascadeTickDeps["client"];
}

function makeAlerter() {
  return { send: async () => {} } as unknown as LiquidationCascadeTickDeps["alerter"];
}

function makeLedger(): LiquidationCascadeLedger & { entries: ClosedPositionLedgerEntry[] } {
  const entries: ClosedPositionLedgerEntry[] = [];
  return {
    entries,
    async appendClosedPosition(e) { entries.push(e); },
  };
}

function makeDeps(overrides: Partial<LiquidationCascadeTickDeps> = {}): LiquidationCascadeTickDeps & {
  _state: ReturnType<typeof makeRef<TraderState>>;
  _sym: ReturnType<typeof makeRef<string | null>>;
  _ledger: ReturnType<typeof makeLedger>;
  _logs: Array<Record<string, unknown>>;
} {
  const stateRef = makeRef<TraderState>(makeState());
  const symRef = makeRef<string | null>(null);
  const ledger = makeLedger();
  const logs: Array<Record<string, unknown>> = [];
  return {
    config: makeConfig(),
    client: makeClient(),
    tickerSource: makeTicker(60_000),
    alerter: makeAlerter(),
    liquidationsReader: makeReader({}),
    positionLedger: ledger,
    stateRef,
    openPositionSymbolRef: symRef,
    log: (p) => { logs.push(p); },
    now: () => 1_700_000_000_000,
    ...overrides,
    _state: stateRef,
    _sym: symRef,
    _ledger: ledger,
    _logs: logs,
  } as ReturnType<typeof makeDeps>;
}

describe("runLiquidationCascadeTick", () => {
  it("no position + no liquidations → no-action", async () => {
    const deps = makeDeps();
    const res = await runLiquidationCascadeTick(deps);
    expect(res.status).toBe("no-action");
    expect(deps._sym.get()).toBeNull();
    expect(deps._state.get().position).toBeNull();
  });

  it("no position + longs-liquidated cluster → opens LONG", async () => {
    const now = 1_700_000_000_000;
    const deps = makeDeps({
      now: () => now,
      liquidationsReader: makeReader({
        BTCUSDT: [
          { ts: now - 5_000, side: "Sell", sizeUsd: 30_000 },
          { ts: now - 4_000, side: "Sell", sizeUsd: 25_000 },
          { ts: now - 3_000, side: "Sell", sizeUsd: 20_000 },
        ],
      }),
    });

    const res = await runLiquidationCascadeTick(deps);
    expect(res.status).toBe("opened");
    if (res.status === "opened") {
      expect(res.side).toBe("long"); // longs liquidated → enter LONG (mean revert UP)
      expect(res.symbol).toBe("BTCUSDT");
      expect(res.entryPrice).toBe(60_000);
    }
    expect(deps._sym.get()).toBe("BTCUSDT");
    const pos = deps._state.get().position;
    expect(pos).not.toBeNull();
    expect(pos?.side).toBe("long");
    expect(pos?.leverage).toBe(3);
  });

  it("position open + within maxHoldSec → no-action", async () => {
    const openedAt = 1_700_000_000_000;
    const now = openedAt + 10_000; // 10s in
    const deps = makeDeps({
      now: () => now,
    });
    deps._state.set({
      lastTradeAt: openedAt,
      realizedPnlUsd: 0,
      dayStartedAt: openedAt,
      position: {
        side: "long", quantity: 0.001, notionalUsd: 30, entryPrice: 60_000, leverage: 3,
        openedAt, stopLossPrice: 59_700, takeProfitPrice: 60_480,
      },
    });
    deps._sym.set("BTCUSDT");

    const res = await runLiquidationCascadeTick(deps);
    expect(res.status).toBe("no-action");
    expect(deps._state.get().position).not.toBeNull();
    expect(deps._ledger.entries.length).toBe(0);
  });

  it("position open + maxHoldSec exceeded → closes with liquidation-max-hold", async () => {
    const openedAt = 1_700_000_000_000;
    const now = openedAt + 61_000; // 61s — past 60s max
    const deps = makeDeps({
      now: () => now,
      tickerSource: makeTicker(60_050), // small move, not SL/TP
    });
    deps._state.set({
      lastTradeAt: openedAt,
      realizedPnlUsd: 0,
      dayStartedAt: openedAt,
      position: {
        side: "long", quantity: 0.001, notionalUsd: 60, entryPrice: 60_000, leverage: 3,
        openedAt, stopLossPrice: 59_700, takeProfitPrice: 60_480,
      },
    });
    deps._sym.set("BTCUSDT");

    const res = await runLiquidationCascadeTick(deps);
    expect(res.status).toBe("closed");
    if (res.status === "closed") {
      expect(res.exitReason).toBe("liquidation-max-hold");
      expect(res.exitPrice).toBe(60_050);
    }
    expect(deps._sym.get()).toBeNull();
    expect(deps._state.get().position).toBeNull();
    expect(deps._ledger.entries.length).toBe(1);
    expect(deps._ledger.entries[0]?.strategyType).toBe("liquidation-cascade");
    expect(deps._ledger.entries[0]?.exitReason).toBe("liquidation-max-hold");
  });

  it("position open + stop-loss hit → closes with stop-loss", async () => {
    const openedAt = 1_700_000_000_000;
    const now = openedAt + 5_000;
    const deps = makeDeps({
      now: () => now,
      tickerSource: makeTicker(59_690), // below SL
    });
    deps._state.set({
      lastTradeAt: openedAt,
      realizedPnlUsd: 0,
      dayStartedAt: openedAt,
      position: {
        side: "long", quantity: 0.001, notionalUsd: 60, entryPrice: 60_000, leverage: 3,
        openedAt, stopLossPrice: 59_700, takeProfitPrice: 60_480,
      },
    });
    deps._sym.set("BTCUSDT");

    const res = await runLiquidationCascadeTick(deps);
    expect(res.status).toBe("closed");
    if (res.status === "closed") expect(res.exitReason).toBe("stop-loss");
    expect(deps._ledger.entries[0]?.exitReason).toBe("stop-loss");
  });

  it("position open + take-profit hit → closes with take-profit", async () => {
    const openedAt = 1_700_000_000_000;
    const now = openedAt + 5_000;
    const deps = makeDeps({
      now: () => now,
      tickerSource: makeTicker(60_500), // above TP=60_480
    });
    deps._state.set({
      lastTradeAt: openedAt,
      realizedPnlUsd: 0,
      dayStartedAt: openedAt,
      position: {
        side: "long", quantity: 0.001, notionalUsd: 60, entryPrice: 60_000, leverage: 3,
        openedAt, stopLossPrice: 59_700, takeProfitPrice: 60_480,
      },
    });
    deps._sym.set("BTCUSDT");

    const res = await runLiquidationCascadeTick(deps);
    expect(res.status).toBe("closed");
    if (res.status === "closed") expect(res.exitReason).toBe("take-profit");
    expect(deps._ledger.entries[0]?.exitReason).toBe("take-profit");
  });

  it("risk gate blocks entry when cooldown is active", async () => {
    const now = 1_700_000_000_000;
    const deps = makeDeps({
      now: () => now,
      config: makeConfig({ minTradeIntervalMs: 60_000 }),
      liquidationsReader: makeReader({
        BTCUSDT: [
          { ts: now - 2_000, side: "Sell", sizeUsd: 30_000 },
          { ts: now - 1_500, side: "Sell", sizeUsd: 25_000 },
          { ts: now - 1_000, side: "Sell", sizeUsd: 20_000 },
        ],
      }),
    });
    // recent close → still in cooldown
    deps._state.set(makeState({ lastTradeAt: now - 1_000 }));

    const res = await runLiquidationCascadeTick(deps);
    expect(res.status).toBe("no-action");
    expect(deps._sym.get()).toBeNull();
    const blocked = deps._logs.find((l) => l.event === "liquidation-cascade-risk-blocked");
    expect(blocked).toBeDefined();
  });

  it("no position + shorts-liquidated cluster → opens SHORT", async () => {
    const now = 1_700_000_000_000;
    const deps = makeDeps({
      now: () => now,
      liquidationsReader: makeReader({
        BTCUSDT: [
          { ts: now - 3_000, side: "Buy", sizeUsd: 30_000 },
          { ts: now - 2_000, side: "Buy", sizeUsd: 25_000 },
          { ts: now - 1_000, side: "Buy", sizeUsd: 20_000 },
        ],
      }),
    });
    const res = await runLiquidationCascadeTick(deps);
    expect(res.status).toBe("opened");
    if (res.status === "opened") expect(res.side).toBe("short");
    expect(deps._state.get().position?.side).toBe("short");
  });

  it("ticker failure during entry → no-action, no open", async () => {
    const now = 1_700_000_000_000;
    const deps = makeDeps({
      now: () => now,
      tickerSource: makeTicker(60_000, { fail: true }),
      liquidationsReader: makeReader({
        BTCUSDT: [
          { ts: now - 3_000, side: "Sell", sizeUsd: 30_000 },
          { ts: now - 2_000, side: "Sell", sizeUsd: 25_000 },
          { ts: now - 1_000, side: "Sell", sizeUsd: 20_000 },
        ],
      }),
    });
    const res = await runLiquidationCascadeTick(deps);
    expect(res.status).toBe("no-action");
    expect(deps._sym.get()).toBeNull();
  });

  it("cluster below threshold → no-action (no entry)", async () => {
    const now = 1_700_000_000_000;
    const deps = makeDeps({
      now: () => now,
      liquidationsReader: makeReader({
        BTCUSDT: [
          { ts: now - 1_000, side: "Sell", sizeUsd: 1_000 },
          { ts: now - 500, side: "Sell", sizeUsd: 1_000 },
        ],
      }),
    });
    const res = await runLiquidationCascadeTick(deps);
    expect(res.status).toBe("no-action");
  });
});
