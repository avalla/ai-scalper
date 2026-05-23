/**
 * llm-managed strategy — fully autonomous LLM-driven position trading.
 *
 * Unlike the other strategies in this codebase, this module does NOT contain
 * a deterministic `decide` function. Instead, two LLM calls (entry decision +
 * active position management) drive the trade.  Pure helpers (PnL math,
 * excursion tracking, hardcoded safety overrides) are kept here so the
 * LLM-backed paths can be exercised under unit test with a dependency-
 * injected client.
 *
 * Safety model:
 *   - Hard SL, hard max-hold, and per-position max-loss are enforced BEFORE
 *     the LLM is ever called (see `checkSafetyOverride`).
 *   - Wallet / leverage / notional / hedge caps are applied AFTER the LLM
 *     responds (clamped in run-trader.ts dispatch).
 *   - Cooldown after `cut-loss` (configurable, default 30 min) is enforced
 *     in the run-trader dispatch.
 *
 * Cost model (Haiku 4.5 + prompt caching): ~$0.05-0.20 per call.  Worst-case
 * with default intervals (10-min open polls, 3-min manage polls when in
 * position): 30-40 calls/day → $1.50-8/day.
 */

import Anthropic from "@anthropic-ai/sdk";

// ── Position + context types ────────────────────────────────────────────────

export interface LlmManagedHedge {
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  qty: number;
  notionalUsd: number;
  openedAt: number;
}

export interface LlmManagedPosition {
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  qty: number;
  notionalUsd: number;
  leverage: number;
  openedAt: number;
  targetPnlUsd: number;
  maxLossUsd: number;
  entryReasoning: string;
  /** Max favorable excursion ever seen on this position (PnL high-water mark). */
  mfeUsd: number;
  /** Max adverse excursion (PnL low-water mark, signed). */
  maeUsd: number;
  decisionsHistory: Array<{ at: number; action: string; reasoning: string }>;
  hedge: LlmManagedHedge | null;
}

export interface LlmManagedMarketContext {
  observedAt: string;
  btcPrice: number;
  btcTrendBps4h: number;
  btcRealizedVol1h: number;
  avgFundingRateBps: number;
  spotPerpBasisBps: number;
  topRankedSetups: Array<{
    symbol: string;
    score: number;
    netEdgeBps: number;
    action: string;
  }>;
}

// ── Decision schemas (also encoded in the tool JSON schemas) ────────────────

export interface OpenDecisionInput {
  market: LlmManagedMarketContext;
  walletAvailableUsd: number;
  recentTrades: number;
  recentWinRate: number;
  recentNetPnlUsd: number;
  allowedSymbols: string[];
  maxNotionalUsd: number;
  maxLeverage: number;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  anthropicClient?: AnthropicClientLike;
}

export interface OpenDecision {
  action: "open" | "skip";
  symbol?: string;
  side?: "long" | "short";
  notionalUsd?: number;
  leverage?: number;
  targetPnlUsd?: number;
  maxLossUsd?: number;
  reasoning: string;
}

export type ManageAction =
  | "hold"
  | "tp-partial"
  | "tp-full"
  | "cut-loss"
  | "open-hedge"
  | "close-hedge"
  | "scale-in"
  | "scale-out";

export interface ManageDecision {
  action: ManageAction;
  params?: {
    tpPartialFraction?: number;
    hedgeSymbol?: string;
    scaleNotionalUsd?: number;
  };
  reasoning: string;
}

export interface ManageDecisionInput {
  position: LlmManagedPosition;
  currentPrice: number;
  currentPnlUsd: number;
  currentPnlBps: number;
  minutesHeld: number;
  market: LlmManagedMarketContext;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  anthropicClient?: AnthropicClientLike;
}

const VALID_MANAGE_ACTIONS: ReadonlyArray<ManageAction> = [
  "hold",
  "tp-partial",
  "tp-full",
  "cut-loss",
  "open-hedge",
  "close-hedge",
  "scale-in",
  "scale-out",
];

// ── Anthropic client shims (mockable in tests) ──────────────────────────────

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
const DEFAULT_TIMEOUT_MS = 15_000;

// ── Pure helpers ────────────────────────────────────────────────────────────

