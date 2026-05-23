import { describe, expect, test } from "bun:test";
import {
  checkSafetyOverride,
  computePnlBps,
  computePnlUsd,
  getManageDecision,
  getOpenDecision,
  updateExcursions,
  type AnthropicClientLike,
  type LlmManagedMarketContext,
  type LlmManagedPosition,
} from "./llm-managed";

const NOW = 1_700_000_000_000;

function makePosition(overrides: Partial<LlmManagedPosition> = {}): LlmManagedPosition {
  return {
    symbol: "BTCUSDT",
    side: "long",
    entryPrice: 100,
    qty: 1,
    notionalUsd: 100,
    leverage: 3,
    openedAt: NOW,
    targetPnlUsd: 10,
    maxLossUsd: 5,
    entryReasoning: "test setup",
    mfeUsd: 0,
    maeUsd: 0,
    decisionsHistory: [],
    hedge: null,
    ...overrides,
  };
}

const market: LlmManagedMarketContext = {
  observedAt: new Date(NOW).toISOString(),
  btcPrice: 100_000,
  btcTrendBps4h: 15,
  btcRealizedVol1h: 0.6,
  avgFundingRateBps: 1.2,
  spotPerpBasisBps: 0.5,
  topRankedSetups: [{ symbol: "BTCUSDT", score: 60, netEdgeBps: 18, action: "long" }],
};

function makeFakeClient(
  behavior: (params: unknown) => unknown | Promise<unknown>,
): AnthropicClientLike {
  return {
    messages: {
      async create(params: unknown) {
        const out = await behavior(params);
        return out as Awaited<
          ReturnType<AnthropicClientLike["messages"]["create"]>
        >;
      },
    },
  };
}

describe("computePnlUsd", () => {
  test("positive for long with price up", () => {
    const p = makePosition({ side: "long", entryPrice: 100, qty: 2 });
    expect(computePnlUsd(p, 110)).toBeCloseTo(20, 6);
  });

  test("negative for short with price up", () => {
    const p = makePosition({ side: "short", entryPrice: 100, qty: 2 });
    expect(computePnlUsd(p, 110)).toBeCloseTo(-20, 6);
  });
});

describe("computePnlBps", () => {
  test("matches pnlUsd / notional in bps", () => {
    const p = makePosition({ side: "long", entryPrice: 100, qty: 1, notionalUsd: 100 });
    // +1 USD on a 100 USD notional = 100 bps
    expect(computePnlBps(p, 101)).toBeCloseTo(100, 6);
  });

  test("returns 0 when notional is zero", () => {
    const p = makePosition({ notionalUsd: 0 });
    expect(computePnlBps(p, 200)).toBe(0);
  });
});

describe("updateExcursions", () => {
  test("increments mfe high-water and mae low-water marks", () => {
    let p = makePosition({ mfeUsd: 0, maeUsd: 0 });
    p = updateExcursions(p, 5);
    expect(p.mfeUsd).toBe(5);
    expect(p.maeUsd).toBe(0);
    p = updateExcursions(p, -3);
    expect(p.mfeUsd).toBe(5);
    expect(p.maeUsd).toBe(-3);
    p = updateExcursions(p, 2); // neither beats mfe (5) nor mae (-3)
    expect(p.mfeUsd).toBe(5);
    expect(p.maeUsd).toBe(-3);
  });

  test("returns the same reference when no extremum changes (pure)", () => {
    const p = makePosition({ mfeUsd: 10, maeUsd: -5 });
    const next = updateExcursions(p, 0);
    expect(next).toBe(p);
  });
});

