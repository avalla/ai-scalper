import { describe, expect, test } from "bun:test";
import {
  deriveTradeActionFromTrend,
  deriveTrendBpsFromKlines,
} from "./index";

describe("market scanner trend helpers", () => {
  test("derives positive trend from ascending klines regardless of input order", () => {
    expect(deriveTrendBpsFromKlines([
      {
        startTime: "2000",
        openPrice: "101",
        highPrice: "102",
        lowPrice: "100",
        closePrice: "102",
        volume: "1",
        turnover: "1",
      },
      {
        startTime: "1000",
        openPrice: "100",
        highPrice: "101",
        lowPrice: "99",
        closePrice: "101",
        volume: "1",
        turnover: "1",
      },
    ])).toBeCloseTo(200);
  });

  test("maps trend basis points to long short or flat", () => {
    expect(deriveTradeActionFromTrend(5, 3)).toBe("long");
    expect(deriveTradeActionFromTrend(-5, 3)).toBe("short");
    expect(deriveTradeActionFromTrend(2, 3)).toBe("flat");
  });
});

describe("market scanner trend helpers - edge cases", () => {
  test("returns 0 for an empty kline array", () => {
    expect(deriveTrendBpsFromKlines([])).toBe(0);
  });

  test("derives negative trend from descending klines", () => {
    expect(deriveTrendBpsFromKlines([
      {
        startTime: "1000",
        openPrice: "100",
        highPrice: "101",
        lowPrice: "99",
        closePrice: "101",
        volume: "1",
        turnover: "1",
      },
      {
        startTime: "2000",
        openPrice: "101",
        highPrice: "102",
        lowPrice: "98",
        closePrice: "98",
        volume: "1",
        turnover: "1",
      },
    ])).toBeCloseTo(-200);
  });

  test("maps trend at exactly the threshold to long", () => {
    expect(deriveTradeActionFromTrend(3, 3)).toBe("long");
  });

  test("maps trend at exactly the negative threshold to short", () => {
    expect(deriveTradeActionFromTrend(-3, 3)).toBe("short");
  });
});
