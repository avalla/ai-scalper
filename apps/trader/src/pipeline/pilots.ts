/**
 * Phase 3 pilots — funding-arb + basis-arb evaluators and execution adapters.
 *
 * These reproduce the decision + execution logic of the legacy
 * funding-arb / basis-arb open-processors, split across the two pipeline
 * stages. The legacy open-processors remain until all strategies are migrated.
 */

import {
  JOB_NAMES,
  STRATEGY_JOB_POLICY,
  type BasisArbManageJobData,
  type BollingerAdxManageJobData,
  type FundingArbManageJobData,
  type LongerTfManageJobData,
  type TradingIntent,
} from "@ai-scalper/queueing";
import { fundingArbDecide } from "../strategies/funding-arb";
import { basisArbDecide, computeBasisBps } from "../strategies/basis-arb";
import { longerTfSignal, type LongerTfKlineCache } from "../strategies/longer-tf";
import { bollingerAdxDecide, type BollingerAdxKlineCache } from "../strategies/bollinger-adx";
import { computeQtyFromNotional, makePositionId } from "../strategies/shared/trade-job-helpers";
import type {
  ExecutionAdapter,
  ExecutionResult,
  StrategyEvaluator,
} from "./types";
import {
  calendarSpreadAdapter,
  calendarSpreadEvaluator,
  pairsTradingAdapter,
  pairsTradingEvaluator,
} from "./pilots-spread";
import { placeOrderWithMakerPreference, type OrderCategory, type OrderSide } from "./maker-execution";

// ── funding-arb ───────────────────────────────────────────────────────────

export const fundingArbEvaluator: StrategyEvaluator = async (ctx) => {
  const { config, client, tickerSource, now, log } = ctx;
  const observedAt = new Date(now).toISOString();
  const symbol = config.symbol;

  let lastPrice = 0;
  let fundingRateBps = 0;
  let nextFundingTime = 0;
  try {
    const t = await tickerSource.getTicker(symbol, { category: "linear" });
    lastPrice = Number(t.lastPrice);
    const fr = Number(t.fundingRate);
    fundingRateBps = Number.isFinite(fr) ? fr * 10_000 : 0;
    nextFundingTime = Number(t.nextFundingTime);
  } catch (err) {
    log({ ts: observedAt, event: "funding-arb-evaluate-skip", reason: "ticker-unavailable", err: err instanceof Error ? err.message : String(err) });
    return [];
  }
  if (!Number.isFinite(lastPrice) || lastPrice <= 0 || !Number.isFinite(nextFundingTime) || nextFundingTime <= 0) {
    return [];
  }

  const decision = fundingArbDecide({
    fundingRateBps,
    nextFundingTime,
    now,
    symbol,
    hasOpenPosition: false,
    config: {
      minAbsRateBps: config.fundingArbMinAbsRateBps,
      entryWindowMinutesBefore: config.fundingArbEntryWindowMinutesBefore,
      exitDelayMinutesAfter: config.fundingArbExitDelayMinutesAfter,
    },
  });
  if (decision.kind !== "enter") return [];

  let instrument;
  try {
    instrument = await client.getInstrumentInfo({ category: "linear", symbol });
  } catch {
    return [];
  }
  const leverage = Math.max(1, Math.min(config.fundingArbMaxLeverage, config.leverage));
  const notionalUsd = Math.min(config.fundingArbMaxNotionalUsd, config.orderUsd);
  const qtyOut = computeQtyFromNotional({
    notionalUsd, leverage, price: lastPrice,
    qtyStep: instrument.lotSizeFilter.qtyStep,
    minOrderQty: instrument.lotSizeFilter.minOrderQty,
  });
  if (!qtyOut) return [];

  const intent: TradingIntent = {
    strategy: "funding-arb",
    symbol,
    legs: [{ symbol, side: decision.side, category: "linear", qty: qtyOut.qty, qtyStr: qtyOut.qtyStr, refPrice: lastPrice }],
    notionalUsd, leverage,
    reason: decision.reason,
    evaluatedAt: observedAt,
    managePayload: {
      qtyStep: instrument.lotSizeFilter.qtyStep,
      minOrderQty: instrument.lotSizeFilter.minOrderQty,
      fundingRateAtEntryBps: fundingRateBps,
      fundingTimeTarget: decision.fundingTimeTarget,
    },
  };
  return [intent];
};

