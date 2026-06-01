export const QUEUE_NAMES = {
  marketScan: "market-scan",
  paperSession: "paper-session",
  liveSession: "live-session",
  /**
   * Phase 1 (llm-managed PoC) — recurring open-tick lives here.
   * One repeatable job ("llm-managed-open-tick") asks the LLM whether to
   * open a position every llmManagedOpenReviewIntervalSec.
   */
  llmManagedOpenDecision: "llm-managed-open-decision",
  /**
   * Phase 1 (llm-managed PoC) — one job per LIVE position. The job carries
   * the full LlmManagedManageJobData state and re-fires every
   * llmManagedManageReviewIntervalSec via BullMQ repeat options. Job
   * completes (no rescheduling) when the position is fully closed.
   */
  llmManagedTradeManagement: "llm-managed-trade-management",
  // ── Phase 2 — per-strategy open-decision + trade-management queues. ─────
  fundingArbOpenDecision: "funding-arb-open-decision",
  fundingArbTradeManagement: "funding-arb-trade-management",
  longerTfOpenDecision: "longer-tf-open-decision",
  longerTfTradeManagement: "longer-tf-trade-management",
  bollingerAdxOpenDecision: "bollinger-adx-open-decision",
  bollingerAdxTradeManagement: "bollinger-adx-trade-management",
  basisArbOpenDecision: "basis-arb-open-decision",
  basisArbTradeManagement: "basis-arb-trade-management",
  pairsTradingOpenDecision: "pairs-trading-open-decision",
  pairsTradingTradeManagement: "pairs-trading-trade-management",
  calendarSpreadOpenDecision: "calendar-spread-open-decision",
  calendarSpreadTradeManagement: "calendar-spread-trade-management",
  maCrossoverOpenDecision: "ma-crossover-open-decision",
  maCrossoverTradeManagement: "ma-crossover-trade-management",
  liquidationCascadeOpenDecision: "liquidation-cascade-open-decision",
  liquidationCascadeTradeManagement: "liquidation-cascade-trade-management",
  // ── Phase 3 — scan → evaluate → agent pipeline. ────────────────────────
  // One shared evaluate queue (fan-out per strategy via job name) and one
  // shared trading-agent queue (single intent-driven executor).
  strategyEvaluate: "strategy-evaluate",
  tradingAgent: "trading-agent",
} as const;

export const JOB_NAMES = {
  marketScanRun: "market-scan.run",
  paperSessionStart: "paper-session.start",
  liveSessionStart: "live-session.start",
  /** Recurring open-decision tick. Single deterministic jobId. */
  llmManagedOpenTick: "llm-managed-open-tick",
  /** Per-position manage tick. jobId derived from the position id. */
  llmManagedManageTick: "llm-managed-manage-tick",
  // ── Phase 2 — open/manage tick names per strategy. ─────────────────────
  fundingArbOpenTick: "funding-arb-open-tick",
  fundingArbManageTick: "funding-arb-manage-tick",
  longerTfOpenTick: "longer-tf-open-tick",
  longerTfManageTick: "longer-tf-manage-tick",
  bollingerAdxOpenTick: "bollinger-adx-open-tick",
  bollingerAdxManageTick: "bollinger-adx-manage-tick",
  basisArbOpenTick: "basis-arb-open-tick",
  basisArbManageTick: "basis-arb-manage-tick",
  pairsTradingOpenTick: "pairs-trading-open-tick",
  pairsTradingManageTick: "pairs-trading-manage-tick",
  calendarSpreadOpenTick: "calendar-spread-open-tick",
  calendarSpreadManageTick: "calendar-spread-manage-tick",
  maCrossoverOpenTick: "ma-crossover-open-tick",
  maCrossoverManageTick: "ma-crossover-manage-tick",
  liquidationCascadeOpenTick: "liquidation-cascade-open-tick",
  liquidationCascadeManageTick: "liquidation-cascade-manage-tick",
  // ── Phase 3 — pipeline job names. ──────────────────────────────────────
  // The evaluate job name is suffixed with the strategy at enqueue time
  // (e.g. "strategy-evaluate.funding-arb") so Bull Board groups per strategy.
  strategyEvaluateTick: "strategy-evaluate.tick",
  tradingAgentExecute: "trading-agent.execute",
} as const;

