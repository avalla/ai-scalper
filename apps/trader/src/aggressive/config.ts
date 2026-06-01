/**
 * Aggressive subsystem config — loaded from `apps/trader/config.aggressive.json`
 * (or env AGGRESSIVE_CONFIG_FILE). Intentionally separate from the
 * conservative config to keep the two subsystems isolated.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { AggressiveTierLadder } from "./types";
import { validateTierLadder } from "./tier-engine";

export interface PumpScannerSubsystemConfig {
  /** Master switch for the pump-scanner sub-pipeline. */
  enabled: boolean;
  /** Tick of the scanner evaluate loop in ms. Default 5000. */
  evaluateTickMs: number;
  /** How often to refresh the universe (filtered instrument list) in ms. Default 300_000 (5 min). */
  universeRefreshMs: number;
  /** Rolling window length (ms) used for anomaly detection. Default 300_000 (5 min). */
  windowMs: number;
  /** Liquidity criteria for universe selection. */
  liquidity: { min24hTurnoverUsd: number; maxSpreadBps: number; minBookDepthUsd: number };
  /** Anomaly trigger thresholds. */
  anomaly: { priceChangeBpsThreshold: number; volumeMultipleThreshold: number; minWindowVolumeUsd: number };
  /** LLM analyzer settings. */
  llm: {
    /** Set true to actually call Claude; false leaves the scanner in dry-run (logs anomalies, no trades). */
    enabled: boolean;
    /** Min confidence on an "enter" signal to actually trade. Below → treated as skip. */
    minConfidence: number;
    /** Anthropic model id. */
    model: string;
  };
  /** Sizing applied when the LLM signal passes — runs OUTSIDE the tier ladder. */
  sizing: {
    /** Notional USD per single trade. */
    maxNotionalUsdPerTrade: number;
    /** Leverage on the perp leg. Hard-capped by MAX_LEVERAGE_ALLOWED in config.ts. */
    leverage: number;
  };
  /** Optional symbol whitelist; null = all that pass liquidity. */
  symbolWhitelist: readonly string[] | null;
  /** Optional symbol blacklist. */
  symbolBlacklist: readonly string[];
}

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
  /** Optional pump-scanner sub-pipeline (LLM-driven). When absent, defaults to disabled. */
  pumpScanner?: PumpScannerSubsystemConfig;
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
  // Optional pump-scanner block — defaults to disabled when absent.
  if (raw.pumpScanner) {
    const p = raw.pumpScanner as Partial<PumpScannerSubsystemConfig>;
    cfg.pumpScanner = {
      enabled: p.enabled ?? false,
      evaluateTickMs: p.evaluateTickMs ?? 5_000,
      universeRefreshMs: p.universeRefreshMs ?? 300_000,
      windowMs: p.windowMs ?? 300_000,
      liquidity: { min24hTurnoverUsd: p.liquidity?.min24hTurnoverUsd ?? 10_000_000, maxSpreadBps: p.liquidity?.maxSpreadBps ?? 5, minBookDepthUsd: p.liquidity?.minBookDepthUsd ?? 0 },
      anomaly: { priceChangeBpsThreshold: p.anomaly?.priceChangeBpsThreshold ?? 200, volumeMultipleThreshold: p.anomaly?.volumeMultipleThreshold ?? 2.0, minWindowVolumeUsd: p.anomaly?.minWindowVolumeUsd ?? 50_000 },
      llm: { enabled: p.llm?.enabled ?? false, minConfidence: p.llm?.minConfidence ?? 0.6, model: p.llm?.model ?? "claude-haiku-4-5-20251001" },
      sizing: { maxNotionalUsdPerTrade: p.sizing?.maxNotionalUsdPerTrade ?? 50, leverage: p.sizing?.leverage ?? 10 },
      symbolWhitelist: p.symbolWhitelist ?? null,
      symbolBlacklist: p.symbolBlacklist ?? [],
    };
  }
  return cfg;
}