export const fundingArbAdapter: ExecutionAdapter = async (intent, ctx): Promise<ExecutionResult> => {
  const { config, client, alerter, manageQueue, now, log } = ctx;
  const observedAt = new Date(now).toISOString();
  const leg = intent.legs[0]!;
  const p = intent.managePayload as {
    qtyStep: string; minOrderQty: string; fundingRateAtEntryBps: number; fundingTimeTarget: number;
  };

  if (!config.paperTrading) {
    try {
      await client.setLeverage({ category: "linear", symbol: leg.symbol, buyLeverage: String(intent.leverage), sellLeverage: String(intent.leverage) });
    } catch (err) {
      log({ ts: observedAt, event: "funding-arb-set-leverage-failed", err: err instanceof Error ? err.message : String(err) });
    }
    try {
      await client.createOrder({ category: "linear", symbol: leg.symbol, side: leg.side === "long" ? "Buy" : "Sell", qty: leg.qtyStr, orderType: "Market" });
    } catch (err) {
      log({ ts: observedAt, event: "funding-arb-open-order-failed", err: err instanceof Error ? err.message : String(err) });
      await alerter.send(`funding-arb open order failed: ${leg.symbol}`).catch(() => {});
      return { status: "skipped", reason: "open-order-failed" };
    }
  }

  const positionId = makePositionId({ strategy: "funding-arb", now, discriminator: leg.symbol });
  const manageData: FundingArbManageJobData = {
    positionId, symbol: leg.symbol, side: leg.side,
    entryPrice: leg.refPrice, qty: leg.qty,
    qtyStep: p.qtyStep, minOrderQty: p.minOrderQty,
    notionalUsd: intent.notionalUsd, leverage: intent.leverage,
    openedAt: observedAt,
    fundingRateAtEntryBps: p.fundingRateAtEntryBps,
    fundingTimeTarget: p.fundingTimeTarget,
    decisionsHistory: [{ at: observedAt, action: "enter", reasoning: intent.reason }],
    lastReviewAt: observedAt,
  };
  await manageQueue.add(
    JOB_NAMES.fundingArbManageTick, manageData as unknown as Record<string, unknown>,
    { ...STRATEGY_JOB_POLICY, jobId: positionId, repeat: { every: Math.max(5_000, config.pollMs) } },
  );
  log({ ts: observedAt, event: "funding-arb-opened", positionId, symbol: leg.symbol, side: leg.side, qty: leg.qty, entryPrice: leg.refPrice });
  return { status: "opened", positionId, symbol: leg.symbol };
};

// ── basis-arb (two-leg: perp + spot) ───────────────────────────────────────

