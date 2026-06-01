/**
 * Phase 3 pilots — calendar-spread + pairs-trading (two-leg) evaluators and
 * execution adapters. Split from pilots.ts to keep both files focused.
 *
 * Both reproduce the decision + execution logic of their legacy
 * open-processors, split across evaluate (stateless) and agent (execute).
 * Two-leg legs are positional: legs[0] = first leg, legs[1] = hedge leg.
 */

import {
  JOB_NAMES,
  STRATEGY_JOB_POLICY,
  type CalendarSpreadManageJobData,
  type PairsTradingManageJobData,
  type TradingIntent,
} from "@ai-scalper/queueing";
import { calendarDecide, computeCalendarSpreadBps } from "../strategies/calendar-spread";
import { pairsDecide, type PairsCache } from "../strategies/pairs-trading";
import { computeQtyFromNotional, makePositionId } from "../strategies/shared/trade-job-helpers";
import type { ExecutionAdapter, ExecutionResult, StrategyEvaluator } from "./types";
import { placeOrderWithMakerPreference, type OrderCategory, type OrderSide } from "./maker-execution";

// ── calendar-spread (two-leg: perp + dated, both linear) ───────────────────

export const calendarSpreadEvaluator: StrategyEvaluator = async (ctx) => {
  const { config, client, tickerSource, now, log } = ctx;
  const observedAt = new Date(now).toISOString();

  if (!config.calendarDatedSymbol || config.calendarDatedDeliveryAt <= 0) return [];

  let perpPrice = 0; let datedPrice = 0;
  try {
    const [perpT, datedT] = await Promise.all([
      tickerSource.getTicker(config.calendarPerpSymbol, { category: "linear" }),
      tickerSource.getTicker(config.calendarDatedSymbol, { category: "linear" }),
    ]);
    perpPrice = Number(perpT.lastPrice);
    datedPrice = Number(datedT.lastPrice);
  } catch (err) {
    log({ ts: observedAt, event: "calendar-spread-evaluate-skip", reason: "ticker-unavailable", err: err instanceof Error ? err.message : String(err) });
    return [];
  }
  if (!Number.isFinite(perpPrice) || perpPrice <= 0 || !Number.isFinite(datedPrice) || datedPrice <= 0) return [];

  const decision = calendarDecide({
    perpPrice, datedPrice, datedDeliveryAt: config.calendarDatedDeliveryAt, now, position: null,
    config: {
      entryThresholdBps: config.calendarEntryThresholdBps,
      exitThresholdBps: config.calendarExitThresholdBps,
      preSettlementCloseHours: config.calendarPreSettlementCloseHours,
    },
  });
  if (decision.kind !== "enter") return [];

  let perpInstr;
  try { [perpInstr] = await Promise.all([
    client.getInstrumentInfo({ category: "linear", symbol: config.calendarPerpSymbol }),
    client.getInstrumentInfo({ category: "linear", symbol: config.calendarDatedSymbol }),
  ]); } catch { return []; }

  const notionalPerLegUsd = config.calendarMaxNotionalUsdPerLeg;
  const leverage = config.calendarLeverage;
  const q = computeQtyFromNotional({ notionalUsd: notionalPerLegUsd, leverage, price: perpPrice, qtyStep: perpInstr.lotSizeFilter.qtyStep, minOrderQty: perpInstr.lotSizeFilter.minOrderQty });
  if (!q) return [];

  const intent: TradingIntent = {
    strategy: "calendar-spread",
    symbol: config.calendarPerpSymbol,
    legs: [
      { symbol: config.calendarPerpSymbol, side: decision.perpSide, category: "linear", qty: q.qty, qtyStr: q.qtyStr, refPrice: perpPrice },
      { symbol: config.calendarDatedSymbol, side: decision.datedSide, category: "linear", qty: q.qty, qtyStr: q.qtyStr, refPrice: datedPrice },
    ],
    notionalUsd: notionalPerLegUsd, leverage,
    reason: decision.reason, evaluatedAt: observedAt,
    managePayload: {
      qtyStep: perpInstr.lotSizeFilter.qtyStep, minOrderQty: perpInstr.lotSizeFilter.minOrderQty,
      entrySpreadBps: computeCalendarSpreadBps(perpPrice, datedPrice),
      datedDeliveryAt: config.calendarDatedDeliveryAt,
    },
  };
  return [intent];
};

