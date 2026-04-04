import { readScanConfig, scanMarket } from "@ai-scalper/market-scanner";
import { readTraderConfig } from "./config";
import { runTrader } from "./trading/run-trader";

async function main(): Promise<void> {
  const traderConfig = readTraderConfig();

  if (traderConfig.mode === "scan") {
    const result = await scanMarket(readScanConfig());
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  await runTrader(traderConfig);
}

void main();