describe("checkSafetyOverride", () => {
  test("triggers cut-loss when PnL <= -maxAbsoluteLossUsd", () => {
    const decision = checkSafetyOverride({
      position: makePosition({ maxLossUsd: 100 }),
      currentPnlUsd: -25,
      minutesHeld: 5,
      maxAbsoluteLossUsd: 20,
      maxHoldHours: 24,
    });
    expect(decision).not.toBeNull();
    expect(decision!.action).toBe("cut-loss");
    expect(decision!.reasoning).toBe("safety-hard-sl");
  });

  test("triggers cut-loss on per-position max-loss (when below hard SL absolute)", () => {
    const decision = checkSafetyOverride({
      position: makePosition({ maxLossUsd: 5 }),
      currentPnlUsd: -6, // < per-position 5, but > hard 20
      minutesHeld: 1,
      maxAbsoluteLossUsd: 20,
      maxHoldHours: 24,
    });
    expect(decision).not.toBeNull();
    expect(decision!.action).toBe("cut-loss");
    expect(decision!.reasoning).toBe("safety-per-position-max-loss");
  });

  test("triggers tp-full when minutesHeld > maxHoldHours * 60", () => {
    const decision = checkSafetyOverride({
      position: makePosition(),
      currentPnlUsd: 3,
      minutesHeld: 25 * 60, // > 24h
      maxAbsoluteLossUsd: 20,
      maxHoldHours: 24,
    });
    expect(decision).not.toBeNull();
    expect(decision!.action).toBe("tp-full");
    expect(decision!.reasoning).toBe("safety-max-hold");
  });

  test("returns null when position is within all bounds", () => {
    const decision = checkSafetyOverride({
      position: makePosition({ maxLossUsd: 50 }),
      currentPnlUsd: -3,
      minutesHeld: 30,
      maxAbsoluteLossUsd: 20,
      maxHoldHours: 24,
    });
    expect(decision).toBeNull();
  });
});

describe("getOpenDecision", () => {
  test("safe-skips when no apiKey and no client provided", async () => {
    const decision = await getOpenDecision({
      market,
      walletAvailableUsd: 500,
      recentTrades: 0,
      recentWinRate: 0,
      recentNetPnlUsd: 0,
      allowedSymbols: ["BTCUSDT"],
      maxNotionalUsd: 100,
      maxLeverage: 10,
    });
    expect(decision.action).toBe("skip");
    expect(decision.reasoning).toContain("missing ANTHROPIC_API_KEY");
  });

  test("parses an LLM open response", async () => {
    const fake = makeFakeClient(() => ({
      content: [
        {
          type: "tool_use",
          name: "open_or_skip",
          input: {
            action: "open",
            symbol: "BTCUSDT",
            side: "long",
            notionalUsd: 80,
            leverage: 5,
            targetPnlUsd: 12,
            maxLossUsd: 6,
            reasoning: "BTC trending; tight stop ok.",
          },
        },
      ],
    }));
    const decision = await getOpenDecision({
      market,
      walletAvailableUsd: 500,
      recentTrades: 1,
      recentWinRate: 1,
      recentNetPnlUsd: 3,
      allowedSymbols: ["BTCUSDT", "ETHUSDT"],
      maxNotionalUsd: 100,
      maxLeverage: 10,
      anthropicClient: fake,
    });
    expect(decision.action).toBe("open");
    expect(decision.symbol).toBe("BTCUSDT");
    expect(decision.side).toBe("long");
    expect(decision.notionalUsd).toBe(80);
    expect(decision.leverage).toBe(5);
    expect(decision.targetPnlUsd).toBe(12);
    expect(decision.maxLossUsd).toBe(6);
    expect(decision.reasoning).toContain("trending");
  });

  test("safe-skips on Anthropic SDK error", async () => {
    const fake = makeFakeClient(() => {
      throw new Error("network unreachable");
    });
    const decision = await getOpenDecision({
      market,
      walletAvailableUsd: 500,
      recentTrades: 0,
      recentWinRate: 0,
      recentNetPnlUsd: 0,
      allowedSymbols: ["BTCUSDT"],
      maxNotionalUsd: 100,
      maxLeverage: 10,
      anthropicClient: fake,
    });
    expect(decision.action).toBe("skip");
    expect(decision.reasoning).toContain("network unreachable");
  });

  test("parses a skip response", async () => {
    const fake = makeFakeClient(() => ({
      content: [
        {
          type: "tool_use",
          name: "open_or_skip",
          input: { action: "skip", reasoning: "chop, no clear setup" },
        },
      ],
    }));
    const decision = await getOpenDecision({
      market,
      walletAvailableUsd: 500,
      recentTrades: 0,
      recentWinRate: 0,
      recentNetPnlUsd: 0,
      allowedSymbols: ["BTCUSDT"],
      maxNotionalUsd: 100,
      maxLeverage: 10,
      anthropicClient: fake,
    });
    expect(decision.action).toBe("skip");
    expect(decision.reasoning).toBe("chop, no clear setup");
  });
});