export const calendarSpreadAdapter: ExecutionAdapter = async (intent, ctx): Promise<ExecutionResult> => {
  const { config, client, tickerSource, alerter, manageQueue, now, log } = ctx;
  const observedAt = new Date(now).toISOString();
  const perpLeg = intent.legs[0]!;
  const datedLeg = intent.legs[1]!;
  const p = intent.managePayload as { qtyStep: string; minOrderQty: string; entrySpreadBps: number; datedDeliveryAt: number };

  // Entry placement: maker-with-timeout if configured, else direct Market.
  // Reduce-only compensation stays Market (latency-critical close).
  const placeEntry = async (symbol: string, side: OrderSide, qty: string, category: OrderCategory) => {
    if (config.pipelineExecutionMode === "maker-with-timeout") {
      const r = await placeOrderWithMakerPreference(
        { category, symbol, side, qty },
        { client, tickerSource, log },
        { timeoutMs: 30_000, pollIntervalMs: 2_000, fallbackToTaker: true },
      );
      if (r.status === "skipped-failed") throw new Error(r.reason);
      return;
    }
    await client.createOrder({ category, symbol, side, qty, orderType: "Market" });
  };

  if (!config.paperTrading) {
    // Leverage upsert on both linear legs (no-op on Bybit if already set).
    if (intent.leverage > 1) {
      for (const leg of [perpLeg, datedLeg]) {
        try { await client.setLeverage({ category: "linear", symbol: leg.symbol, buyLeverage: String(intent.leverage), sellLeverage: String(intent.leverage) }); }
        catch (err) { log({ ts: observedAt, event: "calendar-spread-set-leverage-failed", symbol: leg.symbol, err: err instanceof Error ? err.message : String(err) }); }
      }
    }
    try {
      await placeEntry(perpLeg.symbol, perpLeg.side === "long" ? "Buy" : "Sell", perpLeg.qtyStr, "linear");
    } catch (err) {
      log({ ts: observedAt, event: "calendar-spread-perp-open-failed", err: err instanceof Error ? err.message : String(err) });
      await alerter.send(`calendar-spread perp open failed`).catch(() => {});
      return { status: "skipped", reason: "perp-open-failed" };
    }
    try {
      await placeEntry(datedLeg.symbol, datedLeg.side === "long" ? "Buy" : "Sell", datedLeg.qtyStr, "linear");
    } catch (err) {
      log({ ts: observedAt, event: "calendar-spread-dated-open-failed-compensating", err: err instanceof Error ? err.message : String(err) });
      try {
        await client.createOrder({ category: "linear", symbol: perpLeg.symbol, side: perpLeg.side === "long" ? "Sell" : "Buy", qty: perpLeg.qtyStr, orderType: "Market", reduceOnly: true });
      } catch (compErr) {
        log({ ts: observedAt, event: "calendar-spread-compensation-failed", error: compErr instanceof Error ? compErr.message : String(compErr) });
        await alerter.send(`calendar-spread COMPENSATION FAILED`).catch(() => {});
      }
      await alerter.send(`calendar-spread dated open failed (compensated)`).catch(() => {});
      return { status: "compensated", reason: "dated-open-failed" };
    }
  }

  const positionId = makePositionId({ strategy: "calendar-spread", now, discriminator: `${perpLeg.symbol}-${datedLeg.symbol}` });
  const manageData: CalendarSpreadManageJobData = {
    positionId, perpSymbol: perpLeg.symbol, datedSymbol: datedLeg.symbol,
    perpSide: perpLeg.side, datedSide: datedLeg.side,
    perpEntryPrice: perpLeg.refPrice, datedEntryPrice: datedLeg.refPrice,
    qty: perpLeg.qty, qtyStep: p.qtyStep, minOrderQty: p.minOrderQty,
    notionalPerLegUsd: intent.notionalUsd,
    openedAt: observedAt, entrySpreadBps: p.entrySpreadBps, datedDeliveryAt: p.datedDeliveryAt,
    decisionsHistory: [{ at: observedAt, action: "enter", reasoning: intent.reason }],
    lastReviewAt: observedAt,
  };
  await manageQueue.add(
    JOB_NAMES.calendarSpreadManageTick, manageData as unknown as Record<string, unknown>,
    { ...STRATEGY_JOB_POLICY, jobId: positionId, repeat: { every: Math.max(5_000, config.calendarPollSec * 1000) } },
  );
  log({ ts: observedAt, event: "calendar-spread-opened", positionId, perpSymbol: perpLeg.symbol, datedSymbol: datedLeg.symbol, perpSide: perpLeg.side, datedSide: datedLeg.side });
  return { status: "opened", positionId, symbol: perpLeg.symbol };
};

