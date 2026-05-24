/**
 * Helpers shared across Phase 2 strategy processors.
 *
 * Goal: keep open-/manage-processors deterministic and tiny by hiding
 * housekeeping (job ID derivation, repeat-key cleanup, decision-history
 * snapshots) behind small pure helpers.
 */

/** Minimal queue shape used by `safeRemoveRepeatable`. Avoids a hard
 * `bullmq` dep in the trader package — the worker app passes a real
 * `Queue` instance at runtime. */
export interface RepeatableQueueLike {
  removeRepeatableByKey(key: string): Promise<unknown>;
}

/** Decision-history row stored on every trade-management job. */
export interface DecisionHistoryRow {
  at: string;
  action: string;
  reasoning: string;
}

/**
 * Build a deterministic positionId for a strategy. Used both for BullMQ jobId
 * (dedup on enqueue races) and for cross-process correlation in alerts.
 *
 *   positionId = "<strategy>-position:<epochMs>-<discriminator>"
 *
 * The discriminator is typically the primary symbol, or a "leg1-leg2" pair.
 */
export function makePositionId(params: {
  strategy: string;
  now: number;
  discriminator: string;
}): string {
  return `${params.strategy}-position:${params.now}-${params.discriminator}`;
}

/**
 * Build a deterministic recurring-job id for an open-decision tick. There is
 * exactly one such job per strategy, so jobId is constant.
 */
export function makeOpenTickJobId(strategy: string): string {
  return `${strategy}-open-tick-recurring`;
}

/**
 * Append a decision row immutably to a history list, capping at `limit`
 * entries (oldest dropped first). Default cap matches Phase 1: 50.
 */
export function appendDecisionHistory(
  prev: DecisionHistoryRow[],
  next: DecisionHistoryRow,
  limit = 50,
): DecisionHistoryRow[] {
  const merged = prev.concat(next);
  if (merged.length <= limit) return merged;
  return merged.slice(merged.length - limit);
}

/**
 * Remove the repeat schedule for a completed per-position trade-management
 * job. Swallows errors (logs via the provided logger) — failure to remove a
 * repeat doesn't change the fact that the position closed, and the next tick
 * will try again on its own.
 */
export async function safeRemoveRepeatable(params: {
  queue: RepeatableQueueLike;
  repeatKey: string | null | undefined;
  event: string;
  log?: (payload: Record<string, unknown>) => void;
}): Promise<boolean> {
  const log = params.log ?? ((p) => console.warn(JSON.stringify(p)));
  if (!params.repeatKey) return false;
  try {
    await params.queue.removeRepeatableByKey(params.repeatKey);
    return true;
  } catch (err) {
    log({
      event: params.event,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Floor a raw qty to the instrument's qty step and format it to the right
 * number of decimals. Returns null if the floored qty falls below min.
 */
export function floorQtyToStep(params: {
  rawQty: number;
  qtyStep: string;
  minOrderQty: string;
}): { qty: number; qtyStr: string } | null {
  const step = Number(params.qtyStep);
  const minQty = Number(params.minOrderQty);
  const decimals = (params.qtyStep.split(".")[1] ?? "").length;
  const qty = step > 0 ? Math.floor(params.rawQty / step) * step : params.rawQty;
  if (!Number.isFinite(qty) || qty <= 0) return null;
  if (Number.isFinite(minQty) && qty < minQty) return null;
  return { qty, qtyStr: qty.toFixed(decimals) };
}

/**
 * Compute the qty for a given USD notional + leverage at a known price.
 * Convenience wrapper around floorQtyToStep.
 */
export function computeQtyFromNotional(params: {
  notionalUsd: number;
  leverage: number;
  price: number;
  qtyStep: string;
  minOrderQty: string;
}): { qty: number; qtyStr: string } | null {
  if (params.price <= 0) return null;
  const exposure = params.notionalUsd * Math.max(1, params.leverage);
  return floorQtyToStep({
    rawQty: exposure / params.price,
    qtyStep: params.qtyStep,
    minOrderQty: params.minOrderQty,
  });
}
