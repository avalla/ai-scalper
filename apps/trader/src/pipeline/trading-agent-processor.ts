/**
 * Stage 3 — trading-agent processor.
 *
 * A SINGLE intent-driven executor. Per-strategy behaviour (single-leg vs
 * two-leg orders, manage-job shape) lives in the ExecutionAdapter selected by
 * `intent.strategy`. The agent itself owns the cross-strategy invariant:
 * enforce one active position before any adapter places an order.
 */

import type { TradingAgentJobData } from "@ai-scalper/queueing";
import type { TickerSource } from "@ai-scalper/bybit-client/ticker-source";
import type { TraderConfig } from "../config";
import type { WebhookAlerter } from "../alerts/webhook";
import type { StrategySharedState } from "../strategies/shared/bullmq-shared-state";
import type {
  BybitClient,
  ExecutionAdapter,
  ExecutionResult,
  QueueLike,
} from "./types";

export interface TradingAgentProcessorDeps {
  config: TraderConfig;
  client: BybitClient;
  tickerSource: TickerSource;
  alerter: WebhookAlerter;
  sharedState: StrategySharedState;
  /** Strategy name → execution adapter. */
  registry: Record<string, ExecutionAdapter>;
  /** Strategy name → its manage queue. */
  manageQueues: Record<string, QueueLike<Record<string, unknown>>>;
  log?: (payload: Record<string, unknown>) => void;
  now?: () => number;
}

export async function processTradingAgentExecute(
  jobData: TradingAgentJobData,
  deps: TradingAgentProcessorDeps,
): Promise<ExecutionResult> {
  const { config, client, tickerSource, alerter, sharedState, registry, manageQueues } = deps;
  const log = deps.log ?? ((p) => console.log(JSON.stringify(p)));
  const now = (deps.now ?? Date.now)();
  const observedAt = new Date(now).toISOString();
  const { intent } = jobData;

  // Cross-strategy one-position invariant — the agent is the single gate.
  if (await sharedState.hasActivePosition()) {
    log({ ts: observedAt, event: "trading-agent-skip", strategy: intent.strategy, reason: "active-position-exists" });
    return { status: "skipped", reason: "active-position-exists" };
  }

  const adapter = registry[intent.strategy];
  const manageQueue = manageQueues[intent.strategy];
  if (!adapter || !manageQueue) {
    log({ ts: observedAt, event: "trading-agent-skip", strategy: intent.strategy, reason: "no-adapter" });
    return { status: "skipped", reason: "no-adapter" };
  }

  try {
    return await adapter(intent, { config, client, tickerSource, alerter, manageQueue, sharedState, now, log });
  } catch (err) {
    log({
      ts: observedAt, event: "trading-agent-error", strategy: intent.strategy,
      symbol: intent.symbol, error: err instanceof Error ? err.message : String(err),
    });
    await alerter.send(`trading-agent error (${intent.strategy} ${intent.symbol})`).catch(() => {});
    return { status: "skipped", reason: "adapter-error" };
  }
}
