export const QUEUE_NAMES = {
  marketScan: "market-scan",
  paperSession: "paper-session",
  liveSession: "live-session",
  /**
   * Phase 1 (llm-managed PoC) — recurring open-tick lives here.
   * One repeatable job ("llm-managed:open-tick") asks the LLM whether to
   * open a position every llmManagedOpenReviewIntervalSec.
   */
  llmManagedOpenDecision: "llm-managed:open-decision",
  /**
   * Phase 1 (llm-managed PoC) — one job per LIVE position. The job carries
   * the full LlmManagedManageJobData state and re-fires every
   * llmManagedManageReviewIntervalSec via BullMQ repeat options. Job
   * completes (no rescheduling) when the position is fully closed.
   */
  llmManagedTradeManagement: "llm-managed:trade-management",
} as const;

export const JOB_NAMES = {
  marketScanRun: "market-scan.run",
  paperSessionStart: "paper-session.start",
  liveSessionStart: "live-session.start",
  /** Recurring open-decision tick. Single deterministic jobId. */
  llmManagedOpenTick: "llm-managed:open-tick",
  /** Per-position manage tick. jobId derived from the position id. */
  llmManagedManageTick: "llm-managed:manage-tick",
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
