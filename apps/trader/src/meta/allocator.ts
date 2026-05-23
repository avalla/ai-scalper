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
  lastUpdatedAt: number;
}

export interface AllocatorState {
  stats: Record<string, VariantStats>;
  championId: string | null;
  selectedAt: number | null;
}

export type ChampionReason =
  | "warmup-rotation"
  | "thompson-sample"
  | "single-variant";

export interface SelectChampionResult {
  championId: string;
  reason: ChampionReason;
}

export function emptyAllocatorState(): AllocatorState {
  return { stats: {}, championId: null, selectedAt: null };
}

function emptyStats(variantId: string, now: number): VariantStats {
  return {
    variantId,
    closedTrades: 0,
    wins: 0,
    losses: 0,
    realizedPnlUsd: 0,
    recentPnlWindow: [],
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
  const updated: VariantStats = {
    variantId,
    closedTrades: existing.closedTrades + 1,
    wins: existing.wins + (pnlUsd > 0 ? 1 : 0),
    losses: existing.losses + (pnlUsd < 0 ? 1 : 0),
    realizedPnlUsd: existing.realizedPnlUsd + pnlUsd,
    recentPnlWindow: nextWindow,
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
}): SelectChampionResult {
  const { allocator, variants } = params;
  const warmupMinTrades = params.warmupMinTrades ?? 5;
  const rng = params.rng ?? Math.random;

  if (variants.length === 0) {
    throw new Error("selectChampion requires at least one variant");
  }
  if (variants.length === 1) {
    return { championId: variants[0]!.id, reason: "single-variant" };
  }

  const sorted = [...variants].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Warmup: pick the variant with fewest closed trades if any is under cap.
  const underWarmup = sorted.filter(
    (v) => (allocator.stats[v.id]?.closedTrades ?? 0) < warmupMinTrades,
  );
  if (underWarmup.length > 0) {
    let pick = underWarmup[0]!;
    let pickTrades = allocator.stats[pick.id]?.closedTrades ?? 0;
    for (const v of underWarmup) {
      const trades = allocator.stats[v.id]?.closedTrades ?? 0;
      if (trades < pickTrades) {
        pick = v;
        pickTrades = trades;
      }
    }
    return { championId: pick.id, reason: "warmup-rotation" };
  }

  // All variants have ≥ warmupMinTrades closed trades → Thompson sample.
  let bestId = sorted[0]!.id;
  let bestScore = -Infinity;
  for (const v of sorted) {
    const window = allocator.stats[v.id]?.recentPnlWindow ?? [];
    const mu = mean(window);
    const sigma = stddev(window);
    const n = Math.max(window.length, 1);
    const z = sampleStandardNormal(rng);
    const score = mu + (sigma / Math.sqrt(n)) * z;
    if (score > bestScore) {
      bestScore = score;
      bestId = v.id;
    }
  }
  return { championId: bestId, reason: "thompson-sample" };
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
