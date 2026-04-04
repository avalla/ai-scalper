import { describe, expect, test } from "bun:test";
import {
  rankCandidateSymbols,
  resolveCandidateSymbols,
  selectActiveSymbol,
} from "./select-active-symbol";

describe("resolveCandidateSymbols", () => {
  test("prefers explicitly configured trade candidates", () => {
    expect(resolveCandidateSymbols({
      configuredSymbol: "BTCUSDT",
      tradeCandidateSymbols: ["ETHUSDT", "SOLUSDT"],
      scanCandidateSymbols: ["BTCUSDT"],
    })).toEqual(["ETHUSDT", "SOLUSDT"]);
  });

  test("falls back to scan candidates when explicit list is empty", () => {
    expect(resolveCandidateSymbols({
      configuredSymbol: "BTCUSDT",
      tradeCandidateSymbols: [],
      scanCandidateSymbols: ["ETHUSDT", "SOLUSDT"],
    })).toEqual(["ETHUSDT", "SOLUSDT"]);
  });

  test("falls back to configured symbol when no candidates exist", () => {
    expect(resolveCandidateSymbols({
      configuredSymbol: "BTCUSDT",
      tradeCandidateSymbols: [],
      scanCandidateSymbols: [],
    })).toEqual(["BTCUSDT"]);
  });
});

describe("rankCandidateSymbols", () => {
  test("orders symbols by the strongest observed metrics first", () => {
    expect(rankCandidateSymbols({
      candidateSymbols: ["ETHUSDT", "SOLUSDT", "BTCUSDT"],
      symbolMetrics: {
        ETHUSDT: {
          hourlyMoveBps: 120,
          netEdgeBps: 12,
          spreadBps: 0.5,
          fundingRateBps: 1,
          observedAt: "2026-04-01T10:00:00.000Z",
        },
        BTCUSDT: {
          hourlyMoveBps: 60,
          netEdgeBps: 6,
          spreadBps: 0.1,
          fundingRateBps: 0.5,
          observedAt: "2026-04-01T10:00:00.000Z",
        },
      },
    })).toEqual(["ETHUSDT", "BTCUSDT", "SOLUSDT"]);
  });
});

describe("selectActiveSymbol", () => {
  test("keeps the open position symbol active", () => {
    expect(selectActiveSymbol({
      candidateSymbols: ["ETHUSDT", "SOLUSDT"],
      fallbackSymbol: "BTCUSDT",
      openPositionSymbol: "ETHUSDT",
      rotationTick: 1,
    })).toEqual({
      symbol: "ETHUSDT",
      rankedSymbols: ["ETHUSDT", "SOLUSDT"],
      reason: "open-position",
    });
  });

  test("prefers the best observed symbol while flat", () => {
    expect(selectActiveSymbol({
      candidateSymbols: ["ETHUSDT", "SOLUSDT", "BTCUSDT"],
      fallbackSymbol: "BTCUSDT",
      openPositionSymbol: null,
      rotationTick: 2,
      symbolMetrics: {
        BTCUSDT: {
          hourlyMoveBps: 40,
          netEdgeBps: 4,
          spreadBps: 0.1,
          fundingRateBps: 0.5,
          observedAt: "2026-04-01T10:00:00.000Z",
        },
        ETHUSDT: {
          hourlyMoveBps: 20,
          netEdgeBps: 3,
          spreadBps: 0.9,
          fundingRateBps: 1.5,
          observedAt: "2026-04-01T10:00:00.000Z",
        },
        SOLUSDT: {
          hourlyMoveBps: 110,
          netEdgeBps: 14,
          spreadBps: 0.8,
          fundingRateBps: 1,
          observedAt: "2026-04-01T10:00:00.000Z",
        },
      },
    })).toEqual({
      symbol: "SOLUSDT",
      rankedSymbols: ["SOLUSDT", "BTCUSDT", "ETHUSDT"],
      reason: "best-observed",
    });
  });

  test("keeps rotating until every candidate has been observed", () => {
    expect(selectActiveSymbol({
      candidateSymbols: ["ETHUSDT", "SOLUSDT", "BTCUSDT"],
      fallbackSymbol: "BTCUSDT",
      openPositionSymbol: null,
      rotationTick: 2,
      symbolMetrics: {
        SOLUSDT: {
          hourlyMoveBps: 110,
          netEdgeBps: 14,
          spreadBps: 0.8,
          fundingRateBps: 1,
          observedAt: "2026-04-01T10:00:00.000Z",
        },
      },
    })).toEqual({
      symbol: "BTCUSDT",
      rankedSymbols: ["SOLUSDT", "ETHUSDT", "BTCUSDT"],
      reason: "candidate-rotation",
    });
  });

  test("rotates across candidate symbols when nothing has been observed yet", () => {
    expect(selectActiveSymbol({
      candidateSymbols: ["ETHUSDT", "SOLUSDT", "BTCUSDT"],
      fallbackSymbol: "BTCUSDT",
      openPositionSymbol: null,
      rotationTick: 4,
      symbolMetrics: {},
    })).toEqual({
      symbol: "SOLUSDT",
      rankedSymbols: ["ETHUSDT", "SOLUSDT", "BTCUSDT"],
      reason: "candidate-rotation",
    });
  });

  test("uses fallback when no candidate symbols are available", () => {
    expect(selectActiveSymbol({
      candidateSymbols: [],
      fallbackSymbol: "BTCUSDT",
      openPositionSymbol: null,
      rotationTick: 0,
    })).toEqual({
      symbol: "BTCUSDT",
      rankedSymbols: ["BTCUSDT"],
      reason: "fallback",
    });
  });
});
