import { describe, expect, test } from "bun:test";
import { parseConfigs, deriveStrategyName } from "./start-multi-strategy";

describe("parseConfigs", () => {
  test("returns empty array for undefined / empty / whitespace", () => {
    expect(parseConfigs(undefined)).toEqual([]);
    expect(parseConfigs("")).toEqual([]);
    expect(parseConfigs("   ")).toEqual([]);
  });

  test("splits comma-separated list, trims, drops empty", () => {
    expect(parseConfigs("a.json, b.json ,,c.json"))
      .toEqual(["a.json", "b.json", "c.json"]);
  });

  test("single entry → single-element array", () => {
    expect(parseConfigs("config.funding-arb.json"))
      .toEqual(["config.funding-arb.json"]);
  });
});

describe("deriveStrategyName", () => {
  test("strips `config.` prefix and `.json` suffix", () => {
    expect(deriveStrategyName("config.funding-arb.json")).toBe("funding-arb");
    expect(deriveStrategyName("config.basis-arb.json")).toBe("basis-arb");
  });
  test("falls back to identity if no prefix/suffix", () => {
    expect(deriveStrategyName("custom-name")).toBe("custom-name");
  });
});
