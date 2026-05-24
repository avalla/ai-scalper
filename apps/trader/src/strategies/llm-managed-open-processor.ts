/**
 * llm-managed OPEN-DECISION processor (Phase 1 BullMQ migration PoC).
 *
 * Pure, fully-DI'd function that the worker entry wraps in a BullMQ Worker.
 * On each tick:
 *   1. Skip if a live trade-management job already exists (1-position invariant).
 *   2. Skip if we're still inside the cooldown after a recent cut-loss.
 *   3. Otherwise call getOpenDecision(...), and on action=open place the
 *      entry order + enqueue a manage job in the trade-management queue.
 *
 * I/O routes through injected deps so tests don't need a real Redis / Bybit.
 */

import {
  JOB_NAMES,
  LLM_MANAGED_JOB_POLICY,
  type LlmManagedManageJobData,
  type LlmManagedOpenTickJobData,
} from "@ai-scalper/queueing";

/**
 * Structural shape of the small slice of `bullmq.Queue` the processor uses.
 * Avoids a hard `bullmq` dep in the trader package — the worker app passes
 * a real `Queue<LlmManagedManageJobData>` here at runtime.
 */
export interface ManageQueueLike {
  add(
    name: string,
    data: LlmManagedManageJobData,
    opts?: Record<string, unknown>,
  ): Promise<unknown>;
}
import type { createBybitClient } from "@ai-scalper/bybit-client";
import type { TraderConfig } from "../config";
import type { WebhookAlerter } from "../alerts/webhook";
import {
  getOpenDecision as defaultGetOpenDecision,
  type LlmManagedMarketContext,
  type OpenDecision,
} from "./llm-managed";
import type { LlmManagedSharedState } from "./llm-managed-redis";

type BybitClient = ReturnType<typeof createBybitClient>;

export interface LlmManagedOpenProcessorDeps {
  config: TraderConfig;
  client: BybitClient;
  alerter: WebhookAlerter;
  /** Queue used to enqueue the new manage job on a successful open. */
  manageQueue: ManageQueueLike;
  sharedState: LlmManagedSharedState;
  /** Snapshot of market context for the LLM. */
  collectMarketContext: (observedAt: string) => Promise<LlmManagedMarketContext>;
  /** Recent perf used by the LLM prompt. */
  collectRecentPerformance: () => Promise<{ trades: number; winRate: number; netPnlUsd: number }>;
  /** Wallet helper for the LLM prompt. */
  collectWallet: () => Promise<{ availableUsd: number }>;
  /** Injectable for tests; defaults to the real Anthropic-backed getOpenDecision. */
  getOpenDecisionFn?: typeof defaultGetOpenDecision;
  /** Optional logger; defaults to console.log + JSON.stringify. */
  log?: (payload: Record<string, unknown>) => void;
  /** Optional clock; defaults to Date.now. */
  now?: () => number;
  /** Optional env accessor for ANTHROPIC_API_KEY. */
  env?: NodeJS.ProcessEnv;
}

export type LlmManagedOpenTickResult =
  | { status: "skipped"; reason: string }
  | {
      status: "opened";
      positionId: string;
      symbol: string;
      side: "long" | "short";
      qty: number;
      entryPrice: number;
      notionalUsd: number;
      leverage: number;
    };

