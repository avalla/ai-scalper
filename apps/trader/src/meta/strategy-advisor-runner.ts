/**
 * Background loop wrapping the LLM strategy advisor. Periodically collects
 * regime + performance, calls the advisor, then:
 *   - Writes the recommendation to a runtime JSON artifact for the operator
 *   - Posts to the configured webhook (if any)
 *   - Emits a structured log line
 *
 * NEVER mutates the running trader's strategy — advisory only in v1.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  getStrategyRecommendation,
  type AdvisorRecommendation,
  type MarketRegimeSnapshot,
  type RecentStrategyPerformance,
} from "./strategy-advisor";

export interface AdvisorRunnerConfig {
  intervalMinutes: number;
  apiKey: string | null;
  model: string;
  alertWebhookUrl: string;
  outputPath: string;
}

export interface AdvisorRunnerDeps {
  config: AdvisorRunnerConfig;
  collectRegime: () => Promise<MarketRegimeSnapshot>;
  collectPerformance: () => Promise<RecentStrategyPerformance[]>;
  postWebhook: (msg: string, ctx?: Record<string, unknown>) => Promise<void>;
  /** Test hook — overrides the default real-LLM call. */
  recommendOverride?: (
    regime: MarketRegimeSnapshot,
    performance: RecentStrategyPerformance[],
  ) => Promise<AdvisorRecommendation>;
  /** Test hook — sleep impl. Defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Test hook — when set, exits the loop after N iterations. */
  maxIterations?: number;
  /** Test hook — abort signal. */
  shouldStop?: () => boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function writeArtifact(path: string, rec: AdvisorRecommendation, regime: MarketRegimeSnapshot): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const payload = {
      observedAt: regime.observedAt,
      generatedAt: new Date().toISOString(),
      recommendation: rec,
      regimeSnapshot: regime,
    };
    await writeFile(path, JSON.stringify(payload, null, 2), "utf-8");
  } catch (err) {
    console.warn(JSON.stringify({
      ts: new Date().toISOString(),
      event: "advisor-artifact-write-failed",
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

export async function runStrategyAdvisorLoop(deps: AdvisorRunnerDeps): Promise<void> {
  const { config } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const intervalMs = Math.max(config.intervalMinutes * 60_000, 1_000);
  const shouldStop = deps.shouldStop ?? (() => false);

  if (!config.apiKey || config.apiKey.trim() === "") {
    console.warn(JSON.stringify({
      ts: new Date().toISOString(),
      event: "advisor-disabled",
      reason: "ANTHROPIC_API_KEY not set — advisor will not run",
    }));
    return;
  }

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    event: "advisor-loop-started",
    intervalMinutes: config.intervalMinutes,
    model: config.model,
  }));

  let iteration = 0;
  while (!shouldStop()) {
    iteration += 1;
    const t0 = Date.now();
    try {
      const [regime, performance] = await Promise.all([
        deps.collectRegime(),
        deps.collectPerformance(),
      ]);

      const rec = deps.recommendOverride
        ? await deps.recommendOverride(regime, performance)
        : await getStrategyRecommendation({
            regime,
            performance,
            apiKey: config.apiKey,
            model: config.model,
          });

      await writeArtifact(config.outputPath, rec, regime);

      const webhookMsg = `[ADVISOR] Recommends ${rec.recommendedStrategy} (confidence ${rec.confidence.toFixed(2)}): ${rec.reasoning}`;
      await deps.postWebhook(webhookMsg, {
        recommendation: rec,
        observedAt: regime.observedAt,
      }).catch(() => {});

      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        event: "advisor-recommendation",
        recommendedStrategy: rec.recommendedStrategy,
        confidence: rec.confidence,
        reasoning: rec.reasoning,
        latencyMs: Date.now() - t0,
        iteration,
      }));
    } catch (err) {
      console.warn(JSON.stringify({
        ts: new Date().toISOString(),
        event: "advisor-iteration-error",
        error: err instanceof Error ? err.message : String(err),
      }));
    }

    if (deps.maxIterations !== undefined && iteration >= deps.maxIterations) {
      break;
    }
    if (shouldStop()) break;
    await sleep(intervalMs);
  }

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    event: "advisor-loop-exited",
    iterations: iteration,
  }));
}