/** Realized unrealized PnL on the primary leg, in USD. */
export function computePnlUsd(
  position: LlmManagedPosition,
  currentPrice: number,
): number {
  const sign = position.side === "long" ? 1 : -1;
  return sign * (currentPrice - position.entryPrice) * position.qty;
}

/**
 * PnL in basis points relative to the notional at entry. Sign matches direction.
 * Returns 0 if the entry notional is non-positive.
 */
export function computePnlBps(
  position: LlmManagedPosition,
  currentPrice: number,
): number {
  if (position.notionalUsd <= 0) return 0;
  const pnl = computePnlUsd(position, currentPrice);
  return (pnl / position.notionalUsd) * 10_000;
}

/**
 * Returns a copy of the position with updated MFE/MAE high-/low-water marks
 * given the latest unrealized PnL value. Pure: never mutates the input.
 */
export function updateExcursions(
  position: LlmManagedPosition,
  currentPnlUsd: number,
): LlmManagedPosition {
  const nextMfe = Math.max(position.mfeUsd, currentPnlUsd);
  const nextMae = Math.min(position.maeUsd, currentPnlUsd);
  if (nextMfe === position.mfeUsd && nextMae === position.maeUsd) {
    return position;
  }
  return { ...position, mfeUsd: nextMfe, maeUsd: nextMae };
}

/**
 * Hardcoded, LLM-free safety overrides. Returns a forced ManageDecision if
 * any rule fires, or null when the position is within all safety bounds.
 *
 * Rules (in priority order):
 *   1. Hard SL: currentPnlUsd <= -maxAbsoluteLossUsd  → cut-loss
 *   2. Per-position max loss: currentPnlUsd <= -position.maxLossUsd  → cut-loss
 *   3. Max-hold: minutesHeld > maxHoldHours * 60  → tp-full
 */
export function checkSafetyOverride(params: {
  position: LlmManagedPosition;
  currentPnlUsd: number;
  minutesHeld: number;
  maxAbsoluteLossUsd: number;
  maxHoldHours: number;
}): ManageDecision | null {
  const { position, currentPnlUsd, minutesHeld, maxAbsoluteLossUsd, maxHoldHours } =
    params;
  if (currentPnlUsd <= -Math.abs(maxAbsoluteLossUsd)) {
    return {
      action: "cut-loss",
      reasoning: "safety-hard-sl",
    };
  }
  if (currentPnlUsd <= -Math.abs(position.maxLossUsd)) {
    return {
      action: "cut-loss",
      reasoning: "safety-per-position-max-loss",
    };
  }
  if (minutesHeld > maxHoldHours * 60) {
    return {
      action: "tp-full",
      reasoning: "safety-max-hold",
    };
  }
  return null;
}

/** Clamp a number into [min, max]. */
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Race a promise against a timeout. The inner promise is abandoned on timeout. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("llm-managed-timeout")), ms);
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

// ── Prompt blocks ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are a fully autonomous LLM-managed position trader on Bybit linear " +
  "perpetuals. You decide ENTRY (open or skip) when flat, and ACTIVE " +
  "MANAGEMENT (hold, take-profit partial/full, cut-loss, open/close hedge, " +
  "scale-in/out) when a position is open. Be DECISIVE and EDGE-SEEKING. " +
  "Capital preservation is HARDCODED outside your response: the operator " +
  "enforces wallet cap, leverage cap, hard stop-loss, daily loss limit, " +
  "and max-hold around every decision you make. Your job is to CAPTURE " +
  "ALPHA, not to add a second redundant layer of safety. A small wallet " +
  "does NOT justify skipping a clear-edge setup — the notional has " +
  "already been sized appropriately. Always emit your verdict via the " +
  "provided tool.";

