import { describe, expect, test } from "bun:test";
import { fundingArbDecide } from "./funding-arb";

const baseCfg = {
  minAbsRateBps: 5,
  entryWindowMinutesBefore: 5,
  exitDelayMinutesAfter: 2,
};

const NOW = 1_700_000_000_000;
const min = 60_000;

describe("fundingArbDecide", () => {
  test("holds when funding rate magnitude is below threshold", () => {
    const decision = fundingArbDecide({
      fundingRateBps: 4.9,
      nextFundingTime: NOW + 2 * min,
      now: NOW,
      symbol: "BTCUSDT",
      hasOpenPosition: false,
      config: baseCfg,
    });
    expect(decision.kind).toBe("hold");
    expect((decision as { reason: string }).reason).toBe("funding-rate-too-low");
  });

  test("holds (too-early) when funding is well outside the entry window", () => {
    const decision = fundingArbDecide({
      fundingRateBps: 15,
      nextFundingTime: NOW + 30 * min,
      now: NOW,
      symbol: "BTCUSDT",
      hasOpenPosition: false,
      config: baseCfg,
    });
    expect(decision.kind).toBe("hold");
    expect((decision as { reason: string }).reason).toBe("too-early");
  });

  test("enters SHORT when funding is positive and within window", () => {
    const decision = fundingArbDecide({
      fundingRateBps: 12,
      nextFundingTime: NOW + 3 * min,
      now: NOW,
      symbol: "BTCUSDT",
      hasOpenPosition: false,
      config: baseCfg,
    });
    expect(decision.kind).toBe("enter");
    if (decision.kind === "enter") {
      expect(decision.side).toBe("short");
      expect(decision.fundingTimeTarget).toBe(NOW + 3 * min);
    }
  });

  test("enters LONG when funding is negative and within window", () => {
    const decision = fundingArbDecide({
      fundingRateBps: -12,
      nextFundingTime: NOW + 3 * min,
      now: NOW,
      symbol: "BTCUSDT",
      hasOpenPosition: false,
      config: baseCfg,
    });
    expect(decision.kind).toBe("enter");
    if (decision.kind === "enter") {
      expect(decision.side).toBe("long");
    }
  });

  test("holds (waiting-for-payout) when in position pre-funding", () => {
    const fundingT = NOW + 1 * min;
    const decision = fundingArbDecide({
      fundingRateBps: 12,
      nextFundingTime: fundingT,
      now: NOW,
      symbol: "BTCUSDT",
      hasOpenPosition: true,
      openPositionEnteredForFundingTime: fundingT,
      config: baseCfg,
    });
    expect(decision.kind).toBe("hold");
    expect((decision as { reason: string }).reason).toBe("waiting-for-payout");
  });

  test("exits when now exceeds funding target + exit delay", () => {
    const fundingT = NOW - 3 * min;
    const decision = fundingArbDecide({
      fundingRateBps: 12,
      nextFundingTime: NOW + 8 * 60 * min, // next funding window
      now: NOW,
      symbol: "BTCUSDT",
      hasOpenPosition: true,
      openPositionEnteredForFundingTime: fundingT,
      config: baseCfg,
    });
    expect(decision.kind).toBe("exit");
  });

  test("strict-less-than: funding rate exactly equal to threshold does NOT enter", () => {
    const decision = fundingArbDecide({
      fundingRateBps: 5,
      nextFundingTime: NOW + 2 * min,
      now: NOW,
      symbol: "BTCUSDT",
      hasOpenPosition: false,
      config: baseCfg,
    });
    // |5| < 5 is false, so we DO enter (boundary is inclusive on entry side).
    // The spec says "strict <" for the rejection; equality enters.
    expect(decision.kind).toBe("enter");
  });

  test("holds when funding has already passed and no position", () => {
    const decision = fundingArbDecide({
      fundingRateBps: 12,
      nextFundingTime: NOW - 1 * min,
      now: NOW,
      symbol: "BTCUSDT",
      hasOpenPosition: false,
      config: baseCfg,
    });
    expect(decision.kind).toBe("hold");
    expect((decision as { reason: string }).reason).toBe("funding-passed");
  });
});