export const basisArbEvaluator: StrategyEvaluator = async (ctx) => {
  const { config, client, tickerSource, now, log } = ctx;
  const observedAt = new Date(now).toISOString();
  const symbol = config.symbol;

  let perpPrice = 0; let spotPrice = 0; let fundingRateBps = 0;
  try {
    const [perpT, spotT] = await Promise.all([
      tickerSource.getTicker(symbol, { category: "linear" }),
      tickerSource.getTicker(symbol, { category: "spot" }),
    ]);
    perpPrice = Number(perpT.lastPrice);
    spotPrice = Number(spotT.lastPrice);
    const fr = Number(perpT.fundingRate);
    fundingRateBps = Number.isFinite(fr) ? fr * 10_000 : 0;
  } catch (err) {
    log({ ts: observedAt, event: "basis-arb-evaluate-skip", reason: "ticker-unavailable", err: err instanceof Error ? err.message : String(err) });
    return [];
  }
  if (!Number.isFinite(perpPrice) || perpPrice <= 0 || !Number.isFinite(spotPrice) || spotPrice <= 0) return [];

  // The data-integrity guard (implausible basis = bad tick) lives in the shared
  // basisArbDecide so the legacy open-processor is protected too.
  const decision = basisArbDecide({
    spotPrice, perpPrice, now, position: null,
    config: {
      entryThresholdBps: config.basisArbEntryThresholdBps,
      exitThresholdBps: config.basisArbExitThresholdBps,
      maxHoldMinutes: config.basisArbMaxHoldMinutes,
    },
  });
  if (decision.kind !== "enter") {
    log({ ts: observedAt, event: "basis-arb-evaluate-skip", reason: decision.reason, perpPrice, spotPrice });
    return [];
  }

  let perpInstr; let spotInstr;
  try {
    [perpInstr, spotInstr] = await Promise.all([
      client.getInstrumentInfo({ category: "linear", symbol }),
      client.getInstrumentInfo({ category: "spot", symbol }),
    ]);
  } catch {
    return [];
  }
  void spotInstr;
  const notionalUsd = config.basisArbMaxNotionalUsd;
  const leverage = config.basisArbLeverage;
  const qtyOut = computeQtyFromNotional({
    notionalUsd, leverage, price: perpPrice,
    qtyStep: perpInstr.lotSizeFilter.qtyStep,
    minOrderQty: perpInstr.lotSizeFilter.minOrderQty,
  });
  if (!qtyOut) return [];

  const intent: TradingIntent = {
    strategy: "basis-arb",
    symbol,
    legs: [
      { symbol, side: decision.perpSide, category: "linear", qty: qtyOut.qty, qtyStr: qtyOut.qtyStr, refPrice: perpPrice },
      { symbol, side: decision.spotSide, category: "spot", qty: qtyOut.qty, qtyStr: qtyOut.qtyStr, refPrice: spotPrice },
    ],
    notionalUsd, leverage,
    reason: decision.reason,
    evaluatedAt: observedAt,
    managePayload: {
      qtyStep: perpInstr.lotSizeFilter.qtyStep,
      minOrderQty: perpInstr.lotSizeFilter.minOrderQty,
      entryBasisBps: computeBasisBps(spotPrice, perpPrice),
      fundingRateAtEntryBps: fundingRateBps,
    },
  };
  return [intent];
};

