/**
 * llm-managed MANAGE processor (Phase 1 BullMQ migration PoC).
 *
 * Pure, fully-DI'd function. Wrapped by the BullMQ Worker in apps/worker.
 *
 * Per-tick flow:
 *   1. Reconcile against Bybit — if the position is no longer open on exchange,
 *      append an "external-close" ledger entry and complete the job.
 *   2. Fetch current price; compute PnL + minutes-held; update MFE/MAE.
 *   3. Hard safety override (SL / max-hold / per-position max-loss) — close
 *      immediately, complete job, set last-cut-loss-at on cut-loss.
 *   4. Otherwise call getManageDecision(...).
 *   5. Execute the action:
 *        hold              — append decision to history, keep job alive
 *        tp-partial        — reduce qty proportionally, keep job alive
 *        scale-out         — same as tp-partial
 *        tp-full           — close all, COMPLETE JOB
 *        cut-loss          — close all + setLastCutLossAt, COMPLETE JOB
 *        open-hedge        — open hedge, update jobData.hedge
 *        close-hedge       — close hedge, set jobData.hedge=null
 *        scale-in          — add to qty, update jobData
 *
 * Tests stub all I/O; the result object encodes what happened so assertions
 * are clean.
 */

import type { createBybitClient } from "@ai-scalper/bybit-client";
import type { TickerSource } from "@ai-scalper/bybit-client/ticker-source";
import type { LlmManagedManageJobData } from "@ai-scalper/queueing";
import type { TraderConfig } from "../config";
import type { WebhookAlerter } from "../alerts/webhook";
import {
  checkSafetyOverride,
  computePnlBps,
  computePnlUsd,
  getManageDecision as defaultGetManageDecision,
  updateExcursions,
  type LlmManagedMarketContext,
  type LlmManagedPosition,
  type ManageDecision,
} from "./llm-managed";
import type { LlmManagedSharedState } from "./llm-managed-redis";
import type { ClosedPositionLedgerEntry } from "../trading/position-ledger";

type BybitClient = ReturnType<typeof createBybitClient>;

/** Minimal shape of `createPositionLedger()` used by this processor. */
export interface ManageProcessorLedger {
  appendClosedPosition(entry: ClosedPositionLedgerEntry): Promise<void>;
}

