import { describe, expect, test } from "bun:test";
import { clampLeverage, MAX_LEVERAGE_ALLOWED } from "./config";

describe("clampLeverage", () => {
  test("undefined / 0 / negative / NaN → 1 (legacy unleveraged)", () => {
    expect(clampLeverage(undefined, "x")).toBe(1);
    expect(clampLeverage(0, "x")).toBe(1);
    expect(clampLeverage(-3, "x")).toBe(1);
    expect(clampLeverage(Number.NaN, "x")).toBe(1);
  });

  test("values inside [1, MAX] are passed through", () => {
    expect(clampLeverage(1, "x")).toBe(1);
    expect(clampLeverage(5, "x")).toBe(5);
    expect(clampLeverage(MAX_LEVERAGE_ALLOWED, "x")).toBe(MAX_LEVERAGE_ALLOWED);
  });

  test("values above MAX are clamped to MAX (the safety ceiling)", () => {
    expect(clampLeverage(MAX_LEVERAGE_ALLOWED + 1, "x")).toBe(MAX_LEVERAGE_ALLOWED);
    expect(clampLeverage(100, "x")).toBe(MAX_LEVERAGE_ALLOWED);
  });
});
