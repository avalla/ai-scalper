import { describe, expect, test } from "bun:test";
import {
  buildAdvisorUserPayload,
  getStrategyRecommendation,
  type AnthropicClientLike,
  type MarketRegimeSnapshot,
  type RecentStrategyPerformance,
} from "./strategy-advisor";

const regime: MarketRegimeSnapshot = {
  observedAt: "2026-05-23T10:00:00.000Z",
  btcPrice: 65000,
  btcTrendBps4h: 35,
  btcRealizedVol1h: 1.2,
  avgFundingRateBps: 4,
  spotPerpBasisBps: 6,
  topRankedSetups: [
    { symbol: "BTCUSDT", score: 60, netEdgeBps: 20, action: "long" },
  ],
};

const performance: RecentStrategyPerformance[] = [
  { strategyType: "funding-arb", tradesLast24h: 3, winRate: 0.66, netPnlUsd: 4.2, avgHoldMinutes: 30 },
  { strategyType: "ma-crossover", tradesLast24h: 20, winRate: 0.45, netPnlUsd: -3.1, avgHoldMinutes: 5 },
];

function makeFakeClient(behavior: (params: unknown) => unknown): AnthropicClientLike {
  return {
    messages: {
      async create(params: unknown) {
        return behavior(params) as Awaited<ReturnType<AnthropicClientLike["messages"]["create"]>>;
      },
    },
  };
}

describe("buildAdvisorUserPayload", () => {
  test("includes regime fields", () => {
    const payload = buildAdvisorUserPayload(regime, performance);
    expect(payload).toContain("65000");          // btcPrice
    expect(payload).toContain("avgFundingRateBps");
    expect(payload).toContain("BTCUSDT");        // top-ranked
  });

  test("includes performance fields", () => {
    const payload = buildAdvisorUserPayload(regime, performance);
    expect(payload).toContain("funding-arb");
    expect(payload).toContain("winRate");
    expect(payload).toContain("0.66");
  });
});

describe("getStrategyRecommendation", () => {
  test("returns structured recommendation on success", async () => {
    const fake = makeFakeClient(() => ({
      content: [
        {
          type: "tool_use",
          name: "recommend_strategy",
          input: {
            recommendedStrategy: "funding-arb",
            confidence: 0.85,
            reasoning: "Funding-arb performed well and current funding is elevated.",
            alternativeChoices: [{ strategy: "basis-arb", reason: "stable backup" }],
          },
        },
      ],
    }));

    const rec = await getStrategyRecommendation({
      regime,
      performance,
      anthropicClient: fake,
    });
    expect(rec.recommendedStrategy).toBe("funding-arb");
    expect(rec.confidence).toBe(0.85);
    expect(rec.reasoning).toContain("Funding-arb");
    expect(rec.alternativeChoices).toEqual([{ strategy: "basis-arb", reason: "stable backup" }]);
  });

  test("returns safe halt default on client error", async () => {
    const fake = makeFakeClient(() => {
      throw new Error("network down");
    });
    const rec = await getStrategyRecommendation({
      regime,
      performance,
      anthropicClient: fake,
    });
    expect(rec.recommendedStrategy).toBe("halt");
    expect(rec.confidence).toBe(0);
    expect(rec.reasoning).toContain("network down");
  });

  test("returns safe halt when API key missing and no client injected", async () => {
    const rec = await getStrategyRecommendation({
      regime,
      performance,
      // no apiKey, no anthropicClient
    });
    expect(rec.recommendedStrategy).toBe("halt");
    expect(rec.reasoning).toContain("missing ANTHROPIC_API_KEY");
  });

  test("returns halt when tool returns invalid strategy name", async () => {
    const fake = makeFakeClient(() => ({
      content: [
        {
          type: "tool_use",
          name: "recommend_strategy",
          input: {
            recommendedStrategy: "lunar-cycle-strategy", // not in enum
            confidence: 1,
            reasoning: "made up",
            alternativeChoices: [],
          },
        },
      ],
    }));
    const rec = await getStrategyRecommendation({
      regime,
      performance,
      anthropicClient: fake,
    });
    expect(rec.recommendedStrategy).toBe("halt");
    expect(rec.reasoning).toContain("invalid recommendedStrategy");
  });

  test("system prompt contains cache_control blocks and regime + performance reach the model", async () => {
    let observedParams: unknown = null;
    const fake = makeFakeClient((params) => {
      observedParams = params;
      return {
        content: [
          {
            type: "tool_use",
            name: "recommend_strategy",
            input: {
              recommendedStrategy: "halt",
              confidence: 0.1,
              reasoning: "test",
              alternativeChoices: [],
            },
          },
        ],
      };
    });

    await getStrategyRecommendation({
      regime,
      performance,
      anthropicClient: fake,
    });

    const p = observedParams as {
      system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
      messages: Array<{ role: string; content: string }>;
      tool_choice: { type: string; name: string };
    };
    expect(Array.isArray(p.system)).toBe(true);
    // Every system block should carry cache_control for prompt caching.
    for (const block of p.system) {
      expect(block.cache_control).toEqual({ type: "ephemeral" });
    }
    // Forced tool-use.
    expect(p.tool_choice).toEqual({ type: "tool", name: "recommend_strategy" });
    // User payload carries the dynamic regime + performance content.
    expect(p.messages[0]!.content).toContain("65000");
    expect(p.messages[0]!.content).toContain("funding-arb");
  });

  test("clamps out-of-range confidence to [0,1]", async () => {
    const fake = makeFakeClient(() => ({
      content: [
        {
          type: "tool_use",
          name: "recommend_strategy",
          input: {
            recommendedStrategy: "basis-arb",
            confidence: 1.5,
            reasoning: "wild guess",
            alternativeChoices: [],
          },
        },
      ],
    }));
    const rec = await getStrategyRecommendation({
      regime,
      performance,
      anthropicClient: fake,
    });
    expect(rec.confidence).toBe(1);
  });
});
