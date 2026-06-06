/**
 * Risk Officer background loop. Collects state from Bybit + Redis ledger,
 * runs assessRisk, writes artifact + optional webhook + structured log.
 * Advisory only — does not mutate the trader.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { assessRisk, type RiskOfficerInput, type RiskOfficerThresholds, type RiskVerdict } from "./risk-officer";

export interface RiskOfficerRunnerConfig {
  intervalMinutes: number;
  outputPath: string;
  alertWebhookUrl: string;
  baselineEquityUsd: number;
  thresholds: RiskOfficerThresholds;
}

export interface RiskOfficerRunnerDeps {
  config: RiskOfficerRunnerConfig;
  collectInput: () => Promise<RiskOfficerInput>;
  postWebhook: (msg: string) => Promise<void>;
  log?: (payload: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  shouldStop?: () => boolean;
  maxIterations?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function writeArtifact(path: string, input: RiskOfficerInput, verdict: RiskVerdict): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const payload = {
      generatedAt: new Date().toISOString(),
      input,
      verdict,
    };
    await writeFile(path, JSON.stringify(payload, null, 2), "utf-8");
  } catch (err) {
    console.warn(JSON.stringify({
      ts: new Date().toISOString(),
      event: "risk-officer-artifact-write-failed",
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

export async function runRiskOfficerLoop(deps: RiskOfficerRunnerDeps): Promise<void> {
  const { config } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? ((p) => console.log(JSON.stringify(p)));
  const intervalMs = Math.max(config.intervalMinutes * 60_000, 30_000);
  const shouldStop = deps.shouldStop ?? (() => false);
  let iteration = 0;
  let lastSeverity: RiskVerdict["severity"] | null = null;

  log({ ts: new Date().toISOString(), event: "risk-officer-loop-started", intervalMinutes: config.intervalMinutes });

  while (!shouldStop()) {
    if (deps.maxIterations !== undefined && iteration >= deps.maxIterations) break;
    iteration += 1;

    let input: RiskOfficerInput;
    try {
      input = await deps.collectInput();
    } catch (err) {
      log({ ts: new Date().toISOString(), event: "risk-officer-collect-failed", error: err instanceof Error ? err.message : String(err) });
      await sleep(intervalMs);
      continue;
    }

    const inputWithBaseline = { ...input, baselineEquityUsd: input.baselineEquityUsd || config.baselineEquityUsd };
    const verdict = assessRisk(inputWithBaseline, config.thresholds);

    await writeArtifact(config.outputPath, inputWithBaseline, verdict);

    log({
      ts: new Date().toISOString(),
      event: "risk-officer-verdict",
      severity: verdict.severity,
      suggestedAction: verdict.suggestedAction,
      drawdownPct: Number(verdict.drawdownPct.toFixed(2)),
      exposureRatio: Number(verdict.exposureRatio.toFixed(2)),
      equity: input.currentEquityUsd,
      reasons: verdict.reasons,
    });

    // Webhook only on severity change (avoid spam).
    if (verdict.severity !== "green" && verdict.severity !== lastSeverity && config.alertWebhookUrl) {
      try {
        await deps.postWebhook(
          `⚠️ Risk Officer: ${verdict.severity.toUpperCase()} — ${verdict.suggestedAction}\n` +
          `Equity: $${input.currentEquityUsd.toFixed(2)} (drawdown ${verdict.drawdownPct.toFixed(2)}%)\n` +
          `Reasons: ${verdict.reasons.join("; ")}`,
        );
      } catch { /* ignore */ }
    }
    lastSeverity = verdict.severity;

    await sleep(intervalMs);
  }
}
