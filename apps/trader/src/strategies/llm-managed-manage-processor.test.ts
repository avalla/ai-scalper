import { describe, expect, test } from "bun:test";
import {
  processLlmManagedManageTick,
  type LlmManagedManageProcessorDeps,
  type ManageProcessorLedger,
} from "./llm-managed-manage-processor";
import type { TraderConfig } from "../config";
import type { LlmManagedMarketContext, ManageDecision } from "./llm-managed";
import type { LlmManagedManageJobData } from "@ai-scalper/queueing";
import type { ClosedPositionLedgerEntry } from "../trading/position-ledger";

const NOW = 1_700_000_000_000;
const TS = new Date(NOW).toISOString();

function makeConfig(overrides: Partial<TraderConfig> = {}): TraderConfig {
  return {
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
    useBullmqJobs: true,
    useWebSocket: false,
    paperTrading: true,
    feeRoundTripBps: 11,
    walletAccountType: "UNIFIED",
    walletCoin: "USDT",
    ...overrides,
  } as unknown as TraderConfig;
}

function makeJobData(overrides: Partial<LlmManagedManageJobData> = {}): LlmManagedManageJobData {
  return {
    positionId: "llm-managed-position:1700000000000-BTCUSDT",
    symbol: "BTCUSDT",
    side: "long",
    entryPrice: 100,
    qty: 1,
    qtyStep: "0.001",
    minOrderQty: "0.001",
    notionalUsd: 10,
    leverage: 3,
    openedAt: TS,
    targetPnlUsd: 5,
    maxLossUsd: 1,
    entryReasoning: "test-setup",
    mfeUsd: 0,
    maeUsd: 0,
    decisionsHistory: [],
    hedge: null,
    lastReviewAt: TS,
    ...overrides,
  };
}

function makeBybitStub(opts: { lastPrice?: number; positionSize?: number } = {}) {
  return {
    getTicker: async () => ({ lastPrice: String(opts.lastPrice ?? 100) }),
    getPosition: async () => (opts.positionSize === undefined ? null : { size: String(opts.positionSize) }),
    createOrder: async () => ({ result: { orderId: "abc" } }),
  };
}

function makeLedgerStub(): ManageProcessorLedger & { _entries: ClosedPositionLedgerEntry[] } {
  const entries: ClosedPositionLedgerEntry[] = [];
  return {
    _entries: entries,
    async appendClosedPosition(entry) { entries.push(entry); },
  };
}

function makeSharedStateStub() {
  const state = { lastCutLossAt: 0 };
  return {
    state,
    async hasActivePosition() { return false; },
    async getActivePositionCount() { return 0; },
    async setLastCutLossAt(n: number) { state.lastCutLossAt = n; },
    async getLastCutLossAt() { return state.lastCutLossAt; },
    async getCooldownRemainingMs() { return 0; },
  };
}

function makeAlerterStub() {
  return { send: async (_msg: string) => {} };
}

function makeMarket(): LlmManagedMarketContext {
  return {
    observedAt: TS, btcPrice: 100_000, btcTrendBps4h: 5, btcRealizedVol1h: 0.4,
    avgFundingRateBps: 0.5, spotPerpBasisBps: 0.1, topRankedSetups: [],
  };
}

function makeDeps(opts: {
  decision?: ManageDecision;
  config?: Partial<TraderConfig>;
  lastPrice?: number;
  positionSize?: number;
} = {}): LlmManagedManageProcessorDeps & {
  _ledger: ReturnType<typeof makeLedgerStub>;
  _shared: ReturnType<typeof makeSharedStateStub>;
} {
  const ledger = makeLedgerStub();
  const shared = makeSharedStateStub();
  return {
    config: makeConfig(opts.config ?? {}),
    client: makeBybitStub({ lastPrice: opts.lastPrice, positionSize: opts.positionSize }) as unknown as LlmManagedManageProcessorDeps["client"],
    alerter: makeAlerterStub() as unknown as LlmManagedManageProcessorDeps["alerter"],
    sharedState: shared as unknown as LlmManagedManageProcessorDeps["sharedState"],
    positionLedger: ledger,
    collectMarketContext: async () => makeMarket(),
    getManageDecisionFn: async () => opts.decision ?? { action: "hold", reasoning: "thesis-intact" },
    log: () => {},
    now: () => NOW + 60_000, // 1 minute after open
    env: {},
    _ledger: ledger,
    _shared: shared,
  } as unknown as LlmManagedManageProcessorDeps & { _ledger: typeof ledger; _shared: typeof shared };
}

