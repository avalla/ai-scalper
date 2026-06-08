/**
 * LLM strategy advisor — periodic, advisory-only recommendation for which
 * strategy should run next. Does NOT mutate runtime config; the operator
 * decides whether to act on the recommendation.
 *
 * Cost model: prompt caching on the system prompt + static strategy
 * descriptions means each subsequent call pays only for the small dynamic
 * regime+performance payload. Expect ~$0.001-$0.01 per call with Haiku.
 */

import Anthropic from "@anthropic-ai/sdk";
import { recordAnthropicResponseUsage } from "../observability/anthropic-usage";

export interface MarketRegimeSnapshot {
  observedAt: string;
  btcPrice: number;
  btcTrendBps4h: number;       // bps change over last ~4h
  btcRealizedVol1h: number;    // realized vol % over last 1h
  avgFundingRateBps: number;   // avg across major perps
  spotPerpBasisBps: number;    // BTC spot vs perp
  topRankedSetups: Array<{
    symbol: string;
    score: number;
    netEdgeBps: number;
    action: string;
  }>;
  /** Optional multi-TF chart context (step-2 enhancement). When present, lets
   *  the LLM perform trader-like technical reading: trend across 5m/1h/4h, vol
   *  expansion, OB imbalance. Absent = legacy regime-only advisor input. */
  chartContext?: ChartContext;
}

export interface KlineSummary {
  /** Number of bars summarized (typically 24). */
  barsSampled: number;
  /** Highest high across the window. */
  rangeHigh: number;
  /** Lowest low across the window. */
  rangeLow: number;
  /** (high - low) / low expressed as percent. */
  rangePct: number;
  /** (last_close - first_close) / first_close in bps. Positive = uptrend. */
  trendBps: number;
  /** Last bar's volume divided by mean of the prior bars. >1.5 = expansion. */
  volumeRatioVsAvg: number;
  /** Most recent close. */
  lastClose: number;
}

export interface ChartContext {
  klines5m: KlineSummary;
  klines1h: KlineSummary;
  klines4h: KlineSummary;
  /** Top-of-book snapshot for BTCUSDT perp. */
  orderbook: {
    bid1Price: number;
    ask1Price: number;
    spreadBps: number;
  };
  /** External high-signal events from the event-feeder (Bybit announcements,
   *  funding extremes, etc.) within the last lookback window. Optional —
   *  absent when no feeder is configured or no events fetched. */
  recentEvents?: RecentEventSummary[];
}

/** Compact representation of an external event for advisor consumption.
 *  Keeps payload small to stay within token budget. */
export interface RecentEventSummary {
  source: string;
  signal: "high" | "medium" | "low";
  sentiment: "bullish" | "bearish" | "neutral";
  symbols: string[];
  title: string;
  ageMinutes: number;
}

export interface RecentStrategyPerformance {
  strategyType: string;
  tradesLast24h: number;
  winRate: number;        // 0-1
  netPnlUsd: number;
  avgHoldMinutes: number;
}

export type RecommendedStrategy =
  | "ma-crossover"
  | "funding-arb"
  | "longer-tf"
  | "basis-arb"
  | "pairs-trading"
  | "bollinger-adx"
  | "calendar-spread"
  | "halt";

export interface AdvisorRecommendation {
  recommendedStrategy: RecommendedStrategy;
  confidence: number;       // 0-1
  reasoning: string;        // short explanation
  alternativeChoices: Array<{ strategy: string; reason: string }>;
}

const VALID_STRATEGIES: ReadonlyArray<RecommendedStrategy> = [
  "ma-crossover",
  "funding-arb",
  "longer-tf",
  "basis-arb",
  "pairs-trading",
  "bollinger-adx",
  "calendar-spread",
  "halt",
];