export const basisArbAdapter: ExecutionAdapter = async (intent, ctx): Promise<ExecutionResult> => {
  const { config, client, tickerSource, alerter, manageQueue, now, log } = ctx;
  const observedAt = new Date(now).toISOString();
  const perpLeg = intent.legs.find((l) => l.category === "linear")!;
  const spotLeg = intent.legs.find((l) => l.category === "spot")!;
  const p = intent.managePayload as {
    qtyStep: string; minOrderQty: string; entryBasisBps: number; fundingRateAtEntryBps: number;
  };

  // Entry placement: maker-with-timeout if configured, else Market.
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
    // Leverage upsert on the perp leg (spot has no leverage).
    if (intent.leverage > 1) {
      try { await client.setLeverage({ category: "linear", symbol: perpLeg.symbol, buyLeverage: String(intent.leverage), sellLeverage: String(intent.leverage) }); }
      catch (err) { log({ ts: observedAt, event: "basis-arb-set-leverage-failed", err: err instanceof Error ? err.message : String(err) }); }
    }
    // Leg 1: perp
    try {
      await placeEntry(perpLeg.symbol, perpLeg.side === "long" ? "Buy" : "Sell", perpLeg.qtyStr, "linear");
    } catch (err) {
      log({ ts: observedAt, event: "basis-arb-perp-open-failed", err: err instanceof Error ? err.message : String(err) });
      await alerter.send(`basis-arb perp open failed: ${perpLeg.symbol}`).catch(() => {});
      return { status: "skipped", reason: "perp-open-failed" };
    }
    // Leg 2: spot — compensate perp on failure.
    try {
      await placeEntry(spotLeg.symbol, spotLeg.side === "long" ? "Buy" : "Sell", spotLeg.qtyStr, "spot");
    } catch (err) {
      log({ ts: observedAt, event: "basis-arb-spot-open-failed-compensating", err: err instanceof Error ? err.message : String(err) });
      let compErr: unknown = null;
      const maxCompAttempts = 3;
      for (let attempt = 0; attempt < maxCompAttempts; attempt += 1) {
        try {
          await client.createOrder({ category: "linear", symbol: perpLeg.symbol, side: perpLeg.side === "long" ? "Sell" : "Buy", qty: perpLeg.qtyStr, orderType: "Market", reduceOnly: true });
          compErr = null;
          break;
        } catch (e) {
          compErr = e;
          log({ ts: observedAt, event: "basis-arb-compensation-attempt-failed", attempt: attempt + 1, error: e instanceof Error ? e.message : String(e) });
          if (attempt < maxCompAttempts - 1) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        }
      }
      if (compErr) {
        log({ ts: observedAt, event: "basis-arb-compensation-exhausted", attempts: maxCompAttempts, error: compErr instanceof Error ? compErr.message : String(compErr) });
        await alerter.send(`[CRITICAL] basis-arb COMPENSATION EXHAUSTED after ${maxCompAttempts} attempts, manual close needed: ${perpLeg.symbol}`).catch(() => {});
      }
      await alerter.send(`basis-arb spot open failed (compensated): ${perpLeg.symbol}`).catch(() => {});
      return { status: "compensated", reason: "spot-open-failed" };
    }
  }

  const positionId = makePositionId({ strategy: "basis-arb", now, discriminator: perpLeg.symbol });
  const manageData: BasisArbManageJobData = {
    positionId, symbol: perpLeg.symbol,
    perpSide: perpLeg.side, spotSide: spotLeg.side,
    perpEntryPrice: perpLeg.refPrice, spotEntryPrice: spotLeg.refPrice,
    qty: perpLeg.qty, qtyStep: p.qtyStep, minOrderQty: p.minOrderQty,
    notionalUsd: intent.notionalUsd,
    openedAt: observedAt,
    entryBasisBps: p.entryBasisBps,
    fundingRateAtEntryBps: p.fundingRateAtEntryBps,
    decisionsHistory: [{ at: observedAt, action: "enter", reasoning: intent.reason }],
    lastReviewAt: observedAt,
  };
  await manageQueue.add(
    JOB_NAMES.basisArbManageTick, manageData as unknown as Record<string, unknown>,
    { ...STRATEGY_JOB_POLICY, jobId: positionId, repeat: { every: Math.max(5_000, config.pollMs) } },
  );
  log({ ts: observedAt, event: "basis-arb-opened", positionId, symbol: perpLeg.symbol, perpSide: perpLeg.side, spotSide: spotLeg.side, qty: perpLeg.qty });
  return { status: "opened", positionId, symbol: perpLeg.symbol };
};

// ── single-leg SL/TP helper (longer-tf, bollinger-adx) ─────────────────────

function slTpPrices(side: "long" | "short", price: number, slBps: number, tpBps: number) {
  return {
    stopLossPrice: side === "long" ? price * (1 - slBps / 10_000) : price * (1 + slBps / 10_000),
    takeProfitPrice: side === "long" ? price * (1 + tpBps / 10_000) : price * (1 - tpBps / 10_000),
  };
}

// ── longer-tf (single-leg, kline MA-crossover) ─────────────────────────────
//
// The legacy open-processor cached klines in the worker. Evaluate is stateless
// so we fetch klines fresh each tick (built with fetchedAt=now → never stale).

