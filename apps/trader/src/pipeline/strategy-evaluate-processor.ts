/**
 * Stage 2 — strategy-evaluate processor.
 *
 * Recurring tick (one per strategy). Looks up the strategy's evaluator,
 * runs it against the live market, and enqueues one trading-agent job per
 * emitted intent. STATELESS: no position reads, no order placement.
 *
 * The agent job is deduplicated per (strategy, symbol) within a tick window so
 * a slow agent doesn't get a backlog of identical intents.
 */

import {
  JOB_NAMES,
  STRATEGY_JOB_POLICY,
  type StrategyEvaluateJobData,
  type TradingAgentJobData,
  type TradingIntent,
} from "@ai-scalper/queueing";
import type { TraderConfig } from "../config";
import type { TickerSource } from "@ai-scalper/bybit-client/ticker-source";
import type { BybitClient, QueueLike, StrategyEvaluator } from "./types";
import type { CalendarRotator } from "./calendar-rotator";

export interface StrategyEvaluateProcessorDeps {
  config: TraderConfig;
  client: BybitClient;
  tickerSource: TickerSource;
  /** Strategy name → evaluator. */
  registry: Record<string, StrategyEvaluator>;
  /** The shared trading-agent queue intents are pushed to. */
  intentQueue: QueueLike<TradingAgentJobData>;
  /** Optional — passed through to evaluators (currently only calendar-spread). */
  calendarRotator?: CalendarRotator | null;
  log?: (payload: Record<string, unknown>) => void;
  now?: () => number;
}

export type StrategyEvaluateTickResult =
  | { status: "skipped"; reason: string }
  | { status: "evaluated"; strategy: string; intentCount: number };

export async function processStrategyEvaluateTick(
  jobData: StrategyEvaluateJobData,
  deps: StrategyEvaluateProcessorDeps,
): Promise<StrategyEvaluateTickResult> {
  const { config, client, tickerSource, registry, intentQueue } = deps;
  const log = deps.log ?? ((p) => console.log(JSON.stringify(p)));
  const now = (deps.now ?? Date.now)();
  const observedAt = new Date(now).toISOString();

  const evaluator = registry[jobData.strategy];
  if (!evaluator) {
    log({ ts: observedAt, event: "strategy-evaluate-skip", strategy: jobData.strategy, reason: "no-evaluator" });
    return { status: "skipped", reason: "no-evaluator" };
  }

  let intents: TradingIntent[];
  try {
    intents = await evaluator({ config, client, tickerSource, now, log, calendarRotator: deps.calendarRotator });
  } catch (err) {
    log({
      ts: observedAt, event: "strategy-evaluate-error", strategy: jobData.strategy,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "skipped", reason: "evaluator-error" };
  }

  for (const intent of intents) {
    const data: TradingAgentJobData = { intent, enqueuedAt: observedAt };
    await intentQueue.add(JOB_NAMES.tradingAgentExecute, data, {
      ...STRATEGY_JOB_POLICY,
      // The jobId dedups only IN-FLIGHT duplicates (one pending/active agent
      // job per strategy+symbol) so a slow agent doesn't accumulate a backlog.
      // removeOnComplete/Fail:true is required so a finished job does NOT keep
      // its id reserved — otherwise the strategy could never re-enter after its
      // first trade (the agent's hasActivePosition gate prevents over-trading
      // while a position is actually open).
      jobId: `intent:${intent.strategy}:${intent.symbol}`,
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  log({
    ts: observedAt, event: "strategy-evaluated",
    strategy: jobData.strategy, intentCount: intents.length,
  });
  return { status: "evaluated", strategy: jobData.strategy, intentCount: intents.length };
}