// ── pairs-trading (two-leg, different symbols, z-score mean reversion) ──────
//
// Like longer-tf, the legacy kline cache is dropped for statelessness: klines
// are fetched fresh each evaluate tick (cache built with fetchedAt=now).

export const pairsTradingEvaluator: StrategyEvaluator = async (ctx) => {
  const { config, client, tickerSource, now, log } = ctx;
  const observedAt = new Date(now).toISOString();
  const leg1Symbol = config.pairsLeg1Symbol;
  const leg2Symbol = config.pairsLeg2Symbol;

  let cache: PairsCache;
  try {
    const [r1, r2] = await Promise.all([
      client.getKlines({ category: "linear", symbol: leg1Symbol, interval: config.pairsKlineInterval, limit: config.pairsWindowSize + 10 }),
      client.getKlines({ category: "linear", symbol: leg2Symbol, interval: config.pairsKlineInterval, limit: config.pairsWindowSize + 10 }),
    ]);
    const l1 = ((r1 as { list?: string[][] }).list ?? []).slice().reverse().map((r) => Number(r[4])).filter((n) => Number.isFinite(n) && n > 0);
    const l2 = ((r2 as { list?: string[][] }).list ?? []).slice().reverse().map((r) => Number(r[4])).filter((n) => Number.isFinite(n) && n > 0);
    const n = Math.min(l1.length, l2.length);
    cache = { leg1Symbol, leg2Symbol, fetchedAt: now, leg1Closes: l1.slice(-n), leg2Closes: l2.slice(-n) };
  } catch (err) {
    log({ ts: observedAt, event: "pairs-trading-evaluate-skip", reason: "kline-refresh-failed", err: err instanceof Error ? err.message : String(err) });
    return [];
  }

  const decision = pairsDecide({
    cache, position: null, now, refreshSec: config.pairsKlineRefreshSec,
    windowSize: config.pairsWindowSize, entryZ: config.pairsEntryZ, exitZ: config.pairsExitZ,
    maxHoldMinutes: config.pairsMaxHoldMinutes, leg1Symbol, leg2Symbol,
  });
  if (decision.kind !== "enter") return [];

  let l1Price = 0; let l2Price = 0; let l1Instr; let l2Instr;
  try {
    const [t1, t2, i1, i2] = await Promise.all([
      tickerSource.getTicker(leg1Symbol, { category: "linear" }),
      tickerSource.getTicker(leg2Symbol, { category: "linear" }),
      client.getInstrumentInfo({ category: "linear", symbol: leg1Symbol }),
      client.getInstrumentInfo({ category: "linear", symbol: leg2Symbol }),
    ]);
    l1Price = Number(t1.lastPrice); l2Price = Number(t2.lastPrice); l1Instr = i1; l2Instr = i2;
  } catch (err) {
    log({ ts: observedAt, event: "pairs-trading-evaluate-skip", reason: "instrument-fetch-failed", err: err instanceof Error ? err.message : String(err) });
    return [];
  }
  if (!Number.isFinite(l1Price) || l1Price <= 0 || !Number.isFinite(l2Price) || l2Price <= 0) return [];

  const perLegNotional = config.pairsMaxNotionalUsdPerLeg;
  const q1 = computeQtyFromNotional({ notionalUsd: perLegNotional, leverage: 1, price: l1Price, qtyStep: l1Instr.lotSizeFilter.qtyStep, minOrderQty: l1Instr.lotSizeFilter.minOrderQty });
  const q2 = computeQtyFromNotional({ notionalUsd: perLegNotional, leverage: 1, price: l2Price, qtyStep: l2Instr.lotSizeFilter.qtyStep, minOrderQty: l2Instr.lotSizeFilter.minOrderQty });
  if (!q1 || !q2) return [];

  const intent: TradingIntent = {
    strategy: "pairs-trading",
    symbol: leg1Symbol,
    legs: [
      { symbol: leg1Symbol, side: decision.leg1Side, category: "linear", qty: q1.qty, qtyStr: q1.qtyStr, refPrice: l1Price },
      { symbol: leg2Symbol, side: decision.leg2Side, category: "linear", qty: q2.qty, qtyStr: q2.qtyStr, refPrice: l2Price },
    ],
    notionalUsd: perLegNotional, leverage: 1,
    reason: decision.reason, evaluatedAt: observedAt,
    managePayload: { hedgeRatio: decision.hedgeRatio, entryZ: decision.z },
  };
  return [intent];
};

