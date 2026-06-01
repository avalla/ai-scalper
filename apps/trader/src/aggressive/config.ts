/**
 * Aggressive subsystem config — loaded from `apps/trader/config.aggressive.json`
 * (or env AGGRESSIVE_CONFIG_FILE). Intentionally separate from the
 * conservative config to keep the two subsystems isolated.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { AggressiveTierLadder } from "./types";
import { validateTierLadder } from "./tier-engine";

export interface AggressiveSubsystemConfig {
  /** Master switch — even with the file present, must be true to start. */
  enabled: boolean;
  /** Symbol traded by the aggressive subsystem (single-symbol for MVP). */
  symbol: string;
  /** Paper starting equity (USD). Real equity in live mode comes from Bybit wallet. */
  startingEquityUsd: number;
  /** Hard ceiling on capital allocated to the aggressive subsystem. */
  maxCapitalUsd: number;
  /** Cap on daily realized loss as a fraction of day-start equity. */
  dailyLossCapFraction: number;
  /** Max trades per UTC day (anti-tilt). */
  maxTradesPerDay: number;
  /** How often the evaluate worker fires (ms). */
  evaluateTickMs: number;
  /** How often each open position's manage tick fires (ms). Smaller = faster stops. */
  manageTickMs: number;
  /** Window of liquidation events to look at when building the map (ms). */
  liquidationLookbackMs: number;
  /** Map cluster bandwidth (bps). */
  mapBandBps: number;
  /** Discard map magnets smaller than this (USD). */
  mapMinMagnetSizeUsd: number;
  /** Optional max-hold time (s); 0 = disabled. */
  maxHoldSec: number;
  /** Equity-tiered ladder. Must pass validateTierLadder. */
  tierLadder: AggressiveTierLadder;
}

function resolveConfigFile(name: string, fallbackDir: string): string | null {
  if (isAbsolute(name)) return existsSync(name) ? name : null;
  // Search up from cwd for apps/trader/<name>, similar to the main config loader.
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, "apps", "trader", name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const direct = join(fallbackDir, name);
  return existsSync(direct) ? direct : null;
}

export function loadAggressiveConfig(): AggressiveSubsystemConfig | null {
  const fileName = process.env.AGGRESSIVE_CONFIG_FILE ?? "config.aggressive.json";
  const resolved = resolveConfigFile(fileName, process.cwd());
  if (!resolved) return null;
  const raw = JSON.parse(readFileSync(resolved, "utf-8")) as Partial<AggressiveSubsystemConfig>;
  const cfg: AggressiveSubsystemConfig = {
    enabled: raw.enabled ?? false,
    symbol: raw.symbol ?? "BTCUSDT",
    startingEquityUsd: raw.startingEquityUsd ?? 100,
    maxCapitalUsd: raw.maxCapitalUsd ?? 200,
    dailyLossCapFraction: raw.dailyLossCapFraction ?? 0.5,
    maxTradesPerDay: raw.maxTradesPerDay ?? 10,
    evaluateTickMs: raw.evaluateTickMs ?? 5_000,
    manageTickMs: raw.manageTickMs ?? 2_000,
    liquidationLookbackMs: raw.liquidationLookbackMs ?? 30 * 60_000,
    mapBandBps: raw.mapBandBps ?? 20,
    mapMinMagnetSizeUsd: raw.mapMinMagnetSizeUsd ?? 50_000,
    maxHoldSec: raw.maxHoldSec ?? 0,
    tierLadder: (raw.tierLadder ?? []) as AggressiveTierLadder,
  };
  if (cfg.tierLadder.length === 0) {
    throw new Error("aggressive config: tierLadder is required");
  }
  validateTierLadder(cfg.tierLadder);
  return cfg;
}
