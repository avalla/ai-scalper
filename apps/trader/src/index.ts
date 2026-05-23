import { createBybitClient } from "@ai-scalper/bybit-client";
import { readScanConfig, scanMarket } from "@ai-scalper/market-scanner";
import { readTraderConfig } from "./config";
import { runTrader } from "./trading/run-trader";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Resolve available USDT balance from a Bybit wallet response,
 * preferring coin-level usdValue (matches wallet-sizing.ts logic).
 */
function resolveAvailableUsd(
  raw: unknown,
  walletCoin: string,
): number | null {
  if (!isRecord(raw)) return null;
  const result = isRecord(raw.result) ? raw.result : null;
  const list = Array.isArray(result?.list) ? result.list : [];
  const account = list.find((entry: unknown) => isRecord(entry)) as Record<string, unknown> | undefined;
  if (!isRecord(account)) return null;

  const coins = Array.isArray(account.coin) ? account.coin : [];
  const coinEntry = coins.find(
    (c: unknown) => isRecord(c) && c.coin === walletCoin,
  ) as Record<string, unknown> | undefined;
  const coinUsdValue = isRecord(coinEntry) ? toNumber(coinEntry.usdValue) : null;
  const totalAvailableBalance = toNumber(account.totalAvailableBalance);

  return coinUsdValue ?? totalAvailableBalance;
}

async function checkBudget(config: ReturnType<typeof readTraderConfig>): Promise<void> {
  const client = createBybitClient({
    baseUrl: process.env.BYBIT_BASE_URL,
  });

  const raw = await client.getWalletBalance(config.walletAccountType);
  const availableBalance = resolveAvailableUsd(raw, config.walletCoin);

  if (availableBalance === null || availableBalance <= 0) {
    console.error(JSON.stringify({
      event: "budget-check",
      status: "insufficient",
      reason: "no-available-balance",
      rawResponse: raw,
    }));
    process.exit(1);
  }

  // orderUsd IS the margin required (notional = orderUsd * leverage, margin = orderUsd).
  // Add a safety buffer for fees + rounding (10% or , whichever is larger).
  const feeBuffer = Math.max(config.orderUsd * 0.1, 1);
  const requiredMargin = config.orderUsd + feeBuffer;

  if (availableBalance < requiredMargin) {
    console.error(JSON.stringify({
      event: "budget-check",
      status: "insufficient",
      availableUsd: availableBalance,
      requiredMarginUsd: Number(requiredMargin.toFixed(2)),
      orderUsd: config.orderUsd,
      leverage: config.leverage,
      feeBufferUsd: Number(feeBuffer.toFixed(2)),
    }));
    process.exit(1);
  }

  console.log(JSON.stringify({
    event: "budget-check",
    status: "ok",
    availableUsd: availableBalance,
    requiredMarginUsd: requiredMargin,
  }));
}

async function main(): Promise<void> {
  const traderConfig = readTraderConfig();

  const traderMode = traderConfig.paperTrading ? "paper" : "live";
  const traderNetwork = (process.env.BYBIT_BASE_URL || "").includes("testnet") ? "testnet" : "mainnet";
  const traderConfigFile = process.env.CONFIG_FILE || "(default config.json)";

  console.log(JSON.stringify({
    app: "ai-scalper-trader",
    mode: traderMode,
    network: traderNetwork,
    configFile: traderConfigFile,
    profile: traderConfig.tradingProfile,
    executionMode: traderConfig.entryExecutionMode,
    symbol: traderConfig.symbol,
    leverage: traderConfig.leverage,
    orderUsd: traderConfig.orderUsd,
    stopLossBps: traderConfig.stopLossBps,
    takeProfitBps: traderConfig.takeProfitBps,
    pollMs: traderConfig.pollMs,
  }, null, 2));

  if (traderConfig.mode === "scan") {
    const result = await scanMarket(readScanConfig());
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!traderConfig.paperTrading) {
    await checkBudget(traderConfig);
  }

  await runTrader(traderConfig);
}

void main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.stack ?? error.message);
  } else {
    console.error(String(error));
  }

  process.exitCode = 1;
});
