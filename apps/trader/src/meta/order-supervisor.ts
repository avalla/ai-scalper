/**
 * LLM order supervisor — pre-entry approval layer for low-frequency
 * strategies. Opt-in (gated on ANTHROPIC_API_KEY + orderSupervisorEnabled).
 *
 * Design tenets:
 *   - Safe-reject by default. Any failure path (no apiKey, timeout, SDK
 *     error, malformed tool response) returns an `approved: false` verdict
 *     so a misconfigured deployment cannot accidentally fire un-supervised
 *     orders.
 *   - Only ENTRY orders are supervised. Exits + holds are deterministic so
 *     a dangling LLM call can never leave a naked position.
 *   - Prompt caching applies to the system prompt + the static strategy
 *     philosophy block. Each call only pays for the dynamic context body.
 *
 * Cost model (Haiku 4.5 with prompt caching):
 *   ~$0.005–0.05 per supervised trade → ~$0.02–1.00/day depending on the
 *   per-strategy trade frequency.
 */
import Anthropic from "@anthropic-ai/sdk";
import { recordAnthropicResponseUsage } from "../observability/anthropic-usage";

export type SupervisedStrategy =
  | "funding-arb"
  | "basis-arb"
  | "pairs-trading"
  | "calendar-spread";

export interface OrderSupervisorContext {
  strategyType: SupervisedStrategy;
  symbol: string;
  side: "long" | "short";
  notionalUsd: number;
  leverage: number;
  /** Strategy-specific signal data (funding rate, basis, z-score, etc.). */
  signalSnapshot: Record<string, unknown>;
  /** Recent performance (last 24h on this strategy). */
  recentTrades: number;
  recentWinRate: number;
  recentNetPnlUsd: number;
  /** Current account state. */
  walletAvailableUsd: number;
  openPositionsCount: number;
  cumulativeDailyPnlUsd: number;
}

export interface OrderSupervisorVerdict {
  approved: boolean;
  confidence: number;       // 0-1
  reasoning: string;        // short explanation
  concerns: string[];       // bullet list of risks the LLM flagged
}

export interface OrderSupervisorParams {
  context: OrderSupervisorContext;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  anthropicClient?: AnthropicClientLike;
  costTracker?: { recordAnthropicCall(u: {
    inputTokens: number; cachedTokens: number; outputTokens: number; model: string;
  }): Promise<void> };
}

/** Minimal Anthropic surface — mockable in tests. */
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

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_TIMEOUT_MS = 8_000;

const SYSTEM_PROMPT =
  "You are a risk-aware trading order supervisor. Your job is to approve or " +
  "reject a single proposed entry order. APPROVE only when the setup is " +
  "reasonable given the strategy, market context, and recent performance. " +
  "REJECT if you see red flags: heavy recent losses, abnormal position " +
  "sizing, conflicting signal data, or low-confidence setup. Be decisive " +
  "but not paranoid — if context looks normal you should approve. Output " +
  "the verdict via the provided tool.";

const STRATEGY_PHILOSOPHIES =
  "Supervised strategy philosophies — what 'normal' looks like:\n" +
  "- funding-arb: market-neutral funding payment capture. Enters short-perp " +
  "+ long-spot (or inverse) shortly before the funding window when " +
  "|fundingRateBps| exceeds threshold. ~3 trades/day. Normal: high abs " +
  "funding (>= 5bps), minutes-to-funding small (< 10min). Red flag: tiny " +
  "funding, or funding flipping sign vs recent prints.\n" +
  "- basis-arb: spot vs perp basis convergence. Two-leg market-neutral. " +
  "~3-10 trades/day. Normal: |basisBps| above entry threshold (8bps+). Red " +
  "flag: basis already mean-reverting fast, or extremely thin spread.\n" +
  "- pairs-trading: BTC-ETH (or similar) cointegration mean-reversion. " +
  "Entries on |z| >= entryZ (typically 2.0). ~1-5 trades/day. Normal: " +
  "z-score reflects a clear deviation. Red flag: z barely past threshold " +
  "with thin window, or both legs trending the same direction strongly.\n" +
  "- calendar-spread: perp vs dated quarterly futures convergence. Very " +
  "slow (1 trade per quarter). Normal: spreadBps significantly above " +
  "entryThreshold and plenty of time to settlement. Red flag: close to " +
  "settlement window or spread already near zero.";

const VERDICT_TOOL = {
  name: "submit_order_verdict" as const,
  description:
    "Submit your approve/reject verdict for the proposed entry order.",
  input_schema: {
    type: "object" as const,
    properties: {
      approved: {
        type: "boolean",
        description: "true to allow the order to be placed, false to reject.",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Confidence 0-1 in the verdict.",
      },
      reasoning: {
        type: "string",
        description: "1-3 sentence justification.",
      },
      concerns: {
        type: "array",
        description: "Optional list (max 5) of specific risks identified.",
        items: { type: "string" },
        maxItems: 5,
      },
    },
    required: ["approved", "confidence", "reasoning"],
  },
};

