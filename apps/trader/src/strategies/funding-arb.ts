/**
 * Funding-rate arbitrage strategy (pure decision module — no I/O).
 *
 * Idea: Bybit perpetuals pay funding every ~8 hours. If funding is positive,
 * longs pay shorts → we open SHORT just before payout, collect funding, close
 * shortly after. If funding is negative, longs receive funding → we open LONG.
 *
 * We do NOT hedge spot; this is a directional bet that funding payment exceeds
 * any short-term price drift during our holding window. The narrow holding
 * window (entryWindowMinutesBefore + exitDelayMinutesAfter, typically a few
 * minutes) keeps drift exposure small.
 */

export interface FundingArbSignalInput {
  /** Funding rate in basis points (positive = longs pay, negative = shorts pay). */
  fundingRateBps: number;
  /** Unix ms of next funding payout. */
  nextFundingTime: number;
  /** Current Date.now() at this tick. */
  now: number;
  symbol: string;
  hasOpenPosition: boolean;
  /** Funding event we opened the current position for, if any. */
  openPositionEnteredForFundingTime?: number;
  config: {
    /** Minimum |funding rate| in bps to consider opening. Strict less-than. */
    minAbsRateBps: number;
    /** Open this many minutes before nextFundingTime. */
    entryWindowMinutesBefore: number;
    /** Close this many minutes after the funding event. */
    exitDelayMinutesAfter: number;
  };
}

export type FundingArbDecision =
  | { kind: "enter"; side: "long" | "short"; reason: string; fundingTimeTarget: number }
  | { kind: "exit"; reason: string }
  | { kind: "hold"; reason: string };

export function fundingArbDecide(input: FundingArbSignalInput): FundingArbDecision {
  if (input.hasOpenPosition) {
    if (input.openPositionEnteredForFundingTime === undefined) {
      // Safety: can't reason about exit window without a target — hold.
      return { kind: "hold", reason: "no-funding-target-on-position" };
    }
    const exitDeadlineMs =
      input.openPositionEnteredForFundingTime + input.config.exitDelayMinutesAfter * 60_000;
    if (input.now >= exitDeadlineMs) {
      return { kind: "exit", reason: "after-funding-payout" };
    }
    return { kind: "hold", reason: "waiting-for-payout" };
  }

  if (Math.abs(input.fundingRateBps) < input.config.minAbsRateBps) {
    return { kind: "hold", reason: "funding-rate-too-low" };
  }

  const minutesToFunding = (input.nextFundingTime - input.now) / 60_000;

  if (minutesToFunding < 0) {
    return { kind: "hold", reason: "funding-passed" };
  }

  if (minutesToFunding > input.config.entryWindowMinutesBefore) {
    return { kind: "hold", reason: "too-early" };
  }

  // Positive funding rate => longs pay shorts => we short to receive funding.
  // Negative funding rate => shorts pay longs => we go long.
  const side: "long" | "short" = input.fundingRateBps > 0 ? "short" : "long";
  return {
    kind: "enter",
    side,
    reason: `funding-arb-entry:${input.fundingRateBps.toFixed(2)}bps`,
    fundingTimeTarget: input.nextFundingTime,
  };
}
