/**
 * Risk Officer — deterministic risk monitor. Runs every N minutes, computes a
 * traffic-light verdict from wallet equity, open exposure, and recent loss
 * velocity. Emits structured alerts; advisory-only (does not halt the trader
 * by itself, but the operator/webhook can act on `severity = red`).
 *
 * Cost: zero LLM tokens. Deterministic rules only. An LLM-backed "interpreter"
 * can be layered on top later if we want narrative for yellow/red cases.
 */

export type RiskSeverity = "green" | "yellow" | "red";

export interface RiskOfficerInput {
  /** Current wallet equity (USDT). */
  currentEquityUsd: number;
  /** Baseline equity used to compute drawdown (e.g., starting capital or
   *  rolling 7-day max). */
  baselineEquityUsd: number;
  /** Number of open positions across all symbols. */
  openPositionsCount: number;
  /** Sum of |position notional| in USDT across open positions. */
  totalOpenNotionalUsd: number;
  /** Realised pnl summed across closed trades in the last hour. */
  lastHourNetPnlUsd: number;
  /** Number of consecutive losing closed trades. */
  consecutiveLosses: number;
}

export interface RiskOfficerThresholds {
  /** Drawdown vs baseline above which we go YELLOW. Default 3%. */
  yellowDrawdownPct: number;
  /** Drawdown above which we go RED. Default 6%. */
  redDrawdownPct: number;
  /** Open exposure ratio (notional / equity) above which we go YELLOW. */
  yellowExposureRatio: number;
  /** Open exposure ratio above which we go RED. */
  redExposureRatio: number;
  /** Net loss in last 1h that triggers YELLOW. */
  yellowLastHourLossUsd: number;
  /** Net loss in last 1h that triggers RED. */
  redLastHourLossUsd: number;
  /** Consecutive losses that trigger YELLOW. */
  yellowConsecutiveLosses: number;
  /** Consecutive losses that trigger RED. */
  redConsecutiveLosses: number;
}

export const DEFAULT_RISK_THRESHOLDS: RiskOfficerThresholds = {
  yellowDrawdownPct: 3,
  redDrawdownPct: 6,
  yellowExposureRatio: 0.6,
  redExposureRatio: 0.9,
  yellowLastHourLossUsd: 3,
  redLastHourLossUsd: 6,
  yellowConsecutiveLosses: 3,
  redConsecutiveLosses: 5,
};

export interface RiskVerdict {
  severity: RiskSeverity;
  drawdownPct: number;
  exposureRatio: number;
  reasons: string[];
  /** Suggested action — operator decides whether to follow. */
  suggestedAction: "continue" | "reduce-size" | "halt-new-entries" | "close-all";
}

/**
 * Pure assessment — given current state + thresholds, return a verdict.
 * The escalation rule is: take the WORST severity across all dimensions.
 */
export function assessRisk(
  input: RiskOfficerInput,
  thresholds: RiskOfficerThresholds = DEFAULT_RISK_THRESHOLDS,
): RiskVerdict {
  const reasons: string[] = [];
  let severityLevel = 0; // 0=green, 1=yellow, 2=red

  const drawdownPct = input.baselineEquityUsd > 0
    ? ((input.baselineEquityUsd - input.currentEquityUsd) / input.baselineEquityUsd) * 100
    : 0;
  const exposureRatio = input.currentEquityUsd > 0
    ? input.totalOpenNotionalUsd / input.currentEquityUsd
    : 0;

  const escalate = (level: 1 | 2) => { if (level > severityLevel) severityLevel = level; };

  if (drawdownPct >= thresholds.redDrawdownPct) {
    escalate(2);
    reasons.push(`drawdown ${drawdownPct.toFixed(2)}% >= red threshold ${thresholds.redDrawdownPct}%`);
  } else if (drawdownPct >= thresholds.yellowDrawdownPct) {
    escalate(1);
    reasons.push(`drawdown ${drawdownPct.toFixed(2)}% >= yellow threshold ${thresholds.yellowDrawdownPct}%`);
  }

  if (exposureRatio >= thresholds.redExposureRatio) {
    escalate(2);
    reasons.push(`exposure ratio ${exposureRatio.toFixed(2)} >= red threshold ${thresholds.redExposureRatio}`);
  } else if (exposureRatio >= thresholds.yellowExposureRatio) {
    escalate(1);
    reasons.push(`exposure ratio ${exposureRatio.toFixed(2)} >= yellow threshold ${thresholds.yellowExposureRatio}`);
  }

  const hourlyLossUsd = -Math.min(0, input.lastHourNetPnlUsd);
  if (hourlyLossUsd >= thresholds.redLastHourLossUsd) {
    escalate(2);
    reasons.push(`1h loss $${hourlyLossUsd.toFixed(2)} >= red threshold $${thresholds.redLastHourLossUsd}`);
  } else if (hourlyLossUsd >= thresholds.yellowLastHourLossUsd) {
    escalate(1);
    reasons.push(`1h loss $${hourlyLossUsd.toFixed(2)} >= yellow threshold $${thresholds.yellowLastHourLossUsd}`);
  }

  if (input.consecutiveLosses >= thresholds.redConsecutiveLosses) {
    escalate(2);
    reasons.push(`consecutive losses ${input.consecutiveLosses} >= red threshold ${thresholds.redConsecutiveLosses}`);
  } else if (input.consecutiveLosses >= thresholds.yellowConsecutiveLosses) {
    escalate(1);
    reasons.push(`consecutive losses ${input.consecutiveLosses} >= yellow threshold ${thresholds.yellowConsecutiveLosses}`);
  }

  const severity: RiskSeverity = severityLevel === 2 ? "red" : severityLevel === 1 ? "yellow" : "green";
  let suggestedAction: RiskVerdict["suggestedAction"] = "continue";
  if (severity === "red") {
    const drawdownTrigger = drawdownPct >= thresholds.redDrawdownPct;
    const hourlyTrigger = hourlyLossUsd >= thresholds.redLastHourLossUsd;
    suggestedAction = drawdownTrigger || hourlyTrigger ? "close-all" : "halt-new-entries";
  } else if (severity === "yellow") {
    suggestedAction = "reduce-size";
  }

  if (reasons.length === 0) reasons.push("all risk indicators within green bounds");

  return { severity, drawdownPct, exposureRatio, reasons, suggestedAction };
}
