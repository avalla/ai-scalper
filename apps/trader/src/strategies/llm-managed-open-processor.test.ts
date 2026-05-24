import { describe, expect, test } from "bun:test";
import {
  processLlmManagedOpenTick,
  type LlmManagedOpenProcessorDeps,
} from "./llm-managed-open-processor";
import type { TraderConfig } from "../config";
import type { LlmManagedMarketContext, OpenDecision } from "./llm-managed";
import type { LlmManagedManageJobData, LlmManagedOpenTickJobData } from "@ai-scalper/queueing";

const NOW = 1_700_000_000_000;
const TS = new Date(NOW).toISOString();

function makeConfig(overrides: Partial<TraderConfig> = {}): TraderConfig {
  return {
    // Only the fields the processor reads are filled meaningfully; others
    // can be cast since the processor never touches them. Cast to TraderConfig
    // for type-shape.
    llmManagedAllowedSymbols: ["BTCUSDT", "ETHUSDT"],
    llmManagedOpenReviewIntervalSec: 600,
    llmManagedManageReviewIntervalSec: 180,
    llmManagedMaxNotionalUsd: 12,
    llmManagedMaxLeverage: 5,
    llmManagedMaxHoldHours: 12,
    llmManagedMaxAbsoluteLossUsd: 2,
    llmManagedHedgeMaxNotionalUsd: 10,
    llmManagedModel: "claude-haiku-4-5-20251001",
    llmManagedTimeoutMs: 15000,
    llmManagedPostCutLossCooldownMs: 30 * 60_000,
    llmManagedUseBullmqJobs: true,
    paperTrading: true,
    feeRoundTripBps: 11,
    walletAccountType: "UNIFIED",
    walletCoin: "USDT",
    ...overrides,
  } as unknown as TraderConfig;
}

interface SharedStateStub {
  hasActivePosition: () => Promise<boolean>;
  getActivePositionCount: () => Promise<number>;
  setLastCutLossAt: (n: number) => Promise<void>;
  getLastCutLossAt: () => Promise<number>;
  getCooldownRemainingMs: (now: number, cd: number) => Promise<number>;
}

function makeSharedState(opts: { hasActivePosition?: boolean; cooldownRemainingMs?: number } = {}): SharedStateStub {
  return {
    async hasActivePosition() { return opts.hasActivePosition ?? false; },
    async getActivePositionCount() { return opts.hasActivePosition ? 1 : 0; },
    async setLastCutLossAt() {},
    async getLastCutLossAt() { return 0; },
    async getCooldownRemainingMs() { return opts.cooldownRemainingMs ?? 0; },
  };
}

function makeManageQueueStub() {
  const added: Array<{ name: string; data: LlmManagedManageJobData; opts: unknown }> = [];
  return {
    add: async (name: string, data: LlmManagedManageJobData, opts: unknown) => {
      added.push({ name, data, opts });
      return { id: data.positionId } as unknown;
    },
    _added: added,
  };
}

function makeBybitStub(overrides: { ticker?: number; instrument?: { qtyStep: string; minOrderQty: string } } = {}) {
  return {
    getTicker: async () => ({ lastPrice: String(overrides.ticker ?? 100) }),
    getInstrumentInfo: async () => ({
      lotSizeFilter: {
        qtyStep: overrides.instrument?.qtyStep ?? "0.001",
        minOrderQty: overrides.instrument?.minOrderQty ?? "0.001",
      },
    }),
    setLeverage: async () => ({ alreadySet: false }),
    createOrder: async () => ({ result: { orderId: "abc" } }),
  };
}

function makeAlerterStub() {
  const sent: string[] = [];
  return {
    sent,
    send: async (msg: string) => { sent.push(msg); },
  };
}

function makeMarket(): LlmManagedMarketContext {
  return {
    observedAt: TS, btcPrice: 100_000, btcTrendBps4h: 10, btcRealizedVol1h: 0.5,
    avgFundingRateBps: 1.2, spotPerpBasisBps: 0.5,
    topRankedSetups: [{ symbol: "BTCUSDT", score: 60, netEdgeBps: 18, action: "long" }],
  };
}