function safeReject(reason: string): OrderSupervisorVerdict {
  return {
    approved: false,
    confidence: 0,
    reasoning: reason,
    concerns: [],
  };
}

/**
 * Build the dynamic user-message body. Kept in the user-message (not the
 * system) so it does NOT bust the cache on the static blocks above.
 */
export function buildOrderSupervisorUserPayload(
  ctx: OrderSupervisorContext,
): string {
  return [
    "Proposed entry order:",
    JSON.stringify(
      {
        strategyType: ctx.strategyType,
        symbol: ctx.symbol,
        side: ctx.side,
        notionalUsd: ctx.notionalUsd,
        leverage: ctx.leverage,
        signalSnapshot: ctx.signalSnapshot,
      },
      null,
      2,
    ),
    "",
    "Recent performance for this strategy (last 24h):",
    JSON.stringify(
      {
        recentTrades: ctx.recentTrades,
        recentWinRate: ctx.recentWinRate,
        recentNetPnlUsd: ctx.recentNetPnlUsd,
      },
      null,
      2,
    ),
    "",
    "Current account state:",
    JSON.stringify(
      {
        walletAvailableUsd: ctx.walletAvailableUsd,
        openPositionsCount: ctx.openPositionsCount,
        cumulativeDailyPnlUsd: ctx.cumulativeDailyPnlUsd,
      },
      null,
      2,
    ),
    "",
    "Emit your decision via the submit_order_verdict tool. Approve unless you see a clear red flag.",
  ].join("\n");
}

/**
 * Race a promise against a timeout. On timeout the inner promise is
 * abandoned (we cannot cancel the Anthropic SDK call, but the caller will
 * have already moved on to the safe-reject path).
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("supervisor-timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Ask the LLM whether to approve this entry order. Returns a `safeReject`
 * verdict on any failure (no apiKey, timeout, SDK error, malformed
 * response, invalid tool input).
 */
export async function getOrderApproval(
  params: OrderSupervisorParams,
): Promise<OrderSupervisorVerdict> {
  const model = params.model ?? DEFAULT_MODEL;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let client: AnthropicClientLike;
  if (params.anthropicClient) {
    client = params.anthropicClient;
  } else {
    if (!params.apiKey || params.apiKey.trim() === "") {
      return safeReject("supervisor-error: missing ANTHROPIC_API_KEY");
    }
    client = new Anthropic({ apiKey: params.apiKey }) as unknown as AnthropicClientLike;
  }

  const userPayload = buildOrderSupervisorUserPayload(params.context);
  const systemBlocks = [
    {
      type: "text" as const,
      text: SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" as const },
    },
    {
      type: "text" as const,
      text: STRATEGY_PHILOSOPHIES,
      cache_control: { type: "ephemeral" as const },
    },
  ];

  let response;
  try {
    response = await withTimeout(
      client.messages.create({
        model,
        max_tokens: 512,
        system: systemBlocks,
        tools: [VERDICT_TOOL],
        tool_choice: { type: "tool", name: "submit_order_verdict" },
        messages: [{ role: "user", content: userPayload }],
      }),
      timeoutMs,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "supervisor-timeout") {
      return safeReject("supervisor-timeout");
    }
    return safeReject(`supervisor-error: ${msg}`);
  }

  await recordAnthropicResponseUsage(params.costTracker, response, model);

  const toolUse = response.content.find(
    (block): block is { type: "tool_use"; name: string; input: unknown } =>
      block.type === "tool_use"
      && (block as { name?: string }).name === "submit_order_verdict",
  );
  if (!toolUse) {
    return safeReject("supervisor-error: no tool_use block in response");
  }

  const raw = toolUse.input as
    | Partial<{
        approved: unknown;
        confidence: unknown;
        reasoning: unknown;
        concerns: unknown;
      }>
    | undefined;
  if (!raw || typeof raw !== "object") {
    return safeReject("supervisor-error: malformed tool_use input");
  }
  if (typeof raw.approved !== "boolean") {
    return safeReject("supervisor-error: missing approved boolean");
  }
  const confidence =
    typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
      ? Math.max(0, Math.min(1, raw.confidence))
      : 0;
  const reasoning = typeof raw.reasoning === "string" ? raw.reasoning : "";
  const concerns = Array.isArray(raw.concerns)
    ? raw.concerns
        .filter((c): c is string => typeof c === "string")
        .slice(0, 5)
    : [];

  return {
    approved: raw.approved,
    confidence,
    reasoning,
    concerns,
  };
}

export const __INTERNAL = {
  SYSTEM_PROMPT,
  STRATEGY_PHILOSOPHIES,
  VERDICT_TOOL,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
};
