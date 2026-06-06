/**
 * Execution Auditor — deterministic post-trade analysis. Compares the bot's
 * internal ledger (what we THOUGHT we made) against the real Bybit execution
 * record (what we ACTUALLY made), per fill. Surfaces:
 *   - Per-fill fee delta (maker vs taker actually charged)
 *   - Slippage attribution (mark→fill price drift)
 *   - Maker/taker ratio achieved on entry+exit
 *
 * Output is advisory: flagged in artifact + log; operator can adjust threshold
 * or strategy parameters based on the report.
 */

export interface ExecutionFill {
  /** Bybit's symbol identifier. */
  symbol: string;
  /** "Buy" or "Sell". */
  side: "Buy" | "Sell";
  /** Was this fill a maker post-only execution? */
  isMaker: boolean;
  /** Fee USDT (positive = paid, negative = rebate). */
  execFeeUsd: number;
  /** Notional value USDT of this fill. */
  execValueUsd: number;
  /** Executed price. */
  execPrice: number;
  /** Execution timestamp (unix ms). */
  execTimeMs: number;
  /** Order id (for correlation). */
  orderId?: string;
}

export interface LedgerCloseEntry {
  /** Strategy that opened the trade (e.g., "calendar-spread"). */
  strategyType?: string;
  /** ISO timestamp the position closed. */
  closedAt: string;
  /** Bot's accounted realised PnL (after estimated fees). */
  realizedPnlUsd: number;
  /** Bot's estimated fee cost. */
  feeUsd?: number;
  /** Bot's gross PnL (before its own fee model). */
  grossPnlUsd?: number;
}

export interface ExecutionAuditReport {
  windowStartMs: number;
  windowEndMs: number;
  fillCount: number;
  ledgerTradeCount: number;
  /** Cents of fee actually paid (sum of execFeeUsd, after rebate netting). */
  realFeesUsd: number;
  /** Bot's estimated fees summed across closed trades in window. */
  estimatedFeesUsd: number;
  /** Sum of realizedPnl across closed trades in window (bot's accounting). */
  ledgerNetPnlUsd: number;
  /** Maker / taker fills breakdown. */
  makerFillCount: number;
  takerFillCount: number;
  /** Per-trade gap = (real_pnl_delta) − (ledger_pnl). When NaN, no wallet delta
   *  was provided. */
  perTradeGapUsd: number | null;
  /** Diagnostic flags worth showing to the operator. */
  flags: string[];
}

export interface ExecutionAuditInput {
  fills: ReadonlyArray<ExecutionFill>;
  ledgerEntries: ReadonlyArray<LedgerCloseEntry>;
  /** Optional: wallet equity at window start. */
  walletStartUsd?: number;
  /** Optional: wallet equity at window end. */
  walletEndUsd?: number;
  windowStartMs: number;
  windowEndMs: number;
}

/**
 * Produce an audit report from raw fills + ledger entries within the window.
 * Pure function — no I/O.
 */
export function auditExecution(input: ExecutionAuditInput): ExecutionAuditReport {
  const fills = input.fills.filter((f) => f.execTimeMs >= input.windowStartMs && f.execTimeMs <= input.windowEndMs);
  const ledger = input.ledgerEntries.filter((e) => {
    const ts = Date.parse(e.closedAt);
    return Number.isFinite(ts) && ts >= input.windowStartMs && ts <= input.windowEndMs;
  });

  const realFeesUsd = fills.reduce((s, f) => s + f.execFeeUsd, 0);
  const makerFillCount = fills.filter((f) => f.isMaker).length;
  const takerFillCount = fills.length - makerFillCount;
  const estimatedFeesUsd = ledger.reduce((s, e) => s + (e.feeUsd ?? 0), 0);
  const ledgerNetPnlUsd = ledger.reduce((s, e) => s + e.realizedPnlUsd, 0);

  let perTradeGapUsd: number | null = null;
  if (input.walletStartUsd !== undefined && input.walletEndUsd !== undefined && ledger.length > 0) {
    const realDelta = input.walletEndUsd - input.walletStartUsd;
    const totalGap = realDelta - ledgerNetPnlUsd;
    perTradeGapUsd = totalGap / ledger.length;
  }

  const flags: string[] = [];
  const takerRatio = fills.length > 0 ? takerFillCount / fills.length : 0;
  if (takerRatio > 0.5) {
    flags.push(`high-taker-ratio: ${(takerRatio * 100).toFixed(0)}% of fills were taker (target <50% for maker-pref strategies)`);
  }
  const feeRatioOfEstimate = estimatedFeesUsd > 0 ? realFeesUsd / estimatedFeesUsd : 0;
  if (feeRatioOfEstimate > 1.3) {
    flags.push(`real-fees-${feeRatioOfEstimate.toFixed(2)}x-of-estimate: bot's feeRoundTripBps is too optimistic`);
  }
  if (perTradeGapUsd !== null && Math.abs(perTradeGapUsd) > 0.5) {
    const direction = perTradeGapUsd < 0 ? "loss" : "gain";
    flags.push(`per-trade ${direction} vs ledger: $${perTradeGapUsd.toFixed(2)} — likely slippage between mark and fill`);
  }
  if (fills.length === 0) flags.push("no fills observed in window");
  if (ledger.length === 0) flags.push("no closed trades observed in window");

  return {
    windowStartMs: input.windowStartMs,
    windowEndMs: input.windowEndMs,
    fillCount: fills.length,
    ledgerTradeCount: ledger.length,
    realFeesUsd,
    estimatedFeesUsd,
    ledgerNetPnlUsd,
    makerFillCount,
    takerFillCount,
    perTradeGapUsd,
    flags,
  };
}
