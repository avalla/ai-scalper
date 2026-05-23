import { describe, expect, test } from "bun:test";
import { summarizeTraderStdout } from "./trader-log-summary";

describe("summarizeTraderStdout", () => {
  test("renders a no-entry summary for flat signals", () => {
    const summary = summarizeTraderStdout(JSON.stringify({
      action: "flat",
      aggressiveRisk: "allowed",
      intent: "no-entry",
      intentReason: "signal-flat",
      mode: "live",
      position: null,
      rankedSetupsTop: [
        { action: "flat", score: 51.2, symbol: "RIVERUSDT" },
        { action: "long", score: 48.7, symbol: "EDGEUSDT" },
      ],
      risk: "signal-flat",
      symbol: "RIVERUSDT",
      ticks: 6,
    }));

    expect(summary).toBe(
      "mode=live pair=RIVERUSDT signal=flat ticks=6 top=RIVERUSDT:flat@51.2,EDGEUSDT:long@48.7 intent=no-entry reason=signal-flat risk=signal-flat position=flat",
    );
  });

  test("renders an open-long summary with execution details", () => {
    const summary = summarizeTraderStdout(JSON.stringify({
      action: "long",
      aggressiveRisk: "allowed",
      intent: "open-long",
      lastExecution: {
        executionMode: "taker",
        filled: true,
      },
      mode: "live",
      position: {
        entryPrice: 101.2,
        side: "long",
      },
      risk: "allowed",
      symbol: "BTCUSDT",
      ticks: 20,
    }));

    expect(summary).toBe(
      "mode=live pair=BTCUSDT signal=long ticks=20 intent=open-long execution=taker filled=true position=long entry=101.2",
    );
  });
});
