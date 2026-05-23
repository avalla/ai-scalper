import { describe, expect, test } from "bun:test";
import { summarizeTraderStdout } from "./trader-log-summary";

describe("summarizeTraderStdout", () => {
  test("drops a flat no-entry tick (no execution, no position)", () => {
    const summary = summarizeTraderStdout(JSON.stringify({
      event: "tick",
      action: "flat",
      aggressiveRisk: "allowed",
      intent: "no-entry",
      intentReason: "signal-flat",
      mode: "live",
      position: null,
      risk: "signal-flat",
      symbol: "RIVERUSDT",
      ticks: 6,
    }));

    expect(summary).toBeNull();
  });

  test("compacts always-log events like position-drift-detected", () => {
    const summary = summarizeTraderStdout(JSON.stringify({
      ts: "2026-01-01T00:00:00Z",
      event: "position-drift-detected",
      symbol: "BTCUSDT",
      drift: "missing-on-exchange",
      details: null,
    }));

    expect(summary).toContain("event=position-drift-detected");
    expect(summary).toContain("symbol=BTCUSDT");
    expect(summary).toContain("drift=missing-on-exchange");
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