export interface MarketScanJobData {
  requestedAt: string;
  trigger: "manual" | "cli" | "schedule";
}

export interface TraderSessionJobData {
  entryExecutionMode: "taker" | "maker-entry" | "maker-preferred-with-timeout";
  paperTrading: boolean;
  requestedAt: string;
  tradingProfile: "standard" | "aggressive-perps";
  trigger: "manual" | "cli" | "schedule";
 }

/**
 * Phase 1 PoC: data sent with the recurring "open-tick" job.  The worker
 * pulls all other state from Redis / TraderConfig — this payload is just an
 * audit + dedup vehicle.
 */
export interface LlmManagedOpenTickJobData {
  /** ISO timestamp the recurring scheduler fired this tick. */
  triggeredAt: string;
  /** Name of the TraderConfig JSON the worker was launched against (audit). */
  configFile: string;
}

/**
 * Phase 1 PoC: persisted state for ONE live llm-managed position. This is
 * the canonical state. Manage worker uses `job.updateData(...)` to mutate
 * mfe/mae/qty/decisionsHistory/hedge as the position evolves. Job completes
 * (no further repeat) on tp-full / cut-loss / external-close / max-hold.
 */
export interface LlmManagedManageJobData {
  /**
   * Unique id for the position — used to dedup BullMQ jobs and as a
   * cross-process correlation key in logs / alerts. Format:
   * `llm-managed-position:${epochMs}-${symbol}`.
   */
  positionId: string;
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  qty: number;
  /** Bybit lot step (e.g. "0.001"). */
  qtyStep: string;
  /** Bybit min order qty. */
  minOrderQty: string;
  /** USD notional of the primary leg (margin, not exposure). */
  notionalUsd: number;
  leverage: number;
  /** ISO timestamp the position was opened. */
  openedAt: string;
  targetPnlUsd: number;
  maxLossUsd: number;
  entryReasoning: string;
  /** Max favorable excursion (PnL USD high-water mark). */
  mfeUsd: number;
  /** Max adverse excursion (PnL USD low-water mark, signed). */
  maeUsd: number;
  decisionsHistory: Array<{ at: string; action: string; reasoning: string }>;
  hedge: {
    symbol: string;
    side: "long" | "short";
    entryPrice: number;
    qty: number;
    notionalUsd: number;
    /** ISO timestamp. */
    openedAt: string;
  } | null;
  /** ISO timestamp of the most recent manage review (LLM call OR safety). */
  lastReviewAt: string;
}

export const DEFAULT_JOB_POLICY = {
  attempts: 3,
  removeOnComplete: 20,
  removeOnFail: 50,
  backoff: {
    type: "exponential" as const,
    delay: 1_000,
  },
};

/**
 * Job policy for user-money-touching llm-managed jobs.
 *   - attempts:1 (NO auto-retry on order placement — the manage tick auto-
 *     repeats on its own schedule, and a stuck attempt can over-trade).
 *   - retain more for operator visibility in Bull Board.
 */
export const LLM_MANAGED_JOB_POLICY = {
  attempts: 1,
  removeOnComplete: 50,
  removeOnFail: 50,
} as const;

/**
 * Phase 2 — same conservative policy applied to all per-strategy trade
 * queues. Money-touching jobs never auto-retry; they re-fire on the
 * recurring schedule instead.
 */