export interface LlmManagedManageProcessorDeps {
  config: TraderConfig;
  client: BybitClient;
  tickerSource: TickerSource;
  alerter: WebhookAlerter;
  sharedState: LlmManagedSharedState;
  positionLedger: ManageProcessorLedger;
  collectMarketContext: (observedAt: string) => Promise<LlmManagedMarketContext>;
  getManageDecisionFn?: typeof defaultGetManageDecision;
  log?: (payload: Record<string, unknown>) => void;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

export type LlmManagedManageTickResult =
  | { status: "complete"; reason: string; updatedData?: LlmManagedManageJobData }
  | { status: "continue"; updatedData: LlmManagedManageJobData };

/**
 * Reconstruct an in-memory LlmManagedPosition from the job's persisted data —
 * needed for the existing pure helpers (computePnl, checkSafetyOverride, ...).
 */
function toRuntimePosition(data: LlmManagedManageJobData): LlmManagedPosition {
  return {
    symbol: data.symbol,
    side: data.side,
    entryPrice: data.entryPrice,
    qty: data.qty,
    notionalUsd: data.notionalUsd,
    leverage: data.leverage,
    openedAt: new Date(data.openedAt).getTime(),
    targetPnlUsd: data.targetPnlUsd,
    maxLossUsd: data.maxLossUsd,
    entryReasoning: data.entryReasoning,
    mfeUsd: data.mfeUsd,
    maeUsd: data.maeUsd,
    decisionsHistory: data.decisionsHistory.map((d) => ({
      at: new Date(d.at).getTime(),
      action: d.action,
      reasoning: d.reasoning,
    })),
    hedge: data.hedge
      ? {
          symbol: data.hedge.symbol,
          side: data.hedge.side,
          entryPrice: data.hedge.entryPrice,
          qty: data.hedge.qty,
          notionalUsd: data.hedge.notionalUsd,
          openedAt: new Date(data.hedge.openedAt).getTime(),
        }
      : null,
    qtyStep: data.qtyStep,
    minOrderQty: data.minOrderQty,
  };
}

/** Reflect runtime mutations back into the job-data shape. */
function mergeRuntime(
  prev: LlmManagedManageJobData,
  runtime: LlmManagedPosition,
  observedAt: string,
): LlmManagedManageJobData {
  return {
    ...prev,
    qty: runtime.qty,
    notionalUsd: runtime.notionalUsd,
    entryPrice: runtime.entryPrice,
    mfeUsd: runtime.mfeUsd,
    maeUsd: runtime.maeUsd,
    decisionsHistory: runtime.decisionsHistory.map((d) => ({
      at: new Date(d.at).toISOString(),
      action: d.action,
      reasoning: d.reasoning,
    })),
    hedge: runtime.hedge
      ? {
          symbol: runtime.hedge.symbol,
          side: runtime.hedge.side,
          entryPrice: runtime.hedge.entryPrice,
          qty: runtime.hedge.qty,
          notionalUsd: runtime.hedge.notionalUsd,
          openedAt: new Date(runtime.hedge.openedAt).toISOString(),
        }
      : null,
    lastReviewAt: observedAt,
  };
}

export async function processLlmManagedManageTick(
  jobData: LlmManagedManageJobData,
  deps: LlmManagedManageProcessorDeps,
): Promise<LlmManagedManageTickResult> {
  const { config, client, tickerSource, alerter, sharedState, positionLedger, collectMarketContext } = deps;
  const getManageDecisionFn = deps.getManageDecisionFn ?? defaultGetManageDecision;
  const log = deps.log ?? ((payload) => console.log(JSON.stringify(payload)));
  const now = (deps.now ?? Date.now)();
  const env = deps.env ?? process.env;
  const observedAt = new Date(now).toISOString();

  let runtime = toRuntimePosition(jobData);

  // ── (1) Reconcile against Bybit ─────────────────────────────────────────
  if (!config.paperTrading) {
    try {
      const live = await client.getPosition({ category: "linear", symbol: jobData.symbol });
      const liveSize = live ? Number(live.size) : 0;
      if (jobData.qty > 0 && (!live || !Number.isFinite(liveSize) || liveSize < jobData.qty * 0.01)) {
        log({
          ts: observedAt,
          event: "llm-managed-external-close-detected",
          positionId: jobData.positionId, symbol: jobData.symbol,
          recordedQty: jobData.qty, liveSize,
        });
        await positionLedger.appendClosedPosition(buildLedgerEntry({
          jobData, runtime, currentPrice: runtime.entryPrice, closeQty: jobData.qty,
          netPnl: 0, grossPnl: 0, feeUsd: 0, action: "external-close",
          reasoning: "external-close-detected",
          cumulativeRealizedPnlUsd: 0,
        }));
        await alerter.send(`llm-managed: external close detected for ${jobData.symbol}`).catch(() => {});
        return { status: "complete", reason: "external-close" };
      }
    } catch (err) {
      // If reconcile lookup fails, prefer continuing rather than mis-closing.
      log({
        ts: observedAt,
        event: "llm-managed-reconcile-failed",
        positionId: jobData.positionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── (2) Current price + excursions ──────────────────────────────────────
  let currentPrice = runtime.entryPrice;
  try {
    const t = await tickerSource.getTicker(jobData.symbol, { category: "linear" });
    const p = Number(t.lastPrice);
    if (Number.isFinite(p) && p > 0) currentPrice = p;
  } catch (err) {
    log({
      ts: observedAt,
      event: "llm-managed-ticker-unavailable",
      symbol: jobData.symbol,
      error: err instanceof Error ? err.message : String(err),
    });
    // Skip this tick but keep job alive.
    return { status: "continue", updatedData: { ...jobData, lastReviewAt: observedAt } };
  }

  const currentPnlUsd = computePnlUsd(runtime, currentPrice);
  const currentPnlBps = computePnlBps(runtime, currentPrice);
  const minutesHeld = (now - new Date(jobData.openedAt).getTime()) / 60_000;
  runtime = updateExcursions(runtime, currentPnlUsd);

  // ── (3) Hard safety override ────────────────────────────────────────────
  const override = checkSafetyOverride({
    position: runtime,
    currentPnlUsd, minutesHeld,
    maxAbsoluteLossUsd: config.llmManagedMaxAbsoluteLossUsd,
    maxHoldHours: config.llmManagedMaxHoldHours,
  });

  if (override) {
    log({
      ts: observedAt,
      event: "llm-managed-safety-trigger",
      positionId: jobData.positionId,
      rule: override.reasoning, action: override.action,
      currentPnlUsd, minutesHeld,
    });
    await alerter.send(
      `llm-managed safety: ${override.reasoning} → ${override.action} (pnl=${currentPnlUsd.toFixed(2)})`,
    ).catch(() => {});
    // Append override to history before executing.
    runtime = {
      ...runtime,
      decisionsHistory: [
        ...runtime.decisionsHistory,
        { at: now, action: override.action, reasoning: override.reasoning },
      ],
    };
    return executeAndMaybeComplete({
      decision: override, runtime, jobData, currentPrice, observedAt,
      config, client, tickerSource, alerter, sharedState, positionLedger, log, now,
    });
  }

  // ── (4) LLM manage decision ────────────────────────────────────────────
  let manage: ManageDecision;
  try {
    manage = await getManageDecisionFn({
      position: runtime,
      currentPrice, currentPnlUsd, currentPnlBps, minutesHeld,
      market: await collectMarketContext(observedAt),
      apiKey: env.ANTHROPIC_API_KEY,
      model: config.llmManagedModel,
      timeoutMs: config.llmManagedTimeoutMs,
    });
  } catch (err) {
    log({
      ts: observedAt,
      event: "llm-managed-manage-error",
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: "continue", updatedData: mergeRuntime(jobData, runtime, observedAt) };
  }

  log({
    ts: observedAt,
    event: "llm-managed-decision",
    positionId: jobData.positionId,
    action: manage.action, reasoning: manage.reasoning,
    currentPrice, currentPnlUsd, currentPnlBps, minutesHeld,
  });

  // Always record the decision in history.
  runtime = {
    ...runtime,
    decisionsHistory: [
      ...runtime.decisionsHistory,
      { at: now, action: manage.action, reasoning: manage.reasoning },
    ],
  };

  return executeAndMaybeComplete({
    decision: manage, runtime, jobData, currentPrice, observedAt,
    config, client, tickerSource, alerter, sharedState, positionLedger, log, now,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildLedgerEntry(params: {
  jobData: LlmManagedManageJobData;
  runtime: LlmManagedPosition;
  currentPrice: number;
  closeQty: number;
  netPnl: number;
  grossPnl: number;
  feeUsd: number;
  action: string;
  reasoning: string;
  cumulativeRealizedPnlUsd: number;
}): ClosedPositionLedgerEntry {
  const { jobData, runtime, currentPrice, closeQty, netPnl, grossPnl, feeUsd, action, reasoning, cumulativeRealizedPnlUsd } = params;
  return {
    closedAt: new Date().toISOString(),
    cumulativeRealizedPnlUsd,
    entryPrice: runtime.entryPrice,
    exitPrice: currentPrice,
    exitReason: reasoning,
    leverage: runtime.leverage,
    notionalUsd: closeQty * currentPrice,
    openedAt: jobData.openedAt,
    quantity: closeQty,
    realizedPnlUsd: netPnl,
    grossPnlUsd: grossPnl,
    feeUsd,
    championIdAtEntry: null,
    strategyType: "llm-managed",
    llmManagedAction: action,
    llmManagedReasoning: reasoning,
    side: runtime.side,
    stopLossPrice: 0,
    symbol: runtime.symbol,
    takeProfitPrice: 0,
  };
}

interface ExecuteCtx {
  decision: ManageDecision;
  runtime: LlmManagedPosition;
  jobData: LlmManagedManageJobData;
  currentPrice: number;
  observedAt: string;
  config: TraderConfig;
  client: BybitClient;
  tickerSource: TickerSource;
  alerter: WebhookAlerter;
  sharedState: LlmManagedSharedState;
  positionLedger: ManageProcessorLedger;
  log: (payload: Record<string, unknown>) => void;
  now: number;
}

/**
 * Execute the decision and either return `complete` (job done — no more
 * repeats) or `continue` (job keeps repeating, with mutated data).
 */
async function executeAndMaybeComplete(ctx: ExecuteCtx): Promise<LlmManagedManageTickResult> {
  const { decision, runtime, jobData, currentPrice, observedAt, config, client, tickerSource, alerter, sharedState, positionLedger, log, now } = ctx;

  // HOLD — no I/O, persist mfe/mae + history.
  if (decision.action === "hold") {
    return { status: "continue", updatedData: mergeRuntime(jobData, runtime, observedAt) };
  }

  const isFullClose = decision.action === "tp-full" || decision.action === "cut-loss";
  const partialFraction =
    decision.action === "tp-partial" || decision.action === "scale-out"
      ? Math.max(0.1, Math.min(0.9, decision.params?.tpPartialFraction ?? 0.5))
      : null;

  // ── Full or partial close on primary leg ────────────────────────────────
  if (isFullClose || partialFraction !== null) {
    const rawCloseQty = partialFraction !== null ? runtime.qty * partialFraction : runtime.qty;
    let closeQty = rawCloseQty;
    let closeQtyStr = closeQty.toString();
    if (runtime.qtyStep) {
      const step = Number(runtime.qtyStep);
      const decimals = runtime.qtyStep.split(".")[1]?.length ?? 0;
      if (Number.isFinite(step) && step > 0) {
        closeQty = Math.floor(rawCloseQty / step) * step;
        closeQtyStr = closeQty.toFixed(decimals);
      }
    }
    if (runtime.minOrderQty && closeQty < Number(runtime.minOrderQty)) {
      log({
        ts: observedAt, event: "llm-managed-close-skipped",
        symbol: runtime.symbol, action: decision.action,
        reason: "close-qty-below-min", closeQty, minOrderQty: runtime.minOrderQty,
      });
      return { status: "continue", updatedData: mergeRuntime(jobData, runtime, observedAt) };
    }
    const closeSide: "Buy" | "Sell" = runtime.side === "long" ? "Sell" : "Buy";
    const closeNotional = closeQty * currentPrice;

    if (!config.paperTrading) {
      try {
        await client.createOrder({
          category: "linear",
          symbol: runtime.symbol,
          side: closeSide,
          qty: closeQtyStr,
          orderType: "Market",
          reduceOnly: true,
        });
      } catch (err) {
        log({
          ts: observedAt,
          event: "llm-managed-close-failed",
          symbol: runtime.symbol, action: decision.action,
          error: err instanceof Error ? err.message : String(err),
        });
        await alerter.send(
          `llm-managed close failed: symbol=${runtime.symbol} action=${decision.action}`,
        ).catch(() => {});
        // Keep the job alive — next tick will retry safety eval.
        return { status: "continue", updatedData: mergeRuntime(jobData, runtime, observedAt) };
      }
    }

    const sliceSign = runtime.side === "long" ? 1 : -1;
    const grossPnl = sliceSign * (currentPrice - runtime.entryPrice) * closeQty;
    const feeUsd = closeNotional * (config.feeRoundTripBps / 10_000);
    const netPnl = grossPnl - feeUsd;

    await positionLedger.appendClosedPosition(buildLedgerEntry({
      jobData, runtime, currentPrice, closeQty,
      netPnl, grossPnl, feeUsd,
      action: decision.action, reasoning: decision.reasoning,
      cumulativeRealizedPnlUsd: 0, // tracked in shared state ledger upstream
    }));

    log({
      ts: observedAt, event: "llm-managed-close",
      positionId: jobData.positionId, action: decision.action,
      symbol: runtime.symbol, closeQty, currentPrice, grossPnl, feeUsd, netPnl,
      reasoning: decision.reasoning,
    });

    if (isFullClose) {
      if (decision.action === "cut-loss" || decision.reasoning?.startsWith("safety-hard-sl")) {
        await sharedState.setLastCutLossAt(now);
      }
      return { status: "complete", reason: decision.action };
    }

    // Partial: shrink qty + notional pro-rata, keep job alive.
    const remainingQty = runtime.qty - closeQty;
    const remainingNotional = runtime.notionalUsd * (remainingQty / runtime.qty);
    const shrunk = { ...runtime, qty: remainingQty, notionalUsd: remainingNotional };
    return { status: "continue", updatedData: mergeRuntime(jobData, shrunk, observedAt) };
  }

  // ── open-hedge ─────────────────────────────────────────────────────────
  if (decision.action === "open-hedge") {
    if (runtime.hedge !== null) {
      log({ ts: observedAt, event: "llm-managed-hedge-rejected", reason: "hedge-already-open" });
      return { status: "continue", updatedData: mergeRuntime(jobData, runtime, observedAt) };
    }
    const hedgeSymbol = decision.params?.hedgeSymbol ?? runtime.symbol;
    if (!config.llmManagedAllowedSymbols.includes(hedgeSymbol)) {
      log({ ts: observedAt, event: "llm-managed-hedge-rejected", reason: "hedge-symbol-not-allowed", hedgeSymbol });
      return { status: "continue", updatedData: mergeRuntime(jobData, runtime, observedAt) };
    }
    const hedgeNotional = Math.min(runtime.notionalUsd, config.llmManagedHedgeMaxNotionalUsd);
    const hedgeSide: "long" | "short" = runtime.side === "long" ? "short" : "long";
    let hedgePrice = currentPrice;
    if (hedgeSymbol !== runtime.symbol) {
      try {
        const t = await tickerSource.getTicker(hedgeSymbol, { category: "linear" });
        const p = Number(t.lastPrice);
        if (Number.isFinite(p) && p > 0) hedgePrice = p;
      } catch { /* ignore */ }
    }
    const hedgeQty = hedgePrice > 0 ? hedgeNotional / hedgePrice : 0;
    if (hedgeQty <= 0) {
      log({ ts: observedAt, event: "llm-managed-hedge-rejected", reason: "invalid-hedge-qty" });
      return { status: "continue", updatedData: mergeRuntime(jobData, runtime, observedAt) };
    }
    if (!config.paperTrading) {
      try {
        await client.createOrder({
          category: "linear",
          symbol: hedgeSymbol,
          side: hedgeSide === "long" ? "Buy" : "Sell",
          qty: hedgeQty.toString(),
          orderType: "Market",
        });
      } catch (err) {
        log({
          ts: observedAt,
          event: "llm-managed-hedge-open-failed",
          error: err instanceof Error ? err.message : String(err),
        });
        await alerter.send(`llm-managed hedge open failed: ${hedgeSymbol}`).catch(() => {});
        return { status: "continue", updatedData: mergeRuntime(jobData, runtime, observedAt) };
      }
    }
    const next = {
      ...runtime,
      hedge: {
        symbol: hedgeSymbol, side: hedgeSide,
        entryPrice: hedgePrice, qty: hedgeQty,
        notionalUsd: hedgeNotional, openedAt: now,
      },
    };
    return { status: "continue", updatedData: mergeRuntime(jobData, next, observedAt) };
  }

  // ── close-hedge ────────────────────────────────────────────────────────
  if (decision.action === "close-hedge") {
    const hedge = runtime.hedge;
    if (!hedge) {
      return { status: "continue", updatedData: mergeRuntime(jobData, runtime, observedAt) };
    }
    if (!config.paperTrading) {
      try {
        await client.createOrder({
          category: "linear",
          symbol: hedge.symbol,
          side: hedge.side === "long" ? "Sell" : "Buy",
          qty: hedge.qty.toString(),
          orderType: "Market",
          reduceOnly: true,
        });
      } catch (err) {
        log({
          ts: observedAt,
          event: "llm-managed-hedge-close-failed",
          error: err instanceof Error ? err.message : String(err),
        });
        return { status: "continue", updatedData: mergeRuntime(jobData, runtime, observedAt) };
      }
    }
    const next = { ...runtime, hedge: null };
    return { status: "continue", updatedData: mergeRuntime(jobData, next, observedAt) };
  }

  // ── scale-in ───────────────────────────────────────────────────────────
  if (decision.action === "scale-in") {
    const addNotional = decision.params?.scaleNotionalUsd ?? 0;
    if (addNotional <= 0) {
      return { status: "continue", updatedData: mergeRuntime(jobData, runtime, observedAt) };
    }
    const cap = config.llmManagedMaxNotionalUsd * 2;
    const totalAfter = runtime.notionalUsd + addNotional;
    if (totalAfter > cap) {
      log({ ts: observedAt, event: "llm-managed-scale-in-rejected", reason: "notional-cap", totalAfter, cap });
      return { status: "continue", updatedData: mergeRuntime(jobData, runtime, observedAt) };
    }
    const addQty = currentPrice > 0 ? addNotional / currentPrice : 0;
    if (addQty <= 0) {
      return { status: "continue", updatedData: mergeRuntime(jobData, runtime, observedAt) };
    }
    if (!config.paperTrading) {
      try {
        await client.createOrder({
          category: "linear",
          symbol: runtime.symbol,
          side: runtime.side === "long" ? "Buy" : "Sell",
          qty: addQty.toString(),
          orderType: "Market",
        });
      } catch (err) {
        log({
          ts: observedAt,
          event: "llm-managed-scale-in-failed",
          error: err instanceof Error ? err.message : String(err),
        });
        return { status: "continue", updatedData: mergeRuntime(jobData, runtime, observedAt) };
      }
    }
    const totalQty = runtime.qty + addQty;
    const newEntryPrice = ((runtime.entryPrice * runtime.qty) + (currentPrice * addQty)) / totalQty;
    const next = { ...runtime, qty: totalQty, notionalUsd: totalAfter, entryPrice: newEntryPrice };
    return { status: "continue", updatedData: mergeRuntime(jobData, next, observedAt) };
  }

  // Unknown action — record and continue.
  return { status: "continue", updatedData: mergeRuntime(jobData, runtime, observedAt) };
}

export const __INTERNAL = { toRuntimePosition, mergeRuntime, buildLedgerEntry };
