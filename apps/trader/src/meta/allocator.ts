import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveProjectPath } from "@ai-scalper/trading-core";
import type { Variant } from "./variant-pool";

export const DEFAULT_PNL_WINDOW_SIZE = 50;

export interface VariantStats {
  variantId: string;
  closedTrades: number;
  wins: number;
  losses: number;
  realizedPnlUsd: number;
  /** Last K closed-trade PnLs (FIFO, capped at allocator window size). */
  recentPnlWindow: number[];
  /**
   * Phase 1A: parallel FIFO window of {pnl, ts} pairs for time-decay weighting.
   * Always tracked; only consumed when `halfLifeDays` is provided to `selectChampion`.
   */
  recentPnlWindowWithTs: Array<{ pnl: number; ts: number }>;
  lastUpdatedAt: number;
}

export interface AllocatorState {
  stats: Record<string, VariantStats>;
  championId: string | null;
  selectedAt: number | null;
  /** Phase 1A: monotonically incrementing cursor for strict round-robin warmup. */
  roundRobinCursor?: number;
}

export type ChampionReason =
  | "warmup-rotation"
  | "thompson-sample"
  | "single-variant";

export interface SelectChampionResult {
  championId: string;
  reason: ChampionReason;
  /**
   * Phase 1A: updated allocator state with advanced round-robin cursor.
   * Existing callers may ignore this; new code should persist it to keep
   * strict round-robin advancing across selections.
   */
  allocator?: AllocatorState;
}

export function emptyAllocatorState(): AllocatorState {
  return { stats: {}, championId: null, selectedAt: null, roundRobinCursor: 0 };
}

function emptyStats(variantId: string, now: number): VariantStats {
  return {
    variantId,
    closedTrades: 0,
    wins: 0,
    losses: 0,
    realizedPnlUsd: 0,
    recentPnlWindow: [],
    recentPnlWindowWithTs: [],
    lastUpdatedAt: now,
  };
}

/**
 * Append a closed-trade PnL into the variant's stats. Returns a new
 * AllocatorState; the original is not mutated.
 *
 * The recent-PnL window is FIFO with a fixed cap (default 50): oldest entry
 * is dropped when the cap is exceeded.
 */