export const longerTfEvaluator: StrategyEvaluator = async (ctx) => {
  const { config, client, tickerSource, now, log } = ctx;
  const observedAt = new Date(now).toISOString();
  const symbol = config.symbol;

  let lastPrice = 0;
  try {
    const t = await tickerSource.getTicker(symbol, { category: "linear" });
    lastPrice = Number(t.lastPrice);
  } catch (err) {
    log({ ts: observedAt, event: "longer-tf-evaluate-skip", reason: "ticker-unavailable", err: err instanceof Error ? err.message : String(err) });
    return [];
  }
  if (!Number.isFinite(lastPrice) || lastPrice <= 0) return [];

  let cache: LongerTfKlineCache;
  try {
    const raw = await client.getKlines({ category: "linear", symbol, interval: config.longerTfKlineInterval, limit: Math.max(config.longerTfSlowWindow + 10, 50) });
    const list = ((raw as { list?: string[][] }).list ?? []).slice().reverse();
    const closes = list.map((row) => Number(row[4])).filter((n) => Number.isFinite(n) && n > 0);
    cache = { symbol, fetchedAt: now, closePrices: closes };
  } catch (err) {
    log({ ts: observedAt, event: "longer-tf-evaluate-skip", reason: "kline-refresh-failed", err: err instanceof Error ? err.message : String(err) });
    return [];
  }

  const signal = longerTfSignal({
    cache, now, refreshSec: config.longerTfKlineRefreshSec, symbol,
    fastWindow: config.longerTfFastWindow, slowWindow: config.longerTfSlowWindow, thresholdBps: config.longerTfThresholdBps,
  });
  if (signal === "warmup" || signal === "needs-refresh" || signal === "flat") return [];
  const side: "long" | "short" = signal === "long" ? "long" : "short";

  let instrument;
  try { instrument = await client.getInstrumentInfo({ category: "linear", symbol }); } catch { return []; }
  const leverage = Math.max(1, config.leverage);
  const notionalUsd = config.orderUsd;
  const qtyOut = computeQtyFromNotional({ notionalUsd, leverage, price: lastPrice, qtyStep: instrument.lotSizeFilter.qtyStep, minOrderQty: instrument.lotSizeFilter.minOrderQty });
  if (!qtyOut) return [];

  const { stopLossPrice, takeProfitPrice } = slTpPrices(side, lastPrice, config.longerTfStopLossBps, config.longerTfTakeProfitBps);
  const reason = `longer-tf:${side}:${config.longerTfKlineInterval}m`;
  const intent: TradingIntent = {
    strategy: "longer-tf", symbol,
    legs: [{ symbol, side, category: "linear", qty: qtyOut.qty, qtyStr: qtyOut.qtyStr, refPrice: lastPrice }],
    notionalUsd, leverage, reason, evaluatedAt: observedAt,
    managePayload: { qtyStep: instrument.lotSizeFilter.qtyStep, minOrderQty: instrument.lotSizeFilter.minOrderQty, stopLossPrice, takeProfitPrice, entryReasoning: reason },
  };
  return [intent];
};

export const longerTfAdapter: ExecutionAdapter = async (intent, ctx): Promise<ExecutionResult> => {
  const { config, client, alerter, manageQueue, now, log } = ctx;
  const observedAt = new Date(now).toISOString();
  const leg = intent.legs[0]!;
  const p = intent.managePayload as { qtyStep: string; minOrderQty: string; stopLossPrice: number; takeProfitPrice: number; entryReasoning: string };

  if (!config.paperTrading) {
    try { await client.setLeverage({ category: "linear", symbol: leg.symbol, buyLeverage: String(intent.leverage), sellLeverage: String(intent.leverage) }); } catch { /* tolerate */ }
    try {
      await client.createOrder({ category: "linear", symbol: leg.symbol, side: leg.side === "long" ? "Buy" : "Sell", qty: leg.qtyStr, orderType: "Market" });
    } catch (err) {
      log({ ts: observedAt, event: "longer-tf-open-order-failed", err: err instanceof Error ? err.message : String(err) });
      await alerter.send(`longer-tf open order failed: ${leg.symbol}`).catch(() => {});
      return { status: "skipped", reason: "open-order-failed" };
    }
  }

  const positionId = makePositionId({ strategy: "longer-tf", now, discriminator: leg.symbol });
  const manageData: LongerTfManageJobData = {
    positionId, symbol: leg.symbol, side: leg.side,
    entryPrice: leg.refPrice, qty: leg.qty,
    qtyStep: p.qtyStep, minOrderQty: p.minOrderQty,
    notionalUsd: intent.notionalUsd, leverage: intent.leverage,
    openedAt: observedAt, stopLossPrice: p.stopLossPrice, takeProfitPrice: p.takeProfitPrice,
    entryReasoning: p.entryReasoning,
    decisionsHistory: [{ at: observedAt, action: "enter", reasoning: intent.reason }],
    lastReviewAt: observedAt,
  };
  await manageQueue.add(
    JOB_NAMES.longerTfManageTick, manageData as unknown as Record<string, unknown>,
    { ...STRATEGY_JOB_POLICY, jobId: positionId, repeat: { every: Math.max(5_000, config.pollMs) } },
  );
  log({ ts: observedAt, event: "longer-tf-opened", positionId, symbol: leg.symbol, side: leg.side, qty: leg.qty });
  return { status: "opened", positionId, symbol: leg.symbol };
};

