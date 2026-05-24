import { describe, expect, test } from "bun:test";
import type { TraderConfig } from "../config";
import type { FundingArbManageJobData } from "@ai-scalper/queueing";
import {
  processFundingArbOpenTick,
  type FundingArbOpenProcessorDeps,
  type ManageQueueLike,
} from "./funding-arb-open-processor";
import type { StrategySharedState } from "./shared/bullmq-shared-state";

function makeConfig(overrides: Partial<TraderConfig> = {}): TraderConfig {
  const base = {
    symbol: "BTCUSDT",
    leverage: 5,
    orderUsd: 100,
    pollMs: 5_000,
    paperTrading: true,
    feeRoundTripBps: 0,
    fundingArbMinAbsRateBps: 5,
    fundingArbEntryWindowMinutesBefore: 5,
    fundingArbExitDelayMinutesAfter: 2,
    fundingArbMaxLeverage: 5,
    fundingArbMaxNotionalUsd: 100,
  };
  return { ...(base as unknown as TraderConfig), ...overrides };
}

function makeShared(opts: { hasActive?: boolean } = {}): StrategySharedState {
  return {
    async hasActivePosition() { return opts.hasActive ?? false; },
    async getActivePositionCount() { return opts.hasActive ? 1 : 0; },
    async setLastCutLossAt() {},
    async getLastCutLossAt() { return 0; },
    async getCooldownRemainingMs() { return 0; },
    async setLastTradeAt() {},
    async getLastTradeAt() { return 0; },
  };
}

function makeManageQueue() {
  const calls: Array<{ name: string; data: FundingArbManageJobData; opts?: Record<string, unknown> }> = [];
  const q: ManageQueueLike<FundingArbManageJobData> & { calls: typeof calls } = {
    calls,
    async add(name, data, opts) { calls.push({ name, data, opts }); return null; },
  };
  return q;
}

function makeAlerter() { return { async send() {} } as any; }

function makeClient(opts: {
  lastPrice?: number;
  fundingRate?: number;
  nextFundingTime?: number;
  qtyStep?: string;
  minOrderQty?: string;
} = {}) {
  return {
    async getTicker() {
      return {
        lastPrice: String(opts.lastPrice ?? 50_000),
        fundingRate: String(opts.fundingRate ?? 0.001), // 10 bps positive
        nextFundingTime: String(opts.nextFundingTime ?? Date.now() + 2 * 60_000), // 2 min away
      };
    },
    async getInstrumentInfo() {
      return {
        lotSizeFilter: {
          qtyStep: opts.qtyStep ?? "0.001",
          minOrderQty: opts.minOrderQty ?? "0.001",
        },
      };
    },
    async setLeverage() {},
    async createOrder() {},
  } as any;
}

function makeDeps(overrides: Partial<FundingArbOpenProcessorDeps> = {}): FundingArbOpenProcessorDeps & {
  _manage: ReturnType<typeof makeManageQueue>;
} {
  const _manage = makeManageQueue();
  const deps: FundingArbOpenProcessorDeps = {
    config: makeConfig(),
    client: makeClient(),
    alerter: makeAlerter(),
    manageQueue: _manage,
    sharedState: makeShared(),
    log: () => {},
    now: () => Date.now(),
    ...overrides,
  };
  return Object.assign(deps as any, { _manage });
}

describe("processFundingArbOpenTick", () => {
  test("skips when an active position already exists (1-position invariant)", async () => {
    const deps = makeDeps({ sharedState: makeShared({ hasActive: true }) });
    const result = await processFundingArbOpenTick(
      { triggeredAt: "now", configFile: "config.funding-arb.json" },
      deps,
    );
    expect(result.status).toBe("skipped");
    if (result.status === "skipped") expect(result.reason).toBe("active-position-exists");
    expect(deps._manage.calls).toHaveLength(0);
  });

  test("skips when funding-rate magnitude is below the configured floor", async () => {
    const deps = makeDeps({
      client: makeClient({ fundingRate: 0.0001 }), // 1 bps — below default 5
    });
    const result = await processFundingArbOpenTick(
      { triggeredAt: "now", configFile: "config.funding-arb.json" },
      deps,
    );
    expect(result.status).toBe("skipped");
    if (result.status === "skipped") expect(result.reason).toContain("decide-hold");
  });

  test("opens SHORT + enqueues manage job when positive funding inside entry window", async () => {
    const now = 1_700_000_000_000;
    const nextFunding = now + 2 * 60_000;
    const deps = makeDeps({
      now: () => now,
      client: makeClient({ lastPrice: 50_000, fundingRate: 0.001, nextFundingTime: nextFunding }),
    });
    const result = await processFundingArbOpenTick(
      { triggeredAt: "now", configFile: "config.funding-arb.json" },
      deps,
    );
    expect(result.status).toBe("opened");
    if (result.status === "opened") {
      expect(result.side).toBe("short");
      expect(result.symbol).toBe("BTCUSDT");
      expect(result.fundingTimeTarget).toBe(nextFunding);
      expect(result.entryPrice).toBe(50_000);
    }
    expect(deps._manage.calls).toHaveLength(1);
    const c = deps._manage.calls[0]!;
    expect(c.name).toBe("funding-arb-manage-tick");
    expect(c.data.side).toBe("short");
    expect((c.opts as any).jobId).toContain("funding-arb-position:");
    expect((c.opts as any).repeat.every).toBeGreaterThan(0);
  });

  test("opens LONG when funding is negative", async () => {
    const now = 1_700_000_000_000;
    const deps = makeDeps({
      now: () => now,
      client: makeClient({ fundingRate: -0.001, nextFundingTime: now + 2 * 60_000 }),
    });
    const result = await processFundingArbOpenTick(
      { triggeredAt: "now", configFile: "config.funding-arb.json" },
      deps,
    );
    expect(result.status).toBe("opened");
    if (result.status === "opened") expect(result.side).toBe("long");
  });

  test("skips when ticker fetch fails", async () => {
    const failClient = {
      async getTicker() { throw new Error("net down"); },
      async getInstrumentInfo() { throw new Error("nope"); },
    } as any;
    const deps = makeDeps({ client: failClient });
    const result = await processFundingArbOpenTick(
      { triggeredAt: "now", configFile: "config.funding-arb.json" },
      deps,
    );
    expect(result.status).toBe("skipped");
    if (result.status === "skipped") expect(result.reason).toBe("ticker-unavailable");
  });
});