describe("getManageDecision", () => {
  function manageInputBase(overrides: Partial<Parameters<typeof getManageDecision>[0]> = {}) {
    return {
      position: makePosition(),
      currentPrice: 101,
      currentPnlUsd: 1,
      currentPnlBps: 100,
      minutesHeld: 5,
      market,
      ...overrides,
    };
  }

  test("parses 'hold' action", async () => {
    const fake = makeFakeClient(() => ({
      content: [
        {
          type: "tool_use",
          name: "manage_position",
          input: { action: "hold", reasoning: "let it run" },
        },
      ],
    }));
    const d = await getManageDecision(manageInputBase({ anthropicClient: fake }));
    expect(d.action).toBe("hold");
    expect(d.reasoning).toBe("let it run");
    expect(d.params).toBeUndefined();
  });

  test("parses 'tp-partial' and clamps fraction into [0.1, 0.9]", async () => {
    const fake = makeFakeClient(() => ({
      content: [
        {
          type: "tool_use",
          name: "manage_position",
          input: {
            action: "tp-partial",
            params: { tpPartialFraction: 1.7 }, // out of range
            reasoning: "lock half",
          },
        },
      ],
    }));
    const d = await getManageDecision(manageInputBase({ anthropicClient: fake }));
    expect(d.action).toBe("tp-partial");
    expect(d.params?.tpPartialFraction).toBe(0.9);
  });

  test("parses 'cut-loss'", async () => {
    const fake = makeFakeClient(() => ({
      content: [
        {
          type: "tool_use",
          name: "manage_position",
          input: { action: "cut-loss", reasoning: "thesis broken" },
        },
      ],
    }));
    const d = await getManageDecision(manageInputBase({ anthropicClient: fake }));
    expect(d.action).toBe("cut-loss");
  });

  test("parses 'open-hedge' and preserves hedgeSymbol", async () => {
    const fake = makeFakeClient(() => ({
      content: [
        {
          type: "tool_use",
          name: "manage_position",
          input: {
            action: "open-hedge",
            params: { hedgeSymbol: "ETHUSDT" },
            reasoning: "vol incoming",
          },
        },
      ],
    }));
    const d = await getManageDecision(manageInputBase({ anthropicClient: fake }));
    expect(d.action).toBe("open-hedge");
    expect(d.params?.hedgeSymbol).toBe("ETHUSDT");
  });

  test("safe-holds on SDK error", async () => {
    const fake = makeFakeClient(() => {
      throw new Error("boom");
    });
    const d = await getManageDecision(manageInputBase({ anthropicClient: fake }));
    expect(d.action).toBe("hold");
    expect(d.reasoning).toContain("boom");
  });

  test("prompt includes position snapshot and forced tool-choice", async () => {
    let observed: unknown = null;
    const fake = makeFakeClient((params) => {
      observed = params;
      return {
        content: [
          {
            type: "tool_use",
            name: "manage_position",
            input: { action: "hold", reasoning: "ok" },
          },
        ],
      };
    });
    await getManageDecision(manageInputBase({ anthropicClient: fake }));
    const p = observed as {
      system: Array<{ cache_control?: { type: string } }>;
      messages: Array<{ role: string; content: string }>;
      tool_choice: { type: string; name: string };
    };
    expect(p.tool_choice).toEqual({ type: "tool", name: "manage_position" });
    for (const block of p.system) {
      expect(block.cache_control).toEqual({ type: "ephemeral" });
    }
    expect(p.messages[0]!.content).toContain("BTCUSDT");
    expect(p.messages[0]!.content).toContain("currentPnlUsd");
  });
});
