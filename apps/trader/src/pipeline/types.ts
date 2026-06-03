/**
 * Phase 3 pipeline — shared contracts for the scan → evaluate → agent flow.
 *
 * Two extension points, both keyed by strategy name:
 *   - StrategyEvaluator: STATELESS. Reads market + config, returns intents.
 *     No order placement, no queue writes, no position-state reads.
 *   - ExecutionAdapter: the per-strategy half of the single trading-agent.
 *     Places the order(s) and enqueues the manage job for one intent.
 */

import type { TradingIntent } from "@ai-scalper/queueing";
import type { createBybitClient } from "@ai-scalper/bybit-client";
import type { TickerSource } from "@ai-scalper/bybit-client/ticker-source";
import type { TraderConfig } from "../config";
import type { WebhookAlerter } from "../alerts/webhook";
import type { StrategySharedState } from "../strategies/shared/bullmq-shared-state";
import type { CalendarRotator } from "./calendar-rotator";

export type BybitClient = ReturnType<typeof createBybitClient>;

/** Generic enqueue surface — matches BullMQ Queue#add and test stubs. */
export interface QueueLike<TData> {
  add(name: string, data: TData, opts?: Record<string, unknown>): Promise<unknown>;
}

// ── Stage 2: evaluate ────────────────────────────────────────────────────

export interface StrategyEvaluatorContext {
  config: TraderConfig;
  client: BybitClient;
  tickerSource: TickerSource;
  now: number;
  log: (payload: Record<string, unknown>) => void;
  /** Optional auto-rotator for the dated leg of calendar-spread. */
  calendarRotator?: CalendarRotator | null;
}

/**
 * A stateless evaluator: given the live market snapshot + config, return zero
 * or more intents. Returning [] means "nothing to do this tick".
 */
export type StrategyEvaluator = (
  ctx: StrategyEvaluatorContext,
) => Promise<TradingIntent[]>;

// ── Stage 3: trading-agent ────────────────────────────────────────────────

export interface ExecutionAdapterContext {
  config: TraderConfig;
  client: BybitClient;
  /** Required for maker-with-timeout execution (best bid/ask discovery). */
  tickerSource: TickerSource;
  alerter: WebhookAlerter;
  /** The manage queue resolved for this intent's strategy. */
  manageQueue: QueueLike<Record<string, unknown>>;
  sharedState: StrategySharedState;
  now: number;
  log: (payload: Record<string, unknown>) => void;
}

export type ExecutionResult =
  | { status: "opened"; positionId: string; symbol: string }
  | { status: "compensated"; reason: string }
  | { status: "skipped"; reason: string };

/**
 * The per-strategy executor. Places the order(s) for the intent and enqueues
 * the strategy's manage job. The one-position invariant is enforced by the
 * trading-agent processor BEFORE the adapter runs, so adapters assume they are
 * cleared to act.
 */
export type ExecutionAdapter = (
  intent: TradingIntent,
  ctx: ExecutionAdapterContext,
) => Promise<ExecutionResult>;
