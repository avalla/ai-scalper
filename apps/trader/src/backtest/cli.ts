#!/usr/bin/env bun
/**
 * Backtest CLI: `bun run backtest <scenario.json>`.
 *
 * Loads a JSON scenario file, fetches klines (with disk cache), runs the
 * pure backtest engine, prints aggregate stats + per-trade list to stdout.
 *
 * Klines are fetched from Bybit MAINNET regardless of paper/live trading
 * settings — backtests should always use real market data.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createBybitClient } from "@ai-scalper/bybit-client";
import { runBacktest, type BacktestScenario } from "./backtest-engine";
import { fetchHistoricalKlines } from "./historical-data";

function usage(): never {
  console.error("Usage: bun run backtest <path/to/scenario.json>");
  process.exit(2);
}

async function main(): Promise<void> {
  const scenarioPath = process.argv[2];
  if (!scenarioPath) usage();
  const abs = resolve(process.cwd(), scenarioPath);
  if (!existsSync(abs)) {
    console.error(`scenario not found: ${abs}`);
    process.exit(2);
  }

  const scenario = JSON.parse(readFileSync(abs, "utf8")) as BacktestScenario;

  const baseUrl = process.env.BYBIT_SCAN_BASE_URL ?? "https://api.bybit.com";
  const client = createBybitClient({ baseUrl });

  const result = await runBacktest(scenario, {
    fetchKlines: (params) => fetchHistoricalKlines(params, {
      fetchKlinesFromApi: async (p) => client.getKlines({
        category: "linear",
        symbol: p.symbol,
        interval: p.interval,
        // Bybit caps limit=1000; for v1 we accept the most-recent N bars.
        limit: 1000,
      }),
    }),
  });

  console.log(JSON.stringify({
    name: result.scenario.name,
    symbol: result.scenario.symbol,
    interval: result.scenario.klineInterval,
    range: `${result.scenario.startDate}..${result.scenario.endDate}`,
    totalTicks: result.totalTicks,
    tradesOpened: result.tradesOpened,
    tradesClosed: result.tradesClosed,
    wins: result.wins,
    losses: result.losses,
    winRate: result.winRate,
    grossPnlUsd: result.grossPnlUsd,
    feesUsd: result.feesUsd,
    netPnlUsd: result.netPnlUsd,
    maxDrawdownUsd: result.maxDrawdownUsd,
    sharpeAnnualizedScalp: result.sharpeAnnualizedScalp,
  }, null, 2));

  if (result.trades.length > 0) {
    console.log("\nTrades:");
    for (const t of result.trades) {
      console.log(JSON.stringify(t));
    }
  }
}

if (import.meta.main) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err instanceof Error ? err.stack : String(err));
      process.exit(1);
    });
}