// ── bollinger-adx (single-leg, regime-filtered) ────────────────────────────

export const bollingerAdxEvaluator: StrategyEvaluator = async (ctx) => {
  const { config, client, tickerSource, now, log } = ctx;
  const observedAt = new Date(now).toISOString();
  const symbol = config.symbol;

  let lastPrice = 0;
  try {
    const t = await tickerSource.getTicker(symbol, { category: "linear" });
    lastPrice = Number(t.lastPrice);
  } catch (err) {
    log({ ts: observedAt, event: "bollinger-adx-evaluate-skip", reason: "ticker-unavailable", err: err instanceof Error ? err.message : String(err) });
    return [];
  }
  if (!Number.isFinite(lastPrice) || lastPrice <= 0) return [];

  let cache: BollingerAdxKlineCache;
  try {
    const raw = await client.getKlines({ category: "linear", symbol, interval: config.bollingerAdxKlineInterval, limit: Math.max(config.bollingerAdxBbPeriod, config.bollingerAdxAdxPeriod) * 3 + 10 });
    const list = ((raw as { list?: string[][] }).list ?? []).slice().reverse();
    const highs: number[] = []; const lows: number[] = []; const closes: number[] = [];
    for (const r of list) {
      const h = Number(r[2]); const l = Number(r[3]); const c = Number(r[4]);
      if (Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(c)) { highs.push(h); lows.push(l); closes.push(c); }
    }
    cache = { symbol, fetchedAt: now, highs, lows, closes };
  } catch (err) {
    log({ ts: observedAt, event: "bollinger-adx-evaluate-skip", reason: "kline-refresh-failed", err: err instanceof Error ? err.message : String(err) });
    return [];
  }

  const decision = bollingerAdxDecide({
    klineCache: cache, position: null, symbol, currentPrice: lastPrice, now,
    refreshSec: config.bollingerAdxKlineRefreshSec,
    bbPeriod: config.bollingerAdxBbPeriod, bbStdDev: config.bollingerAdxBbStdDev,
    adxPeriod: config.bollingerAdxAdxPeriod,
    adxRangingThreshold: config.bollingerAdxAdxRangingThreshold,
    adxTrendingThreshold: config.bollingerAdxAdxTrendingThreshold,
    stopLossBps: config.bollingerAdxStopLossBps, takeProfitBps: config.bollingerAdxTakeProfitBps,
  });
  if (decision.kind !== "enter") return [];

  let instrument;
  try { instrument = await client.getInstrumentInfo({ category: "linear", symbol }); } catch { return []; }
  const leverage = Math.max(1, config.leverage);
  const notionalUsd = config.orderUsd;
  const qtyOut = computeQtyFromNotional({ notionalUsd, leverage, price: lastPrice, qtyStep: instrument.lotSizeFilter.qtyStep, minOrderQty: instrument.lotSizeFilter.minOrderQty });
  if (!qtyOut) return [];

  const { stopLossPrice, takeProfitPrice } = slTpPrices(decision.side, lastPrice, config.bollingerAdxStopLossBps, config.bollingerAdxTakeProfitBps);
  const intent: TradingIntent = {
    strategy: "bollinger-adx", symbol,
    legs: [{ symbol, side: decision.side, category: "linear", qty: qtyOut.qty, qtyStr: qtyOut.qtyStr, refPrice: lastPrice }],
    notionalUsd, leverage, reason: decision.reason, evaluatedAt: observedAt,
    managePayload: { qtyStep: instrument.lotSizeFilter.qtyStep, minOrderQty: instrument.lotSizeFilter.minOrderQty, stopLossPrice, takeProfitPrice, entryRegime: decision.regime },
  };
  return [intent];
};

