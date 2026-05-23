import { describe, expect, test } from "bun:test";
import {
  buildOrderSupervisorUserPayload,
  getOrderApproval,
  type AnthropicClientLike,
  type OrderSupervisorContext,
} from "./order-supervisor";

const baseContext: OrderSupervisorContext = {
  strategyType: "funding-arb",
  symbol: "BTCUSDT",
  side: "short",
  notionalUsd: 100,
  leverage: 3,
  signalSnapshot: {
    fundingRateBps: 12.4,
    nextFundingTime: 1747825200000,
    minutesToFunding: 4.2,
  },
  recentTrades: 2,
  recentWinRate: 1,
  recentNetPnlUsd: 3.5,
  walletAvailableUsd: 500,
  openPositionsCount: 0,
  cumulativeDailyPnlUsd: 3.5,
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

describe("buildOrderSupervisorUserPayload", () => {
  test("serializes strategy type, symbol, and signal snapshot", () => {
    const payload = buildOrderSupervisorUserPayload(baseContext);
    expect(payload).toContain("funding-arb");
    expect(payload).toContain("BTCUSDT");
    expect(payload).toContain("fundingRateBps");
    expect(payload).toContain("12.4");
  });
});

describe("getOrderApproval", () => {
  test("safe-rejects when no apiKey and no anthropicClient is provided", async () => {
    const verdict = await getOrderApproval({ context: baseContext });
    expect(verdict.approved).toBe(false);
    expect(verdict.confidence).toBe(0);
    expect(verdict.reasoning).toContain("missing ANTHROPIC_API_KEY");
  });

  test("safe-rejects when the Anthropic call exceeds the timeout", async () => {
    const fake = makeFakeClient(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                content: [
                  {
                    type: "tool_use",
                    name: "submit_order_verdict",
                    input: { approved: true, confidence: 0.9, reasoning: "ok" },
                  },
                ],
              }),
            200,
          );
        }),
    );
    const verdict = await getOrderApproval({
      context: baseContext,
      anthropicClient: fake,
      timeoutMs: 25,
    });
    expect(verdict.approved).toBe(false);
    expect(verdict.reasoning).toBe("supervisor-timeout");
  });

  test("returns an approve verdict when the LLM approves", async () => {
    const fake = makeFakeClient(() => ({
      content: [
        {
          type: "tool_use",
          name: "submit_order_verdict",
          input: {
            approved: true,
            confidence: 0.82,
            reasoning: "Funding spike + neutral exposure → green light.",
            concerns: ["wallet getting thin"],
          },
        },
      ],
    }));
    const verdict = await getOrderApproval({
      context: baseContext,
      anthropicClient: fake,
    });
    expect(verdict.approved).toBe(true);
    expect(verdict.confidence).toBeCloseTo(0.82);
    expect(verdict.reasoning).toContain("Funding spike");
    expect(verdict.concerns).toEqual(["wallet getting thin"]);
  });

  test("returns a reject verdict when the LLM rejects", async () => {
    const fake = makeFakeClient(() => ({
      content: [
        {
          type: "tool_use",
          name: "submit_order_verdict",
          input: {
            approved: false,
            confidence: 0.7,
            reasoning: "Recent net PnL down badly.",
          },
        },
      ],
    }));
    const verdict = await getOrderApproval({
      context: baseContext,
      anthropicClient: fake,
    });
    expect(verdict.approved).toBe(false);
    expect(verdict.confidence).toBeCloseTo(0.7);
    expect(verdict.reasoning).toContain("Recent net PnL");
    expect(verdict.concerns).toEqual([]);
  });

  test("parses concerns array (clamped to max 5)", async () => {
    const fake = makeFakeClient(() => ({
      content: [
        {
          type: "tool_use",
          name: "submit_order_verdict",
          input: {
            approved: true,
            confidence: 0.6,
            reasoning: "ok with caveats",
            concerns: ["a", "b", "c", "d", "e", "f", "g"],
          },
        },
      ],
    }));
    const verdict = await getOrderApproval({
      context: baseContext,
      anthropicClient: fake,
    });
    expect(verdict.concerns.length).toBe(5);
    expect(verdict.concerns).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("safe-rejects on Anthropic SDK error", async () => {
    const fake = makeFakeClient(() => {
      throw new Error("network down");
    });
    const verdict = await getOrderApproval({
      context: baseContext,
      anthropicClient: fake,
    });
    expect(verdict.approved).toBe(false);
    expect(verdict.confidence).toBe(0);
    expect(verdict.reasoning).toContain("supervisor-error");
    expect(verdict.reasoning).toContain("network down");
  });

  test("prompt includes strategy type, symbol, signal snapshot, and forced tool-choice", async () => {
    let observedParams: unknown = null;
    const fake = makeFakeClient((params) => {
      observedParams = params;
      return {
        content: [
          {
            type: "tool_use",
            name: "submit_order_verdict",
            input: {
              approved: true,
              confidence: 0.5,
              reasoning: "test",
            },
          },
        ],
      };
    });
    await getOrderApproval({
      context: baseContext,
      anthropicClient: fake,
    });
    const p = observedParams as {
      system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
      messages: Array<{ role: string; content: string }>;
      tool_choice: { type: string; name: string };
    };
    // Every system block carries cache_control so prompt caching applies.
    expect(Array.isArray(p.system)).toBe(true);
    for (const block of p.system) {
      expect(block.cache_control).toEqual({ type: "ephemeral" });
    }
    expect(p.tool_choice).toEqual({
      type: "tool",
      name: "submit_order_verdict",
    });
    // Dynamic content reached the model.
    expect(p.messages[0]!.content).toContain("funding-arb");
    expect(p.messages[0]!.content).toContain("BTCUSDT");
    expect(p.messages[0]!.content).toContain("fundingRateBps");
  });

  test("clamps out-of-range confidence to [0,1]", async () => {
    const fake = makeFakeClient(() => ({
      content: [
        {
          type: "tool_use",
          name: "submit_order_verdict",
          input: { approved: true, confidence: 2.5, reasoning: "overflow" },
        },
      ],
    }));
    const verdict = await getOrderApproval({
      context: baseContext,
      anthropicClient: fake,
    });
    expect(verdict.confidence).toBe(1);
  });
});
