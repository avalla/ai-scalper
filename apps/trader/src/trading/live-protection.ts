import { buildPositionTargets, type PositionSide } from "@ai-scalper/trading-core";
import type { InstrumentInfo } from "@ai-scalper/bybit-client";

function countDecimals(value: string): number {
  const parts = value.split(".");
  return parts[1]?.length ?? 0;
}

function toTickSize(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid tick size: ${value}`);
  }
  return parsed;
}

function roundToTick(value: number, tickSize: number): number {
  return Math.round(value / tickSize) * tickSize;
}

export function buildExchangeProtectionPrices(params: {
  action: PositionSide;
  entryPrice: number;
  instrument: InstrumentInfo;
  stopLossBps: number;
  takeProfitBps: number;
}): {
  stopLoss: string;
  takeProfit: string;
} {
  const tickSize = toTickSize(params.instrument.priceFilter.tickSize);
  const decimals = countDecimals(params.instrument.priceFilter.tickSize);
  const targets = buildPositionTargets({
    action: params.action,
    price: params.entryPrice,
    stopLossBps: params.stopLossBps,
    takeProfitBps: params.takeProfitBps,
  });

  return {
    stopLoss: roundToTick(targets.stopLossPrice, tickSize).toFixed(decimals),
    takeProfit: roundToTick(targets.takeProfitPrice, tickSize).toFixed(decimals),
  };
}
