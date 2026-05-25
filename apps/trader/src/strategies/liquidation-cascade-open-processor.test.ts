import { describe, expect, test } from "bun:test";
import type { TraderConfig } from "../config";
import type { LiquidationCascadeManageJobData } from "@ai-scalper/queueing";
import {
  processLiquidationCascadeOpenTick,
  type LiquidationCascadeOpenProcessorDeps,
  type ManageQueueLike,
} from "./liquidation-cascade-open-processor";
import type { StrategySharedState } from "./shared/bullmq-shared-state";
import type { LiquidationsReader } from "./liquidations-cache-reader";

function makeConfig(overrides: Partial<TraderConfig> = {}): TraderConfig {
  const base = {
    category: "linear",
    symbol: "BTCUSDT",
    pollMs: 5_000,
    paperTrading: true,
    feeRoundTripBps: 11,
    maxPositionUsd: 200,
    maxDailyLossUsd: 100,
    maxSpreadBps: 200,
    minTradeIntervalMs: 0,
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
  const calls: Array<{ name: string; data: LiquidationCascadeManageJobData; opts?: Record<string, unknown> }> = [];
  const q: ManageQueueLike<LiquidationCascadeManageJobData> & { calls: typeof calls } = {
    calls,
    async add(name, data, opts) { calls.push({ name, data, opts }); return null; },
  };
  return q;
}

function makeAlerter() { return { async send() {} } as any; }

function makeReader(prints: Array<{ ts: number; side: "Buy" | "Sell"; sizeUsd: number }>): LiquidationsReader {
  return { async getRecent() { return prints; } };
}

function makeClient(opts: { qtyStep?: string; minOrderQty?: string } = {}) {
  return {
    async getInstrumentInfo() {
      return {
        symbol: "BTCUSDT",
        lotSizeFilter: {
          qtyStep: opts.qtyStep ?? "0.000001",
          minOrderQty: opts.minOrderQty ?? "0.000001",
        },
      };
    },
    async setLeverage() {},
    async createOrder() {},
  } as any;
}

function makeTickerSource(opts: { lastPrice?: number; fail?: boolean } = {}) {
  return {
    async getTicker() {
      if (opts.fail) throw new Error("net down");
      return {
        symbol: "BTCUSDT",
        lastPrice: String(opts.lastPrice ?? 50_000),
        bid1Price: String((opts.lastPrice ?? 50_000) - 0.5),
        ask1Price: String((opts.lastPrice ?? 50_000) + 0.5),
      } as any;
    },
    peek() { return null; },
  };
}

function makeDeps(overrides: Partial<LiquidationCascadeOpenProcessorDeps> = {}) {
  const _manage = makeManageQueue();
  const deps: LiquidationCascadeOpenProcessorDeps = {
    config: makeConfig(),
    client: makeClient(),
    tickerSource: makeTickerSource(),
    alerter: makeAlerter(),
    liquidationsReader: makeReader([]),
    manageQueue: _manage,
    sharedState: makeShared(),
    log: () => {},
    now: () => 1_700_000_000_000,
    ...overrides,
  };
  return Object.assign(deps as any, { _manage }) as LiquidationCascadeOpenProcessorDeps & {
    _manage: ReturnType<typeof makeManageQueue>;
  };
}

describe("processLiquidationCascadeOpenTick", () => {
  test("skips when an active position already exists (1-position invariant)", async () => {
    const deps = makeDeps({ sharedState: makeShared({ hasActive: true }) });
    const result = await processLiquidationCascadeOpenTick(
      { triggeredAt: "now", configFile: "config.liquidation-cascade.json" },
      deps,
    );
    expect(result.status).toBe("skipped");
    if (result.status === "skipped") expect(result.reason).toBe("active-position-exists");
    expect(deps._manage.calls).toHaveLength(0);
  });

  test("skips when no liquidations detected", async () => {
    const deps = makeDeps();
    const result = await processLiquidationCascadeOpenTick(
      { triggeredAt: "now", configFile: "config.liquidation-cascade.json" },
      deps,
    );
    expect(result.status).toBe("skipped");
    if (result.status === "skipped") expect(result.reason).toBe("no-cluster-detected");
    expect(deps._manage.calls).toHaveLength(0);
  });

  test("opens LONG + enqueues manage job on a longs-liquidated cluster", async () => {
    const now = 1_700_000_000_000;
    // Long liquidations are Sell prints (forced sells). Big cluster → LONG entry.
    const prints = Array.from({ length: 6 }, (_, i) => ({
      ts: now - 1_000 - i * 100,
      side: "Sell" as const,
      sizeUsd: 30_000,
    }));
    const deps = makeDeps({
      now: () => now,
      liquidationsReader: makeReader(prints),
    });
    const result = await processLiquidationCascadeOpenTick(
      { triggeredAt: "now", configFile: "config.liquidation-cascade.json" },
      deps,
    );
    expect(result.status).toBe("opened");
    if (result.status === "opened") {
      expect(result.symbol).toBe("BTCUSDT");
      expect(result.side).toBe("long");
      expect(result.entryPrice).toBe(50_000);
      // SL below entry for a long, TP above entry.
      expect(result.stopLossPrice).toBeLessThan(50_000);
      expect(result.takeProfitPrice).toBeGreaterThan(50_000);
    }
    expect(deps._manage.calls).toHaveLength(1);
    const c = deps._manage.calls[0]!;
    expect(c.name).toBe("liquidation-cascade-manage-tick");
    expect(c.data.side).toBe("long");
    expect(c.data.maxHoldSec).toBe(60);
    expect((c.opts as any).jobId).toContain("liquidation-cascade-position:");
    expect((c.opts as any).repeat.every).toBeGreaterThan(0);
  });
});