const STRATEGY_PHILOSOPHY =
  "Decision philosophy:\n" +
  "- One position at a time. When the scanner ranks a setup with " +
  "netEdgeBps >= 12 (after fees) AND the action is non-flat AND the " +
  "symbol is in the allowed list, OPEN — do not skip waiting for a " +
  "'perfect' setup that may never come. The operator already capped " +
  "your notional, so size is irrelevant to entry decision.\n" +
  "- Skip ONLY when: (a) topRankedSetups is empty, (b) all top setups " +
  "have action=flat, (c) all top setups have netEdgeBps < 8, or (d) " +
  "recent losing streak is >= 3 trades.\n" +
  "- When in position, prefer 'hold' unless there's a clear reason to " +
  "act. Avoid churn — every action costs fees (~5bps round-trip).\n" +
  "- Use 'tp-partial' to lock in gains while letting a runner ride. " +
  "Fraction must be 0.1-0.9.\n" +
  "- Use 'cut-loss' early when the thesis is invalidated; do NOT wait " +
  "for the hard SL to fire.\n" +
  "- Use 'open-hedge' only when you want to neutralize but not exit " +
  "(e.g. expecting short-term volatility against you). hedgeSymbol must " +
  "be in the allowed list.\n" +
  "- Use 'scale-in' only when conviction has grown AND price has " +
  "improved in your favor; never average down a loser.\n" +
  "- 'scale-out' is similar to 'tp-partial' but for partial de-risking.\n" +
  "- Reasoning must be concise (1-3 sentences). The operator reviews logs.";

const OPEN_OR_SKIP_TOOL = {
  name: "open_or_skip" as const,
  description:
    "Emit the entry decision. Either propose a new position to open, or skip this review window.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["open", "skip"],
      },
      symbol: {
        type: "string",
        description: "Required when action=open. Must be one of the allowed symbols listed in the user message.",
      },
      side: {
        type: "string",
        enum: ["long", "short"],
        description: "Required when action=open.",
      },
      notionalUsd: {
        type: "number",
        minimum: 0,
        description: "Required when action=open. USD notional of the position. Will be clamped to maxNotionalUsd.",
      },
      leverage: {
        type: "number",
        minimum: 1,
        description: "Required when action=open. Will be clamped to maxLeverage.",
      },
      targetPnlUsd: {
        type: "number",
        description: "Required when action=open. Your profit target in USD.",
      },
      maxLossUsd: {
        type: "number",
        minimum: 0,
        description: "Required when action=open. Per-position stop loss in USD. Will trigger forced cut-loss if breached.",
      },
      reasoning: {
        type: "string",
        description: "Concise (1-3 sentences) explanation.",
      },
    },
    required: ["action", "reasoning"],
  },
};

const MANAGE_POSITION_TOOL = {
  name: "manage_position" as const,
  description:
    "Emit the active-management decision for the currently open position.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: VALID_MANAGE_ACTIONS,
      },
      params: {
        type: "object",
        properties: {
          tpPartialFraction: {
            type: "number",
            minimum: 0.1,
            maximum: 0.9,
            description: "Required for tp-partial / scale-out. Fraction of qty to close. Will be clamped to [0.1, 0.9].",
          },
          hedgeSymbol: {
            type: "string",
            description: "Required for open-hedge. Must be in the allowed symbols list.",
          },
          scaleNotionalUsd: {
            type: "number",
            minimum: 0,
            description: "Required for scale-in. USD notional to add. Total notional capped at 2x maxNotionalUsd.",
          },
        },
      },
      reasoning: {
        type: "string",
        description: "Concise (1-3 sentences) explanation.",
      },
    },
    required: ["action", "reasoning"],
  },
};

// ── User payload builders (exported for prompt-content testing) ─────────────

export function buildOpenUserPayload(input: OpenDecisionInput): string {
  return [
    "Market regime snapshot:",
    JSON.stringify(input.market, null, 2),
    "",
    "Wallet + recent performance (last 24h):",
    JSON.stringify(
      {
        walletAvailableUsd: input.walletAvailableUsd,
        recentTrades: input.recentTrades,
        recentWinRate: input.recentWinRate,
        recentNetPnlUsd: input.recentNetPnlUsd,
      },
      null,
      2,
    ),
    "",
    "Hard operator limits (your response will be clamped to these):",
    JSON.stringify(
      {
        allowedSymbols: input.allowedSymbols,
        maxNotionalUsd: input.maxNotionalUsd,
        maxLeverage: input.maxLeverage,
      },
      null,
      2,
    ),
    "",
    "Emit your decision via the open_or_skip tool. Skip if no clear setup.",
  ].join("\n");
}