function makeDeps(
  overrides: Partial<LlmManagedOpenProcessorDeps> & {
    decision?: OpenDecision;
    cooldownMs?: number;
    hasActivePosition?: boolean;
    config?: Partial<TraderConfig>;
  } = {},
): LlmManagedOpenProcessorDeps & { _manage: ReturnType<typeof makeManageQueueStub>; _alerter: ReturnType<typeof makeAlerterStub> } {
  const manage = makeManageQueueStub();
  const alerter = makeAlerterStub();
  return {
    config: makeConfig(overrides.config ?? {}),
    client: makeBybitStub() as unknown as LlmManagedOpenProcessorDeps["client"],
    alerter: alerter as unknown as LlmManagedOpenProcessorDeps["alerter"],
    manageQueue: manage as unknown as LlmManagedOpenProcessorDeps["manageQueue"],
    sharedState: makeSharedState({
      hasActivePosition: overrides.hasActivePosition,
      cooldownRemainingMs: overrides.cooldownMs,
    }) as unknown as LlmManagedOpenProcessorDeps["sharedState"],
    collectMarketContext: async () => makeMarket(),
    collectRecentPerformance: async () => ({ trades: 0, winRate: 0, netPnlUsd: 0 }),
    collectWallet: async () => ({ availableUsd: 500 }),
    getOpenDecisionFn: async () => overrides.decision ?? { action: "skip", reasoning: "no-setup" },
    log: () => {},
    now: () => NOW,
    env: {},
    _manage: manage,
    _alerter: alerter,
    ...overrides,
  } as unknown as LlmManagedOpenProcessorDeps & { _manage: typeof manage; _alerter: typeof alerter };
}

const TICK: LlmManagedOpenTickJobData = { triggeredAt: TS, configFile: "config.llm-managed.json" };

describe("processLlmManagedOpenTick", () => {
  test("skips when an active manage job already exists", async () => {
    const deps = makeDeps({ hasActivePosition: true });
    const result = await processLlmManagedOpenTick(TICK, deps);
    expect(result.status).toBe("skipped");
    expect((result as { reason: string }).reason).toBe("active-position-exists");
    expect(deps._manage._added.length).toBe(0);
  });

  test("skips when cooldown is still active", async () => {
    const deps = makeDeps({ cooldownMs: 5_000 });
    const result = await processLlmManagedOpenTick(TICK, deps);
    expect(result.status).toBe("skipped");
    expect((result as { reason: string }).reason).toBe("cooldown");
  });

  test("skips when LLM returns action=skip", async () => {
    const deps = makeDeps({ decision: { action: "skip", reasoning: "no clear setup" } });
    const result = await processLlmManagedOpenTick(TICK, deps);
    expect(result.status).toBe("skipped");
    expect((result as { reason: string }).reason).toBe("llm-skip");
  });

  test("rejects symbols not in the allowedSymbols list", async () => {
    const deps = makeDeps({
      decision: {
        action: "open", symbol: "DOGEUSDT", side: "long",
        notionalUsd: 5, leverage: 3, targetPnlUsd: 3, maxLossUsd: 1, reasoning: "doge moon",
      },
    });
    const result = await processLlmManagedOpenTick(TICK, deps);
    expect(result.status).toBe("skipped");
    expect((result as { reason: string }).reason).toBe("symbol-not-allowed");
    expect(deps._alerter.sent.length).toBe(1);
    expect(deps._alerter.sent[0]).toContain("symbol-not-allowed");
  });

  test("clamps notional and leverage to configured caps when opening", async () => {
    const deps = makeDeps({
      decision: {
        action: "open", symbol: "BTCUSDT", side: "long",
        notionalUsd: 999, leverage: 50, targetPnlUsd: 3, maxLossUsd: 1, reasoning: "trend",
      },
    });
    const result = await processLlmManagedOpenTick(TICK, deps);
    expect(result.status).toBe("opened");
    if (result.status === "opened") {
      expect(result.notionalUsd).toBe(12); // maxNotionalUsd from makeConfig
      expect(result.leverage).toBe(5);     // maxLeverage from makeConfig
    }
    expect(deps._manage._added.length).toBe(1);
    expect(deps._manage._added[0]!.name).toBe("llm-managed:manage-tick");
    expect(deps._manage._added[0]!.data.symbol).toBe("BTCUSDT");
    expect(deps._manage._added[0]!.data.positionId.startsWith("llm-managed-position:")).toBe(true);
  });

  test("happy-path enqueues a manage job with a deterministic positionId", async () => {
    const deps = makeDeps({
      decision: {
        action: "open", symbol: "BTCUSDT", side: "short",
        notionalUsd: 6, leverage: 2, targetPnlUsd: 3, maxLossUsd: 1, reasoning: "fade-pump",
      },
    });
    const result = await processLlmManagedOpenTick(TICK, deps);
    expect(result.status).toBe("opened");
    if (result.status === "opened") {
      expect(result.positionId).toBe(`llm-managed-position:${NOW}-BTCUSDT`);
      expect(result.side).toBe("short");
      expect(result.notionalUsd).toBe(6);
      expect(result.leverage).toBe(2);
    }
    expect(deps._manage._added[0]!.data.entryReasoning).toBe("fade-pump");
    expect(deps._manage._added[0]!.data.maxLossUsd).toBe(1);
    expect(deps._manage._added[0]!.data.targetPnlUsd).toBe(3);
  });
});