export const bollingerAdxAdapter: ExecutionAdapter = async (intent, ctx): Promise<ExecutionResult> => {
  const { config, client, alerter, manageQueue, now, log } = ctx;
  const observedAt = new Date(now).toISOString();
  const leg = intent.legs[0]!;
  const p = intent.managePayload as { qtyStep: string; minOrderQty: string; stopLossPrice: number; takeProfitPrice: number; entryRegime: "ranging" | "trending" | "unknown" };

  if (!config.paperTrading) {
    try { await client.setLeverage({ category: "linear", symbol: leg.symbol, buyLeverage: String(intent.leverage), sellLeverage: String(intent.leverage) }); } catch { /* tolerate */ }
    try {
      await client.createOrder({ category: "linear", symbol: leg.symbol, side: leg.side === "long" ? "Buy" : "Sell", qty: leg.qtyStr, orderType: "Market" });
    } catch (err) {
      log({ ts: observedAt, event: "bollinger-adx-open-order-failed", err: err instanceof Error ? err.message : String(err) });
      await alerter.send(`bollinger-adx open order failed: ${leg.symbol}`).catch(() => {});
      return { status: "skipped", reason: "open-order-failed" };
    }
  }

  const positionId = makePositionId({ strategy: "bollinger-adx", now, discriminator: leg.symbol });
  const manageData: BollingerAdxManageJobData = {
    positionId, symbol: leg.symbol, side: leg.side,
    entryPrice: leg.refPrice, qty: leg.qty,
    qtyStep: p.qtyStep, minOrderQty: p.minOrderQty,
    notionalUsd: intent.notionalUsd, leverage: intent.leverage,
    openedAt: observedAt, stopLossPrice: p.stopLossPrice, takeProfitPrice: p.takeProfitPrice,
    entryRegime: p.entryRegime, entryReasoning: intent.reason,
    decisionsHistory: [{ at: observedAt, action: "enter", reasoning: intent.reason }],
    lastReviewAt: observedAt,
  };
  await manageQueue.add(
    JOB_NAMES.bollingerAdxManageTick, manageData as unknown as Record<string, unknown>,
    { ...STRATEGY_JOB_POLICY, jobId: positionId, repeat: { every: Math.max(5_000, config.pollMs) } },
  );
  log({ ts: observedAt, event: "bollinger-adx-opened", positionId, symbol: leg.symbol, side: leg.side, qty: leg.qty, regime: p.entryRegime });
  return { status: "opened", positionId, symbol: leg.symbol };
};

// ── pilot registries ────────────────────────────────────────────────────

export const PILOT_EVALUATORS = {
  "funding-arb": fundingArbEvaluator,
  "basis-arb": basisArbEvaluator,
  "longer-tf": longerTfEvaluator,
  "bollinger-adx": bollingerAdxEvaluator,
  "calendar-spread": calendarSpreadEvaluator,
  "pairs-trading": pairsTradingEvaluator,
} as const;

export const PILOT_ADAPTERS = {
  "funding-arb": fundingArbAdapter,
  "basis-arb": basisArbAdapter,
  "longer-tf": longerTfAdapter,
  "bollinger-adx": bollingerAdxAdapter,
  "calendar-spread": calendarSpreadAdapter,
  "pairs-trading": pairsTradingAdapter,
} as const;