const SYSTEM_PROMPT =
  "You are an expert quantitative trading advisor for a multi-strategy crypto-perpetuals bot. " +
  "Given current market regime indicators and recent performance of available strategies, " +
  "recommend the SINGLE strategy that should run for the next 30 minutes. Be decisive but " +
  "conservative — recommend 'halt' if no strategy has a clear edge given the regime.\n\n" +
  "Trader-style chart analysis (when chartContext is present):\n" +
  "- Compare 5m/1h/4h trends. Aligned trends = trending regime → favor longer-tf or bollinger-adx (ADX>25).\n" +
  "- Diverging trends (5m vs 4h opposite) = ranging/whipsaw → favor pairs-trading or basis-arb.\n" +
  "- 1h range narrow (<0.5%) + ADX low = compression → expect breakout; recommend halt OR bollinger-adx with wide stops.\n" +
  "- 1h volumeRatioVsAvg > 2.0 = vol expansion underway → trending strategies usually outperform.\n" +
  "- 4h range > 3% with reversal in 5m = exhaustion → favor mean-reversion.\n" +
  "- OB spread > 5 bps on BTC perp = thin liquidity → AVOID strategies sensitive to execution cost (calendar-spread, basis-arb).\n" +
  "- Always weigh recent performance: a strategy net-negative in last 24h should be deprioritized unless regime has just flipped.\n\n" +
  "Event-driven cues (when recentEvents is present):\n" +
  "- bybit-announcement high/bullish (new perp listing) → entry-day pump+dump pattern; AVOID; high vol but adverse selection.\n" +
  "- bybit-announcement high/bearish (delisting, hack) → AVOID exposure on affected symbols.\n" +
  "- funding-extreme high signal (|fundingBps| >= 50, sentiment is contrarian to funding sign) → setup for squeeze. funding-arb fits these.\n" +
  "- Multiple medium events clustered = elevated background vol; favor mean-reversion (pairs-trading, basis-arb).";

const STRATEGY_DESCRIPTIONS =
  "Available strategies and their philosophies:\n" +
  "- ma-crossover: 1-min MA crossover scalping. NOT recommended due to fees > gross edge on 1m crypto.\n" +
  "- funding-arb: market-neutral funding payment capture (perp short + spot long when funding > threshold).\n" +
  "- longer-tf: 15m MA trend-following on a single symbol. Fees become negligible on this timeframe.\n" +
  "- basis-arb: spot-perp basis convergence. Market-neutral statistical arb on a single underlying.\n" +
  "- pairs-trading: BTC-ETH cointegration mean reversion via z-score of log spread.\n" +
  "- bollinger-adx: regime-adaptive (ranging vs trending) single-leg strategy on 15m bars.\n" +
  "- calendar-spread: perp vs dated quarterly futures convergence trade. Slow (weeks).\n" +
  "- halt: do nothing.";

const RECOMMEND_TOOL = {
  name: "recommend_strategy",
  description:
    "Emit the single recommended trading strategy for the next operational window. Must be one of the listed strategies or 'halt'.",
  input_schema: {
    type: "object" as const,
    properties: {
      recommendedStrategy: {
        type: "string",
        enum: VALID_STRATEGIES,
        description: "The single strategy to run next, or 'halt'.",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Confidence 0-1 in the recommendation.",
      },
      reasoning: {
        type: "string",
        description: "Concise (<=2 sentences) explanation of why this strategy is chosen given the regime.",
      },
      alternativeChoices: {
        type: "array",
        description: "Optional ranked list of backup strategies with brief reasons.",
        items: {
          type: "object",
          properties: {
            strategy: { type: "string" },
            reason: { type: "string" },
          },
          required: ["strategy", "reason"],
        },
      },
    },
    required: ["recommendedStrategy", "confidence", "reasoning", "alternativeChoices"],
  },
};

function isValidStrategy(s: string): s is RecommendedStrategy {
  return (VALID_STRATEGIES as ReadonlyArray<string>).includes(s);
}

function safeDefault(reason: string): AdvisorRecommendation {
  return {
    recommendedStrategy: "halt",
    confidence: 0,
    reasoning: `advisor error: ${reason}`,
    alternativeChoices: [],
  };
}

/**
 * Build the user-message payload — the dynamic portion that changes between
 * calls. Static description blocks are kept in the system message so prompt
 * caching applies.
 */
export function buildAdvisorUserPayload(
  regime: MarketRegimeSnapshot,
  performance: RecentStrategyPerformance[],
): string {
  return [
    "Current market regime:",
    JSON.stringify(regime, null, 2),
    "",
    "Recent strategy performance (last 24h):",
    JSON.stringify(performance, null, 2),
    "",
    "Choose the single best strategy to run for the next ~30 minutes and emit your decision via the recommend_strategy tool.",
  ].join("\n");
}