export const STRATEGY_JOB_POLICY = {
  attempts: 1,
  removeOnComplete: 50,
  removeOnFail: 50,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — shared decision-history row used by every per-strategy
// trade-management job. Kept intentionally minimal so the type can flow
// across strategy modules without leaking strategy-specific fields.
// ─────────────────────────────────────────────────────────────────────────────
export interface StrategyDecisionRow {
  /** ISO timestamp. */
  at: string;
  action: string;
  reasoning: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// funding-arb (single-leg, time-gated)
// ─────────────────────────────────────────────────────────────────────────────
export interface FundingArbOpenTickJobData {
  triggeredAt: string;
  configFile: string;
}

export interface FundingArbManageJobData {
  positionId: string;
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  qty: number;
  qtyStep: string;
  minOrderQty: string;
  notionalUsd: number;
  leverage: number;
  openedAt: string;
  /** Funding-rate (bps) the entry was attributed to. */
  fundingRateAtEntryBps: number;
  /** Funding event the position is held for (epoch ms). */
  fundingTimeTarget: number;
  decisionsHistory: StrategyDecisionRow[];
  lastReviewAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// longer-tf (single-leg, kline-MA)
// ─────────────────────────────────────────────────────────────────────────────
export interface LongerTfOpenTickJobData {
  triggeredAt: string;
  configFile: string;
}

export interface LongerTfManageJobData {
  positionId: string;
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  qty: number;
  qtyStep: string;
  minOrderQty: string;
  notionalUsd: number;
  leverage: number;
  openedAt: string;
  /** Static SL/TP prices set at entry. */
  stopLossPrice: number;
  takeProfitPrice: number;
  entryReasoning: string;
  decisionsHistory: StrategyDecisionRow[];
  lastReviewAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// bollinger-adx (single-leg, regime-filtered)
// ─────────────────────────────────────────────────────────────────────────────
export interface BollingerAdxOpenTickJobData {
  triggeredAt: string;
  configFile: string;
}

export interface BollingerAdxManageJobData {
  positionId: string;
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  qty: number;
  qtyStep: string;
  minOrderQty: string;
  notionalUsd: number;
  leverage: number;
  openedAt: string;
  stopLossPrice: number;
  takeProfitPrice: number;
  entryRegime: "ranging" | "trending" | "unknown";
  entryReasoning: string;
  decisionsHistory: StrategyDecisionRow[];
  lastReviewAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// basis-arb (two-leg — perp + spot, same symbol)
// ─────────────────────────────────────────────────────────────────────────────
export interface BasisArbOpenTickJobData {
  triggeredAt: string;
  configFile: string;
}

export interface BasisArbManageJobData {
  positionId: string;
  /** Underlying symbol (same on both legs). */
  symbol: string;
  perpSide: "long" | "short";
  spotSide: "long" | "short";
  perpEntryPrice: number;
  spotEntryPrice: number;
  qty: number;
  qtyStep: string;
  minOrderQty: string;
  notionalUsd: number;
  openedAt: string;
  entryBasisBps: number;
  fundingRateAtEntryBps: number;
  decisionsHistory: StrategyDecisionRow[];
  lastReviewAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// pairs-trading (two-leg — leg1 + leg2 across symbols)
// ─────────────────────────────────────────────────────────────────────────────
export interface PairsTradingOpenTickJobData {
  triggeredAt: string;
  configFile: string;
}

export interface PairsTradingManageJobData {
  positionId: string;
  leg1Symbol: string;
  leg1Side: "long" | "short";
  leg1EntryPrice: number;
  leg1Qty: number;
  leg2Symbol: string;
  leg2Side: "long" | "short";
  leg2EntryPrice: number;
  leg2Qty: number;
  hedgeRatio: number;
  entryZ: number;
  notionalPerLegUsd: number;
  openedAt: string;
  decisionsHistory: StrategyDecisionRow[];
  lastReviewAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// calendar-spread (two-leg — perp + dated)
// ─────────────────────────────────────────────────────────────────────────────
export interface CalendarSpreadOpenTickJobData {
  triggeredAt: string;
  configFile: string;
}

export interface CalendarSpreadManageJobData {
  positionId: string;
  perpSymbol: string;
  datedSymbol: string;
  perpSide: "long" | "short";
  datedSide: "long" | "short";
  perpEntryPrice: number;
  datedEntryPrice: number;
  qty: number;
  qtyStep: string;
  minOrderQty: string;
  notionalPerLegUsd: number;
  openedAt: string;
  entrySpreadBps: number;
  datedDeliveryAt: number;
  decisionsHistory: StrategyDecisionRow[];
  lastReviewAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// ma-crossover (single-leg + bandit/meta)
// ─────────────────────────────────────────────────────────────────────────────
export interface MaCrossoverOpenTickJobData {
  triggeredAt: string;
  configFile: string;
}

export interface MaCrossoverManageJobData {
  positionId: string;
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  qty: number;
  qtyStep: string;
  minOrderQty: string;
  notionalUsd: number;
  leverage: number;
  openedAt: string;
  /** Champion variant id at entry — used for bandit attribution on close. */
  championIdAtEntry: string;
  /** Champion params snapshot used for SL/TP throughout the position's life. */
  championParams: {
    fastWindow: number;
    slowWindow: number;
    thresholdBps: number;
    stopLossBps: number;
    takeProfitBps: number;
  };
  stopLossPrice: number;
  takeProfitPrice: number;
  entryReasoning: string;
  decisionsHistory: StrategyDecisionRow[];
  lastReviewAt: string;
}

// liquidation-cascade (single-leg, cluster-trigger mean-reversion)
export interface LiquidationCascadeOpenTickJobData {
  triggeredAt: string;
  configFile: string;
}

export interface LiquidationCascadeManageJobData {
  positionId: string;
  symbol: string;
  side: "long" | "short";
  qty: number;
  qtyStep: string;
  minOrderQty: string;
  entryPrice: number;
  notionalUsd: number;
  leverage: number;
  openedAt: string;
  stopLossPrice: number;
  takeProfitPrice: number;
  /** Time-based exit horizon (seconds since open). */
  maxHoldSec: number;
  decisionsHistory: StrategyDecisionRow[];
  lastReviewAt: string;
}

// ── Phase 3 — scan → evaluate → trading-agent pipeline contract. ─────────
//
// The pipeline splits the legacy "open-processor" (decide + place order +
// enqueue manage) into two stages:
//
//   [2] strategy-evaluate  — STATELESS. Reads scan-latest + config + a live
//       market snapshot, returns zero or more TradingIntent. Places NO orders
//       and touches NO queues. One job name per strategy (fan-out).
//
//   [3] trading-agent      — single intent-driven executor. Per-strategy
//       ExecutionAdapter places the order(s) and enqueues the manage job. The
//       agent is one worker; customization lives in the adapter selected by
//       `intent.strategy`.

/** One order leg of an intent. Single-leg strategies emit one; arb/pairs two. */
export interface TradingIntentLeg {
  symbol: string;
  side: "long" | "short";
  category: "linear" | "spot" | "inverse";
  /** Floored-to-step quantity (base units). */
  qty: number;
  /** Same qty as the exchange-formatted string. */
  qtyStr: string;
  /** Reference price observed at evaluation time. */
  refPrice: number;
}

/**
 * The contract between stage 2 (evaluate) and stage 3 (agent). Carries the
 * common execution surface plus an opaque `managePayload` the strategy's
 * adapter uses to build its strategy-specific manage-job data.
 */
export interface TradingIntent {
  /** Dispatch key — selects the trading-agent ExecutionAdapter. */
  strategy: string;
  /** Primary / underlying symbol (single-leg or arb underlying). */
  symbol: string;
  legs: TradingIntentLeg[];
  notionalUsd: number;
  leverage: number;
  reason: string;
  /** ISO timestamp the evaluator produced this intent. */
  evaluatedAt: string;
  /**
   * Strategy-specific data the agent's adapter consumes to construct the
   * manage-job payload (e.g. fundingTimeTarget, entryBasisBps, SL/TP prices).
   * Kept opaque so the contract stays strategy-agnostic.
   */
  managePayload: Record<string, unknown>;
}

/** Recurring evaluate tick — stage 2. Audit/dedup vehicle only. */
export interface StrategyEvaluateJobData {
  /** Which strategy this tick evaluates (also the job-name suffix). */
  strategy: string;
  triggeredAt: string;
  configFile: string;
}

/** Stage 3 — one job per emitted intent. */
export interface TradingAgentJobData {
  intent: TradingIntent;
  /** ISO timestamp the evaluator enqueued this intent. */
  enqueuedAt: string;
}