export async function processLlmManagedOpenTick(
  jobData: LlmManagedOpenTickJobData,
  deps: LlmManagedOpenProcessorDeps,
): Promise<LlmManagedOpenTickResult> {
  const {
    config, client, alerter, manageQueue, sharedState,
    collectMarketContext, collectRecentPerformance, collectWallet,
  } = deps;
  const getOpenDecisionFn = deps.getOpenDecisionFn ?? defaultGetOpenDecision;
  const log = deps.log ?? ((payload) => console.log(JSON.stringify(payload)));
  const now = (deps.now ?? Date.now)();
  const env = deps.env ?? process.env;
  const observedAt = jobData.triggeredAt;

  // ── (1) 1-position invariant ─────────────────────────────────────────────
  if (await sharedState.hasActivePosition()) {
    log({ ts: observedAt, event: "llm-managed-open-skip", reason: "active-position-exists" });
    return { status: "skipped", reason: "active-position-exists" };
  }

  // ── (2) cooldown ─────────────────────────────────────────────────────────
  const remaining = await sharedState.getCooldownRemainingMs(now, config.llmManagedPostCutLossCooldownMs);
  if (remaining > 0) {
    log({ ts: observedAt, event: "llm-managed-open-skip", reason: "cooldown", msRemaining: remaining });
    return { status: "skipped", reason: "cooldown" };
  }

  // ── (3) contexts ─────────────────────────────────────────────────────────
  const [market, perf, wallet] = await Promise.all([
    collectMarketContext(observedAt),
    collectRecentPerformance(),
    collectWallet(),
  ]);

  // ── (4) LLM open decision ───────────────────────────────────────────────
  let decision: OpenDecision;
  try {
    decision = await getOpenDecisionFn({
      market,
      walletAvailableUsd: wallet.availableUsd,
      recentTrades: perf.trades,
      recentWinRate: perf.winRate,
      recentNetPnlUsd: perf.netPnlUsd,
      allowedSymbols: config.llmManagedAllowedSymbols,
      maxNotionalUsd: config.llmManagedMaxNotionalUsd,
      maxLeverage: config.llmManagedMaxLeverage,
      apiKey: env.ANTHROPIC_API_KEY,
      model: config.llmManagedModel,
      timeoutMs: config.llmManagedTimeoutMs,
    });
  } catch (err) {
    log({
      ts: observedAt,
      event: "llm-managed-open-error",
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "skipped", reason: "llm-error" };
  }

  log({
    ts: observedAt,
    event: "llm-managed-open-decision",
    action: decision.action,
    symbol: decision.symbol,
    side: decision.side,
    reasoning: decision.reasoning,
  });

  if (decision.action !== "open") {
    return { status: "skipped", reason: `llm-${decision.action}` };
  }

  // ── (5) Validate + clamp the LLM's request ──────────────────────────────
  const symbol = decision.symbol;
  if (!symbol || !config.llmManagedAllowedSymbols.includes(symbol)) {
    log({ ts: observedAt, event: "llm-managed-open-rejected", reason: "symbol-not-allowed", symbol });
    await alerter.send(`llm-managed open rejected: symbol-not-allowed (${String(symbol)})`).catch(() => {});
    return { status: "skipped", reason: "symbol-not-allowed" };
  }
  const side = decision.side;
  if (side !== "long" && side !== "short") {
    log({ ts: observedAt, event: "llm-managed-open-rejected", reason: "invalid-side" });
    return { status: "skipped", reason: "invalid-side" };
  }
  const clampedNotional = Math.min(
    decision.notionalUsd ?? config.llmManagedMaxNotionalUsd,
    config.llmManagedMaxNotionalUsd,
  );
  const clampedLeverage = Math.max(1, Math.min(
    decision.leverage ?? config.llmManagedMaxLeverage,
    config.llmManagedMaxLeverage,
  ));
  if (clampedNotional <= 0) {
    log({ ts: observedAt, event: "llm-managed-open-rejected", reason: "non-positive-notional" });
    return { status: "skipped", reason: "non-positive-notional" };
  }

  // ── (6) Fetch entry price + instrument info ─────────────────────────────
  let entryPrice = 0;
  try {
    const t = await client.getTicker({ category: "linear", symbol });
    entryPrice = Number(t.lastPrice);
  } catch (err) {
    log({
      ts: observedAt,
      event: "llm-managed-open-rejected",
      reason: "ticker-unavailable",
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "skipped", reason: "ticker-unavailable" };
  }
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return { status: "skipped", reason: "ticker-invalid" };
  }

  let instrumentInfo;
  try {
    instrumentInfo = await client.getInstrumentInfo({ category: "linear", symbol });
  } catch (err) {
    log({
      ts: observedAt,
      event: "llm-managed-open-rejected",
      reason: "instrument-info-unavailable",
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "skipped", reason: "instrument-info-unavailable" };
  }

  // ── (7) Compute qty (notional × leverage) / price, floored to step ─────
  const totalExposureUsd = clampedNotional * clampedLeverage;
  const step = Number(instrumentInfo.lotSizeFilter.qtyStep);
  const minQty = Number(instrumentInfo.lotSizeFilter.minOrderQty);
  const decimals = (instrumentInfo.lotSizeFilter.qtyStep.split(".")[1] ?? "").length;
  const rawQty = entryPrice > 0 ? totalExposureUsd / entryPrice : 0;
  const qty = step > 0 ? Math.floor(rawQty / step) * step : rawQty;
  if (!Number.isFinite(qty) || qty <= 0 || qty < minQty) {
    log({
      ts: observedAt,
      event: "llm-managed-open-rejected",
      reason: "qty-below-min",
      qty, minQty,
    });
    return { status: "skipped", reason: "qty-below-min" };
  }
  const qtyStr = qty.toFixed(decimals);

  // ── (8) Live order placement (paper mode bypasses) ──────────────────────
  if (!config.paperTrading) {
    try {
      await client.setLeverage({
        category: "linear",
        symbol,
        buyLeverage: String(clampedLeverage),
        sellLeverage: String(clampedLeverage),
      });
    } catch (err) {
      log({
        ts: observedAt,
        event: "llm-managed-set-leverage-failed",
        symbol,
        error: err instanceof Error ? err.message : String(err),
      });
      // Continue — Bybit may already have set the requested leverage.
    }
    try {
      await client.createOrder({
        category: "linear",
        symbol,
        side: side === "long" ? "Buy" : "Sell",
        qty: qtyStr,
        orderType: "Market",
      });
    } catch (err) {
      log({
        ts: observedAt,
        event: "llm-managed-open-order-failed",
        symbol, qty: qtyStr,
        error: err instanceof Error ? err.message : String(err),
      });
      await alerter.send(`llm-managed open order failed: ${symbol}`).catch(() => {});
      return { status: "skipped", reason: "open-order-failed" };
    }
  }

  // ── (9) Enqueue manage job ──────────────────────────────────────────────
  const positionId = `llm-managed-position:${now}-${symbol}`;
  const initialData: LlmManagedManageJobData = {
    positionId,
    symbol,
    side,
    entryPrice,
    qty,
    qtyStep: instrumentInfo.lotSizeFilter.qtyStep,
    minOrderQty: instrumentInfo.lotSizeFilter.minOrderQty,
    notionalUsd: clampedNotional,
    leverage: clampedLeverage,
    openedAt: new Date(now).toISOString(),
    targetPnlUsd: decision.targetPnlUsd ?? 0,
    maxLossUsd: decision.maxLossUsd ?? config.llmManagedMaxAbsoluteLossUsd,
    entryReasoning: decision.reasoning,
    mfeUsd: 0,
    maeUsd: 0,
    decisionsHistory: [],
    hedge: null,
    lastReviewAt: new Date(now).toISOString(),
  };

  await manageQueue.add(
    JOB_NAMES.llmManagedManageTick,
    initialData,
    {
      ...LLM_MANAGED_JOB_POLICY,
      jobId: positionId, // deterministic — prevents duplicate enqueues on races
      repeat: {
        every: config.llmManagedManageReviewIntervalSec * 1000,
      },
    },
  );

  log({
    ts: observedAt,
    event: "llm-managed-opened",
    positionId, symbol, side, qty, entryPrice,
    notionalUsd: clampedNotional, leverage: clampedLeverage,
  });

  return {
    status: "opened",
    positionId, symbol, side, qty, entryPrice,
    notionalUsd: clampedNotional, leverage: clampedLeverage,
  };
}