/**
 * Minimal interface for the Anthropic client surface we exercise. Tests can
 * inject a fake without depending on the full SDK shape.
 */
export interface AnthropicMessagesLike {
  create(params: unknown): Promise<{
    content: Array<
      | { type: "tool_use"; name: string; input: unknown }
      | { type: "text"; text: string }
      | { type: string; [k: string]: unknown }
    >;
  }>;
}

export interface AnthropicClientLike {
  messages: AnthropicMessagesLike;
}

/** Fetch a strategy recommendation from the LLM. Errors are caught and
 *  surface as a safe `halt` recommendation. */
export async function getStrategyRecommendation(input: {
  regime: MarketRegimeSnapshot;
  performance: RecentStrategyPerformance[];
  apiKey?: string;
  model?: string;
  anthropicClient?: AnthropicClientLike;
  costTracker?: { recordAnthropicCall(u: {
    inputTokens: number; cachedTokens: number; outputTokens: number; model: string;
  }): Promise<void> };
}): Promise<AdvisorRecommendation> {
  const model = input.model ?? "claude-haiku-4-5-20251001";
  let client: AnthropicClientLike;
  if (input.anthropicClient) {
    client = input.anthropicClient;
  } else {
    if (!input.apiKey || input.apiKey.trim() === "") {
      return safeDefault("missing ANTHROPIC_API_KEY");
    }
    client = new Anthropic({ apiKey: input.apiKey }) as unknown as AnthropicClientLike;
  }

  const userPayload = buildAdvisorUserPayload(input.regime, input.performance);

  // Cache-friendly system prompt: static blocks with ephemeral cache_control.
  const systemBlocks = [
    {
      type: "text" as const,
      text: SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" as const },
    },
    {
      type: "text" as const,
      text: STRATEGY_DESCRIPTIONS,
      cache_control: { type: "ephemeral" as const },
    },
  ];

  let response;
  try {
    response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: systemBlocks,
      tools: [RECOMMEND_TOOL],
      tool_choice: { type: "tool", name: "recommend_strategy" },
      messages: [
        {
          role: "user",
          content: userPayload,
        },
      ],
    });
  } catch (err) {
    return safeDefault(err instanceof Error ? err.message : String(err));
  }

  await recordAnthropicResponseUsage(input.costTracker, response, model);

  // Extract the tool_use block.
  const toolUse = response.content.find(
    (block): block is { type: "tool_use"; name: string; input: unknown } =>
      block.type === "tool_use" && (block as { name?: string }).name === "recommend_strategy",
  );
  if (!toolUse) {
    return safeDefault("no tool_use block in response");
  }

  const raw = toolUse.input as Partial<AdvisorRecommendation> | undefined;
  if (!raw || typeof raw !== "object") {
    return safeDefault("malformed tool_use input");
  }
  const strategy = typeof raw.recommendedStrategy === "string" && isValidStrategy(raw.recommendedStrategy)
    ? raw.recommendedStrategy
    : null;
  if (!strategy) {
    return safeDefault(`invalid recommendedStrategy: ${String(raw.recommendedStrategy)}`);
  }
  const confidence = typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
    ? Math.max(0, Math.min(1, raw.confidence))
    : 0;
  const reasoning = typeof raw.reasoning === "string" ? raw.reasoning : "";
  const alternativeChoices = Array.isArray(raw.alternativeChoices)
    ? raw.alternativeChoices
        .filter((a): a is { strategy: string; reason: string } =>
          !!a && typeof (a as { strategy?: unknown }).strategy === "string"
          && typeof (a as { reason?: unknown }).reason === "string")
        .map((a) => ({ strategy: a.strategy, reason: a.reason }))
    : [];

  return {
    recommendedStrategy: strategy,
    confidence,
    reasoning,
    alternativeChoices,
  };
}

// Re-exported for tests that want to inspect the static system-prompt content
// to verify cache-control wrapping.
export const __INTERNAL = {
  SYSTEM_PROMPT,
  STRATEGY_DESCRIPTIONS,
  RECOMMEND_TOOL,
};