export function buildManageUserPayload(input: ManageDecisionInput): string {
  const recentDecisions = input.position.decisionsHistory.slice(-5);
  return [
    "Open position:",
    JSON.stringify(
      {
        symbol: input.position.symbol,
        side: input.position.side,
        entryPrice: input.position.entryPrice,
        qty: input.position.qty,
        notionalUsd: input.position.notionalUsd,
        leverage: input.position.leverage,
        openedAt: input.position.openedAt,
        targetPnlUsd: input.position.targetPnlUsd,
        maxLossUsd: input.position.maxLossUsd,
        entryReasoning: input.position.entryReasoning,
        hedge: input.position.hedge,
      },
      null,
      2,
    ),
    "",
    "Current snapshot:",
    JSON.stringify(
      {
        currentPrice: input.currentPrice,
        currentPnlUsd: input.currentPnlUsd,
        currentPnlBps: input.currentPnlBps,
        minutesHeld: input.minutesHeld,
        mfeUsd: input.position.mfeUsd,
        maeUsd: input.position.maeUsd,
      },
      null,
      2,
    ),
    "",
    "Recent decisions on this position (last 5):",
    JSON.stringify(recentDecisions, null, 2),
    "",
    "Market context:",
    JSON.stringify(input.market, null, 2),
    "",
    "Emit your decision via the manage_position tool. Default to 'hold' if no clear action.",
  ].join("\n");
}

// ── LLM-backed entrypoints ─────────────────────────────────────────────────

function safeOpenDefault(reason: string): OpenDecision {
  return { action: "skip", reasoning: `llm-managed-error: ${reason}` };
}

function safeManageDefault(reason: string): ManageDecision {
  return { action: "hold", reasoning: `llm-managed-error: ${reason}` };
}

/** Ask the LLM whether to open a new position. Safe-skip on any failure. */
export async function getOpenDecision(
  input: OpenDecisionInput,
): Promise<OpenDecision> {
  const model = input.model ?? DEFAULT_MODEL;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let client: AnthropicClientLike;
  if (input.anthropicClient) {
    client = input.anthropicClient;
  } else {
    if (!input.apiKey || input.apiKey.trim() === "") {
      return safeOpenDefault("missing ANTHROPIC_API_KEY");
    }
    client = new Anthropic({ apiKey: input.apiKey }) as unknown as AnthropicClientLike;
  }

  const userPayload = buildOpenUserPayload(input);
  const systemBlocks = [
    {
      type: "text" as const,
      text: SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" as const },
    },
    {
      type: "text" as const,
      text: STRATEGY_PHILOSOPHY,
      cache_control: { type: "ephemeral" as const },
    },
  ];

  let response;
  try {
    response = await withTimeout(
      client.messages.create({
        model,
        max_tokens: 1024,
        system: systemBlocks,
        tools: [OPEN_OR_SKIP_TOOL],
        tool_choice: { type: "tool", name: "open_or_skip" },
        messages: [{ role: "user", content: userPayload }],
      }),
      timeoutMs,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "llm-managed-timeout") return safeOpenDefault("timeout");
    return safeOpenDefault(msg);
  }

  const toolUse = response.content.find(
    (b): b is { type: "tool_use"; name: string; input: unknown } =>
      b.type === "tool_use" && (b as { name?: string }).name === "open_or_skip",
  );
  if (!toolUse) return safeOpenDefault("no tool_use block in response");

  const raw = toolUse.input as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") {
    return safeOpenDefault("malformed tool_use input");
  }
  const action = raw.action === "open" || raw.action === "skip" ? raw.action : null;
  if (!action) return safeOpenDefault(`invalid action: ${String(raw.action)}`);
  const reasoning = typeof raw.reasoning === "string" ? raw.reasoning : "";
  if (action === "skip") {
    return { action: "skip", reasoning };
  }
  // action === "open" — validate required fields.
  const symbol = typeof raw.symbol === "string" ? raw.symbol : undefined;
  const side = raw.side === "long" || raw.side === "short" ? raw.side : undefined;
  const notionalUsd =
    typeof raw.notionalUsd === "number" && Number.isFinite(raw.notionalUsd)
      ? Math.max(0, raw.notionalUsd)
      : undefined;
  const leverage =
    typeof raw.leverage === "number" && Number.isFinite(raw.leverage)
      ? Math.max(1, raw.leverage)
      : undefined;
  const targetPnlUsd =
    typeof raw.targetPnlUsd === "number" && Number.isFinite(raw.targetPnlUsd)
      ? raw.targetPnlUsd
      : undefined;
  const maxLossUsd =
    typeof raw.maxLossUsd === "number" && Number.isFinite(raw.maxLossUsd)
      ? Math.max(0, raw.maxLossUsd)
      : undefined;
  if (!symbol || !side || notionalUsd === undefined || leverage === undefined
      || targetPnlUsd === undefined || maxLossUsd === undefined) {
    return safeOpenDefault("open action missing required fields");
  }
  return {
    action: "open",
    symbol,
    side,
    notionalUsd,
    leverage,
    targetPnlUsd,
    maxLossUsd,
    reasoning,
  };
}