export function recordClosedTrade(
  allocator: AllocatorState,
  variantId: string,
  pnlUsd: number,
  now: number,
  windowSize: number = DEFAULT_PNL_WINDOW_SIZE,
): AllocatorState {
  const existing = allocator.stats[variantId] ?? emptyStats(variantId, now);
  const nextWindow = [...existing.recentPnlWindow, pnlUsd];
  while (nextWindow.length > windowSize) {
    nextWindow.shift();
  }
  const nextWindowWithTs = [...(existing.recentPnlWindowWithTs ?? []), { pnl: pnlUsd, ts: now }];
  while (nextWindowWithTs.length > windowSize) {
    nextWindowWithTs.shift();
  }
  const updated: VariantStats = {
    variantId,
    closedTrades: existing.closedTrades + 1,
    wins: existing.wins + (pnlUsd > 0 ? 1 : 0),
    losses: existing.losses + (pnlUsd < 0 ? 1 : 0),
    realizedPnlUsd: existing.realizedPnlUsd + pnlUsd,
    recentPnlWindow: nextWindow,
    recentPnlWindowWithTs: nextWindowWithTs,
    lastUpdatedAt: now,
  };
  return {
    ...allocator,
    stats: { ...allocator.stats, [variantId]: updated },
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance =
    values.reduce((a, b) => a + (b - m) * (b - m), 0) / (values.length - 1);
  return Math.sqrt(Math.max(variance, 0));
}

/**
 * Box-Muller transform: returns a sample from Normal(0, 1) using two uniform
 * samples on (0, 1). rng() must return numbers in (0, 1).
 */
function sampleStandardNormal(rng: () => number): number {
  // Guard against rng returning exactly 0 → log(0) = -Infinity.
  let u1 = rng();
  while (u1 <= 0) {
    u1 = rng();
  }
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Pick a champion variant.
 *
 * Algorithm:
 *   - If only 1 variant exists, return it with reason "single-variant".
 *   - If any variant has fewer than `warmupMinTrades` closed trades, prefer
 *     the variant with the fewest trades (ties broken by lexical id), with
 *     reason "warmup-rotation".
 *   - Otherwise: Thompson sample from a Gaussian posterior over each
 *     variant's mean PnL:
 *         score ~ Normal(μ, σ / √n)
 *     where μ = mean(recentPnlWindow), σ = stddev(recentPnlWindow),
 *     n = recentPnlWindow.length. Champion = argmax score.
 */
export function selectChampion(params: {
  allocator: AllocatorState;
  variants: Variant[];
  now: number;
  warmupMinTrades?: number;
  rng?: () => number;
  /**
   * Phase 1A: if provided (> 0), the Thompson posterior weights each closed
   * trade's PnL by 0.5^((now - trade.ts) / halfLifeMs). Otherwise behaves
   * exactly as before.
   */
  halfLifeDays?: number;
}): SelectChampionResult {
  const { allocator, variants } = params;
  const warmupMinTrades = params.warmupMinTrades ?? 5;
  const rng = params.rng ?? Math.random;

  if (variants.length === 0) {
    throw new Error("selectChampion requires at least one variant");
  }
  if (variants.length === 1) {
    return { championId: variants[0]!.id, reason: "single-variant", allocator };
  }

  const sorted = [...variants].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Warmup: strict round-robin via cursor when any variant is under cap.
  const underWarmup = sorted.filter(
    (v) => (allocator.stats[v.id]?.closedTrades ?? 0) < warmupMinTrades,
  );
  if (underWarmup.length > 0) {
    const cursor = allocator.roundRobinCursor ?? 0;
    // Map cursor into the sorted variant list, then advance to the next
    // candidate that is still under warmup.
    let idx = cursor % sorted.length;
    for (let attempts = 0; attempts < sorted.length; attempts++) {
      const candidate = sorted[idx]!;
      if ((allocator.stats[candidate.id]?.closedTrades ?? 0) < warmupMinTrades) {
        const updatedAllocator: AllocatorState = {
          ...allocator,
          roundRobinCursor: (cursor + 1) % Number.MAX_SAFE_INTEGER,
        };
        return {
          championId: candidate.id,
          reason: "warmup-rotation",
          allocator: updatedAllocator,
        };
      }
      idx = (idx + 1) % sorted.length;
    }
    // Fall through (should not happen since underWarmup is non-empty)
  }

  // All variants have ≥ warmupMinTrades closed trades → Thompson sample.
  const halfLifeDays = params.halfLifeDays;
  const halfLifeMs =
    halfLifeDays !== undefined && halfLifeDays > 0 ? halfLifeDays * 24 * 60 * 60 * 1000 : null;

  let bestId = sorted[0]!.id;
  let bestScore = -Infinity;
  for (const v of sorted) {
    let mu: number;
    let sigma: number;
    let n: number;

    if (halfLifeMs !== null) {
      const samples = allocator.stats[v.id]?.recentPnlWindowWithTs ?? [];
      if (samples.length === 0) {
        mu = 0;
        sigma = 0;
        n = 1;
      } else {
        const weighted = samples.map((s) => ({
          pnl: s.pnl,
          w: Math.pow(0.5, (params.now - s.ts) / halfLifeMs),
        }));
        // Use nominal sample count as the denominator so stale samples decay
        // mu toward 0 (the "no evidence" prior) instead of preserving the raw
        // mean when all samples are equally aged.
        const sumWeightedPnl = weighted.reduce((a, b) => a + b.pnl * b.w, 0);
        mu = sumWeightedPnl / weighted.length;
        // Weighted variance about mu, also scaled by nominal count.
        const variance =
          weighted.length > 1
            ? weighted.reduce((a, b) => a + b.w * (b.pnl - mu) * (b.pnl - mu), 0) / weighted.length
            : 0;
        sigma = Math.sqrt(Math.max(variance, 0));
        n = Math.max(weighted.length, 1);
      }
    } else {
      const window = allocator.stats[v.id]?.recentPnlWindow ?? [];
      mu = mean(window);
      sigma = stddev(window);
      n = Math.max(window.length, 1);
    }

    const z = sampleStandardNormal(rng);
    const score = mu + (sigma / Math.sqrt(n)) * z;
    if (score > bestScore) {
      bestScore = score;
      bestId = v.id;
    }
  }
  return { championId: bestId, reason: "thompson-sample", allocator };
}

// ---------- Persistence ----------

function allocatorStatePath(): string {
  return join(resolveProjectPath("apps/trader/data/runtime"), "variants.json");
}

export interface PersistedAllocator {
  allocator: AllocatorState;
  /** Per-variant paper-state snapshots, keyed by variant id. */
  variantStates: Record<string, unknown>;
  lastTickAt: number;
}

export async function loadAllocatorState(): Promise<PersistedAllocator | null> {
  try {
    const file = Bun.file(allocatorStatePath());
    if (!(await file.exists())) return null;
    const parsed = (await file.json()) as PersistedAllocator;
    if (parsed && typeof parsed === "object" && "allocator" in parsed) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export async function persistAllocatorState(
  payload: PersistedAllocator,
): Promise<string> {
  try {
    const dir = resolveProjectPath("apps/trader/data/runtime");
    await mkdir(dir, { recursive: true });
    const path = allocatorStatePath();
    await Bun.write(path, `${JSON.stringify(payload, null, 2)}\n`);
    return path;
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "warn",
        event: "allocator-persist-error",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return allocatorStatePath();
  }
}

export function getAllocatorStatePath(): string {
  return allocatorStatePath();
}
