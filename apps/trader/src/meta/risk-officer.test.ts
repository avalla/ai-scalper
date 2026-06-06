import { describe, expect, test } from "bun:test";
import { assessRisk, DEFAULT_RISK_THRESHOLDS } from "./risk-officer";

describe("assessRisk", () => {
  const baseline = {
    currentEquityUsd: 200,
    baselineEquityUsd: 200,
    openPositionsCount: 0,
    totalOpenNotionalUsd: 0,
    lastHourNetPnlUsd: 0,
    consecutiveLosses: 0,
  };

  test("green when all indicators within bounds", () => {
    const v = assessRisk(baseline);
    expect(v.severity).toBe("green");
    expect(v.suggestedAction).toBe("continue");
  });

  test("yellow on 3% drawdown", () => {
    const v = assessRisk({ ...baseline, currentEquityUsd: 193 });
    expect(v.severity).toBe("yellow");
    expect(v.suggestedAction).toBe("reduce-size");
  });

  test("red on 6% drawdown → close-all (since drawdown is the trigger)", () => {
    const v = assessRisk({ ...baseline, currentEquityUsd: 187 });
    expect(v.severity).toBe("red");
    expect(v.suggestedAction).toBe("close-all");
  });

  test("yellow on 60% exposure ratio", () => {
    const v = assessRisk({ ...baseline, totalOpenNotionalUsd: 120 });
    expect(v.severity).toBe("yellow");
  });

  test("red on consecutive losses only → halt-new-entries (not close-all)", () => {
    const v = assessRisk({ ...baseline, consecutiveLosses: 5 });
    expect(v.severity).toBe("red");
    // No drawdown / hourly loss trigger → halt-new-entries (don't churn closes)
    expect(v.suggestedAction).toBe("halt-new-entries");
  });

  test("takes worst severity across dimensions", () => {
    const v = assessRisk({
      ...baseline,
      currentEquityUsd: 193, // 3.5% drawdown → yellow
      lastHourNetPnlUsd: -7, // -7 USD → red threshold (6)
    });
    expect(v.severity).toBe("red");
    expect(v.reasons.length).toBeGreaterThanOrEqual(2);
  });

  test("hourly profit (positive lastHourNetPnlUsd) does not escalate", () => {
    const v = assessRisk({ ...baseline, lastHourNetPnlUsd: 50 });
    expect(v.severity).toBe("green");
  });

  test("custom thresholds override defaults", () => {
    const v = assessRisk(
      { ...baseline, currentEquityUsd: 199 }, // 0.5% drawdown
      { ...DEFAULT_RISK_THRESHOLDS, yellowDrawdownPct: 0.2, redDrawdownPct: 0.4 },
    );
    expect(v.severity).toBe("red");
  });
});