export const pairsTradingAdapter: ExecutionAdapter = async (intent, ctx): Promise<ExecutionResult> => {
  const { config, client, alerter, manageQueue, now, log } = ctx;
  const observedAt = new Date(now).toISOString();
  const leg1 = intent.legs[0]!;
  const leg2 = intent.legs[1]!;
  const p = intent.managePayload as { hedgeRatio: number; entryZ: number };

  if (!config.paperTrading) {
    try {
      await client.createOrder({ category: "linear", symbol: leg1.symbol, side: leg1.side === "long" ? "Buy" : "Sell", qty: leg1.qtyStr, orderType: "Market" });
    } catch (err) {
      log({ ts: observedAt, event: "pairs-trading-leg1-open-failed", err: err instanceof Error ? err.message : String(err) });
      await alerter.send(`pairs-trading leg1 open failed: ${leg1.symbol}`).catch(() => {});
      return { status: "skipped", reason: "leg1-open-failed" };
    }
    try {
      await client.createOrder({ category: "linear", symbol: leg2.symbol, side: leg2.side === "long" ? "Buy" : "Sell", qty: leg2.qtyStr, orderType: "Market" });
    } catch (err) {
      log({ ts: observedAt, event: "pairs-trading-leg2-open-failed-compensating", err: err instanceof Error ? err.message : String(err) });
      try {
        await client.createOrder({ category: "linear", symbol: leg1.symbol, side: leg1.side === "long" ? "Sell" : "Buy", qty: leg1.qtyStr, orderType: "Market", reduceOnly: true });
      } catch (compErr) {
        log({ ts: observedAt, event: "pairs-trading-compensation-failed", error: compErr instanceof Error ? compErr.message : String(compErr) });
        await alerter.send(`pairs-trading COMPENSATION FAILED: ${leg1.symbol}`).catch(() => {});
      }
      await alerter.send(`pairs-trading leg2 open failed (compensated): ${leg2.symbol}`).catch(() => {});
      return { status: "compensated", reason: "leg2-open-failed" };
    }
  }

  const positionId = makePositionId({ strategy: "pairs-trading", now, discriminator: `${leg1.symbol}-${leg2.symbol}` });
  const manageData: PairsTradingManageJobData = {
    positionId,
    leg1Symbol: leg1.symbol, leg1Side: leg1.side, leg1EntryPrice: leg1.refPrice, leg1Qty: leg1.qty,
    leg2Symbol: leg2.symbol, leg2Side: leg2.side, leg2EntryPrice: leg2.refPrice, leg2Qty: leg2.qty,
    hedgeRatio: p.hedgeRatio, entryZ: p.entryZ,
    notionalPerLegUsd: intent.notionalUsd,
    openedAt: observedAt,
    decisionsHistory: [{ at: observedAt, action: "enter", reasoning: intent.reason }],
    lastReviewAt: observedAt,
  };
  await manageQueue.add(
    JOB_NAMES.pairsTradingManageTick, manageData as unknown as Record<string, unknown>,
    { ...STRATEGY_JOB_POLICY, jobId: positionId, repeat: { every: Math.max(5_000, config.pollMs) } },
  );
  log({ ts: observedAt, event: "pairs-trading-opened", positionId, leg1Symbol: leg1.symbol, leg2Symbol: leg2.symbol, leg1Side: leg1.side, leg2Side: leg2.side, z: p.entryZ, hedgeRatio: p.hedgeRatio });
  return { status: "opened", positionId, symbol: leg1.symbol };
};
