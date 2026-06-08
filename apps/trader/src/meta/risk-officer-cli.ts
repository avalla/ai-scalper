/**
 * CLI entrypoint — spawned by the worker as a long-running subprocess.
 * Reads env for credentials + config path, then enters the risk-officer loop.
 */

import IORedis from "ioredis";
import { createBybitClient } from "@ai-scalper/bybit-client";
import { readTraderConfig } from "../config";
import { runRiskOfficerLoop } from "./risk-officer-runner";
import { DEFAULT_RISK_THRESHOLDS, type RiskOfficerInput } from "./risk-officer";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const CLOSED_POSITIONS_KEY = "ai-scalper:trader:positions:closed";

async function main(): Promise<void> {
  const cfg = readTraderConfig(process.env);
  if (!cfg.riskOfficerEnabled) {
    console.log(JSON.stringify({ event: "risk-officer-disabled", reason: "riskOfficer.enabled=false" }));
    return;
  }
  const apiKey = process.env.BYBIT_API_KEY;
  const apiSecret = process.env.BYBIT_API_SECRET;
  const baseUrl = process.env.BYBIT_BASE_URL || "https://api.bybit.com";
  if (!apiKey || !apiSecret) {
    console.warn(JSON.stringify({ event: "risk-officer-disabled", reason: "missing BYBIT credentials" }));
    return;
  }
  const client = createBybitClient({ apiKey, apiSecret, baseUrl });
  const redis = process.env.REDIS_URL
    ? new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null })
    : null;

  const baselineEquityUsd = cfg.riskOfficerBaselineEquityUsd > 0 ? cfg.riskOfficerBaselineEquityUsd : 0;

  const collectInput = async (): Promise<RiskOfficerInput> => {
    let currentEquityUsd = 0;
    let totalOpenNotionalUsd = 0;
    let openPositionsCount = 0;
    try {
      const w = await client.getWalletBalance("UNIFIED");
      currentEquityUsd = Number((w as { result?: { list?: Array<{ totalEquity: string }> } }).result?.list?.[0]?.totalEquity ?? "0");
    } catch { /* ignore */ }
    for (const sym of [cfg.calendarPerpSymbol, cfg.calendarDatedSymbol].filter(Boolean) as string[]) {
      try {
        const p = await client.getPosition({ category: "linear", symbol: sym });
        if (p && Number(p.size) > 0) {
          openPositionsCount += 1;
          const refPrice = Number((p as { markPrice?: string }).markPrice || p.avgPrice || 0);
          totalOpenNotionalUsd += Number(p.size) * refPrice;
        }
      } catch { /* ignore */ }
    }

    let lastHourNetPnlUsd = 0;
    let consecutiveLosses = 0;
    if (redis) {
      try {
        const raw = await redis.lrange(CLOSED_POSITIONS_KEY, 0, 50);
        const now = Date.now();
        let stillCounting = true;
        for (const item of raw) {
          let entry: { closedAt?: string; realizedPnlUsd?: number };
          try { entry = JSON.parse(item); } catch { continue; }
          const closedTs = entry.closedAt ? Date.parse(entry.closedAt) : NaN;
          const pnl = Number(entry.realizedPnlUsd ?? 0);
          if (Number.isFinite(closedTs) && now - closedTs <= ONE_HOUR_MS) {
            lastHourNetPnlUsd += pnl;
          }
          if (stillCounting) {
            if (pnl < 0) consecutiveLosses += 1; else stillCounting = false;
          }
          if (Number.isFinite(closedTs) && now - closedTs > TWENTY_FOUR_HOURS_MS) break;
        }
      } catch { /* ignore */ }
    }

    return {
      currentEquityUsd,
      baselineEquityUsd,
      openPositionsCount,
      totalOpenNotionalUsd,
      lastHourNetPnlUsd,
      consecutiveLosses,
    };
  };

  const postWebhook = async (msg: string): Promise<void> => {
    const url = cfg.alertWebhookUrl;
    if (!url) return;
    try {
      await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: msg }) });
    } catch { /* ignore */ }
  };

  await runRiskOfficerLoop({
    config: {
      intervalMinutes: cfg.riskOfficerIntervalMinutes,
      outputPath: cfg.riskOfficerArtifactPath,
      alertWebhookUrl: cfg.alertWebhookUrl,
      baselineEquityUsd,
      thresholds: {
        ...DEFAULT_RISK_THRESHOLDS,
        yellowDrawdownPct: cfg.riskOfficerYellowDrawdownPct,
        redDrawdownPct: cfg.riskOfficerRedDrawdownPct,
        yellowLastHourLossUsd: cfg.riskOfficerYellowHourLossUsd,
        redLastHourLossUsd: cfg.riskOfficerRedHourLossUsd,
      },
    },
    collectInput,
    postWebhook,
  });
}

main().catch((err) => {
  console.error(JSON.stringify({ event: "risk-officer-fatal", error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