/** Ask the LLM how to manage an open position. Safe-hold on any failure. */
export async function getManageDecision(
  input: ManageDecisionInput,
): Promise<ManageDecision> {
  const model = input.model ?? DEFAULT_MODEL;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let client: AnthropicClientLike;
  if (input.anthropicClient) {
    client = input.anthropicClient;
  } else {
    if (!input.apiKey || input.apiKey.trim() === "") {
      return safeManageDefault("missing ANTHROPIC_API_KEY");
    }
    client = new Anthropic({ apiKey: input.apiKey }) as unknown as AnthropicClientLike;
  }

  const userPayload = buildManageUserPayload(input);
  const systemBlocks = [
    {
      type: "text" as const,
      text: SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" as const },
    },
    {
      type: "text" as const,
      text: STRATEGY_PHILOSOPHY,
      cache_control: { type: "ephemeral" as const },
    },
  ];

  let response;
  try {
    response = await withTimeout(
      client.messages.create({
        model,
        max_tokens: 1024,
        system: systemBlocks,
        tools: [MANAGE_POSITION_TOOL],
        tool_choice: { type: "tool", name: "manage_position" },
        messages: [{ role: "user", content: userPayload }],
      }),
      timeoutMs,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "llm-managed-timeout") return safeManageDefault("timeout");
    return safeManageDefault(msg);
  }

  const toolUse = response.content.find(
    (b): b is { type: "tool_use"; name: string; input: unknown } =>
      b.type === "tool_use"
      && (b as { name?: string }).name === "manage_position",
  );
  if (!toolUse) return safeManageDefault("no tool_use block in response");

  const raw = toolUse.input as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") {
    return safeManageDefault("malformed tool_use input");
  }
  const actionRaw = raw.action;
  if (typeof actionRaw !== "string"
      || !(VALID_MANAGE_ACTIONS as ReadonlyArray<string>).includes(actionRaw)) {
    return safeManageDefault(`invalid action: ${String(actionRaw)}`);
  }
  const action = actionRaw as ManageAction;
  const reasoning = typeof raw.reasoning === "string" ? raw.reasoning : "";

  // Parse + sanitize params per action.
  const paramsIn =
    raw.params && typeof raw.params === "object"
      ? (raw.params as Record<string, unknown>)
      : {};
  const out: ManageDecision = { action, reasoning };
  const outParams: ManageDecision["params"] = {};
  if (action === "tp-partial" || action === "scale-out") {
    const f = typeof paramsIn.tpPartialFraction === "number"
      && Number.isFinite(paramsIn.tpPartialFraction)
      ? paramsIn.tpPartialFraction
      : 0.5;
    outParams.tpPartialFraction = clamp(f, 0.1, 0.9);
  }
  if (action === "open-hedge") {
    if (typeof paramsIn.hedgeSymbol === "string" && paramsIn.hedgeSymbol.length > 0) {
      outParams.hedgeSymbol = paramsIn.hedgeSymbol;
    }
  }
  if (action === "scale-in") {
    if (typeof paramsIn.scaleNotionalUsd === "number"
        && Number.isFinite(paramsIn.scaleNotionalUsd)
        && paramsIn.scaleNotionalUsd > 0) {
      outParams.scaleNotionalUsd = paramsIn.scaleNotionalUsd;
    }
  }
  if (Object.keys(outParams).length > 0) {
    out.params = outParams;
  }
  return out;
}

// Exposed for tests that want to assert on prompt-content / cache-control.
export const __INTERNAL = {
  SYSTEM_PROMPT,
  STRATEGY_PHILOSOPHY,
  OPEN_OR_SKIP_TOOL,
  MANAGE_POSITION_TOOL,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
};
