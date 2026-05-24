import { describe, expect, test } from "bun:test";
import type { TraderConfig } from "../config";
import type { FundingArbManageJobData } from "@ai-scalper/queueing";
import {
  processFundingArbManageTick,
  type FundingArbManageProcessorDeps,
  type FundingArbManageProcessorLedger,
} from "./funding-arb-manage-processor";
import type { ClosedPositionLedgerEntry } from "../trading/position-ledger";
import type { StrategySharedState } from "./shared/bullmq-shared-state";

function makeConfig(overrides: Partial<TraderConfig> = {}): TraderConfig {
  const base = {
    symbol: "BTCUSDT",
    pollMs: 5_000,
    paperTrading: true,
    feeRoundTripBps: 6,
    fundingArbMinAbsRateBps: 5,
    fundingArbEntryWindowMinutesBefore: 5,
    fundingArbExitDelayMinutesAfter: 2,
    fundingArbMaxLeverage: 5,
    fundingArbMaxNotionalUsd: 100,
  };
  return { ...(base as unknown as TraderConfig), ...overrides };
}

function makeJobData(overrides: Partial<FundingArbManageJobData> = {}): FundingArbManageJobData {
  return {
    positionId: "funding-arb-position:1700000000000-BTCUSDT",
    symbol: "BTCUSDT",
    side: "short",
    entryPrice: 50_000,
    qty: 0.01,
    qtyStep: "0.001",
    minOrderQty: "0.001",
    notionalUsd: 100,
    leverage: 5,
    openedAt: new Date(1_700_000_000_000).toISOString(),
    fundingRateAtEntryBps: 10,
    fundingTimeTarget: 1_700_000_180_000, // 3 min after entry
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
  } as any;
}

function makeLedger(): FundingArbManageProcessorLedger & { entries: ClosedPositionLedgerEntry[] } {
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
      return { lastPrice: String(opts.lastPrice ?? 50_000) };
    },
    peek() { return null; },
  } as any;
}

function makeAlerter() { return { async send() {} } as any; }

function makeDeps(overrides: Partial<FundingArbManageProcessorDeps> = {}): FundingArbManageProcessorDeps & {
  _ledger: ReturnType<typeof makeLedger>;
  _shared: ReturnType<typeof makeShared>;
} {
  const _ledger = makeLedger();
  const _shared = makeShared();
  const deps: FundingArbManageProcessorDeps = {
    config: makeConfig(),
    client: makeClient(),
    tickerSource: makeTickerSource(),
    alerter: makeAlerter(),
    sharedState: _shared,
    positionLedger: _ledger,
    log: () => {},
    now: () => 1_700_000_000_000,
    ...overrides,
  };
  return Object.assign(deps as any, { _ledger, _shared });
}

describe("processFundingArbManageTick", () => {
  test("holds (continue) when still before exit window", async () => {
    const deps = makeDeps({ now: () => 1_700_000_060_000 }); // 1 min after entry, exit at +3+2
    const result = await processFundingArbManageTick(makeJobData(), deps);
    expect(result.status).toBe("continue");
    if (result.status === "continue") {
      expect(result.updatedData.decisionsHistory.at(-1)!.action).toBe("hold");
    }
    expect(deps._ledger.entries).toHaveLength(0);
  });

  test("closes (complete) and appends ledger entry when past exit window", async () => {
    const deps = makeDeps({
      now: () => 1_700_000_180_000 + 2 * 60_000 + 1, // exit delay 2 min after funding
      client: makeClient({ lastPrice: 50_100 }), // small adverse move for short
      tickerSource: makeTickerSource({ lastPrice: 50_100 }),
    });
    const result = await processFundingArbManageTick(makeJobData(), deps);
    expect(result.status).toBe("complete");
    if (result.status === "complete") expect(result.reason).toBe("after-funding-payout");
    expect(deps._ledger.entries).toHaveLength(1);
    const entry = deps._ledger.entries[0]!;
    expect(entry.strategyType).toBe("funding-arb");
    expect(entry.side).toBe("short");
    expect(entry.symbol).toBe("BTCUSDT");
    expect(entry.exitPrice).toBe(50_100);
    expect(entry.realizedPnlUsd).toBeLessThan(0); // adverse + fees
    expect(deps._shared.lastTradeAt).toBe(1_700_000_180_000 + 2 * 60_000 + 1);
  });

  test("external close detected (live mode) → complete with external-close reason", async () => {
    const deps = makeDeps({
      config: makeConfig({ paperTrading: false }),
      client: makeClient({ positionSize: 0 }),
    });
    const result = await processFundingArbManageTick(makeJobData(), deps);
    expect(result.status).toBe("complete");
    if (result.status === "complete") expect(result.reason).toBe("external-close");
    expect(deps._ledger.entries).toHaveLength(1);
  });

  test("ticker error keeps the job alive without closing", async () => {
    const failClient = {
      async getTicker() { throw new Error("net"); },
      async getPosition() { return { size: "0.01" }; },
      async createOrder() {},
    } as any;
    const deps = makeDeps({ client: failClient, tickerSource: makeTickerSource({ fail: true }) });
    const result = await processFundingArbManageTick(makeJobData(), deps);
    expect(result.status).toBe("continue");
    expect(deps._ledger.entries).toHaveLength(0);
  });
});
