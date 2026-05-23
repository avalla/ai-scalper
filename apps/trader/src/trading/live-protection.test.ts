import { describe, expect, test } from "bun:test";
import { buildExchangeProtectionPrices } from "./live-protection";

describe("buildExchangeProtectionPrices", () => {
  const instrument = {
    priceFilter: {
      tickSize: "0.01",
    },
  } as const;

  test("formats long TP and SL on exchange ticks", () => {
    expect(buildExchangeProtectionPrices({
      action: "long",
      entryPrice: 100,
      instrument: instrument as never,
      stopLossBps: 20,
      takeProfitBps: 30,
    })).toEqual({
      stopLoss: "99.80",
      takeProfit: "100.30",
    });
  });

  test("formats short TP and SL on exchange ticks", () => {
    expect(buildExchangeProtectionPrices({
      action: "short",
      entryPrice: 100,
      instrument: instrument as never,
      stopLossBps: 20,
      takeProfitBps: 30,
    })).toEqual({
      stopLoss: "100.20",
      takeProfit: "99.70",
    });
  });
});