describe("processLlmManagedManageTick", () => {
  test("hold action keeps the job alive and updates lastReviewAt + mfe/mae", async () => {
    const deps = makeDeps({ decision: { action: "hold", reasoning: "thesis-intact" }, lastPrice: 110 });
    const result = await processLlmManagedManageTick(makeJobData(), deps);
    expect(result.status).toBe("continue");
    if (result.status === "continue") {
      // PnL = (110 - 100) * 1 = +10 → mfe should be at least 10
      expect(result.updatedData.mfeUsd).toBeGreaterThanOrEqual(10);
      expect(result.updatedData.lastReviewAt).not.toBe(makeJobData().lastReviewAt);
      // history grows by one
      expect(result.updatedData.decisionsHistory.length).toBe(1);
      expect(result.updatedData.decisionsHistory[0]!.action).toBe("hold");
    }
    expect(deps._ledger._entries.length).toBe(0);
  });

  test("hard SL safety override closes + completes job + sets last-cut-loss-at", async () => {
    // Price 50 on a long@100 qty=1 → PnL = -50, well past maxAbsoluteLoss=2
    const deps = makeDeps({ lastPrice: 50 });
    const result = await processLlmManagedManageTick(makeJobData(), deps);
    expect(result.status).toBe("complete");
    if (result.status === "complete") {
      expect(result.reason).toBe("cut-loss");
    }
    expect(deps._ledger._entries.length).toBe(1);
    expect(deps._ledger._entries[0]!.llmManagedAction).toBe("cut-loss");
    expect(deps._ledger._entries[0]!.llmManagedReasoning).toBe("safety-hard-sl");
    expect(deps._shared.state.lastCutLossAt).toBeGreaterThan(0);
  });

  test("max-hold safety override closes via tp-full and completes job", async () => {
    const deps = makeDeps({
      config: { llmManagedMaxHoldHours: 0.0001 } as Partial<TraderConfig>,
      lastPrice: 105,
    });
    const result = await processLlmManagedManageTick(makeJobData(), deps);
    expect(result.status).toBe("complete");
    if (result.status === "complete") {
      expect(result.reason).toBe("tp-full");
    }
    expect(deps._ledger._entries[0]!.llmManagedAction).toBe("tp-full");
    expect(deps._ledger._entries[0]!.llmManagedReasoning).toBe("safety-max-hold");
    // tp-full from max-hold safety should NOT trigger cut-loss cooldown.
    expect(deps._shared.state.lastCutLossAt).toBe(0);
  });

  test("tp-partial reduces qty + notional proportionally and keeps job alive", async () => {
    const deps = makeDeps({
      decision: {
        action: "tp-partial",
        params: { tpPartialFraction: 0.5 },
        reasoning: "take half off",
      },
      lastPrice: 110,
    });
    const result = await processLlmManagedManageTick(makeJobData({ qty: 1, notionalUsd: 10 }), deps);
    expect(result.status).toBe("continue");
    if (result.status === "continue") {
      // qty 1 -> 0.5 (floored to step 0.001)
      expect(result.updatedData.qty).toBeCloseTo(0.5, 6);
      expect(result.updatedData.notionalUsd).toBeCloseTo(5, 6);
    }
    expect(deps._ledger._entries.length).toBe(1);
    expect(deps._ledger._entries[0]!.llmManagedAction).toBe("tp-partial");
  });

  test("tp-full closes everything, completes the job, does NOT set cut-loss cooldown", async () => {
    const deps = makeDeps({
      decision: { action: "tp-full", reasoning: "target hit" },
      lastPrice: 110,
    });
    const result = await processLlmManagedManageTick(makeJobData(), deps);
    expect(result.status).toBe("complete");
    if (result.status === "complete") {
      expect(result.reason).toBe("tp-full");
    }
    expect(deps._shared.state.lastCutLossAt).toBe(0);
    expect(deps._ledger._entries[0]!.llmManagedAction).toBe("tp-full");
  });

  test("LLM cut-loss action sets the cooldown timestamp and completes the job", async () => {
    const deps = makeDeps({
      decision: { action: "cut-loss", reasoning: "thesis-invalidated" },
      lastPrice: 99,
    });
    const result = await processLlmManagedManageTick(makeJobData(), deps);
    expect(result.status).toBe("complete");
    if (result.status === "complete") {
      expect(result.reason).toBe("cut-loss");
    }
    expect(deps._shared.state.lastCutLossAt).toBeGreaterThan(0);
  });

  test("external close detected via getPosition reconcile completes the job", async () => {
    // size=0 in live mode → external close
    const deps = makeDeps({
      config: { paperTrading: false } as Partial<TraderConfig>,
      positionSize: 0,
      lastPrice: 100,
    });
    const result = await processLlmManagedManageTick(makeJobData(), deps);
    expect(result.status).toBe("complete");
    if (result.status === "complete") {
      expect(result.reason).toBe("external-close");
    }
    expect(deps._ledger._entries.length).toBe(1);
    expect(deps._ledger._entries[0]!.llmManagedAction).toBe("external-close");
  });

  test("scale-in beyond notional cap is rejected and job continues unchanged", async () => {
    const deps = makeDeps({
      decision: {
        action: "scale-in",
        params: { scaleNotionalUsd: 999 }, // way above 2x maxNotionalUsd
        reasoning: "compound winner",
      },
      lastPrice: 110,
    });
    const before = makeJobData({ qty: 1, notionalUsd: 10 });
    const result = await processLlmManagedManageTick(before, deps);
    expect(result.status).toBe("continue");
    if (result.status === "continue") {
      expect(result.updatedData.qty).toBe(1); // unchanged
      expect(result.updatedData.notionalUsd).toBe(10); // unchanged
    }
  });
});
