/**
 * liquidation-cascade OPEN-DECISION processor (Phase 2 BullMQ migration).
 *
 * Pure, fully-DI'd function. Mirrors the "no position" branch of
 * `apps/trader/src/trading/liquidation-cascade-tick.ts`:
 *
 *   1. Skip if a manage-job already exists (1-position invariant).
 *   2. Iterate `config.liquidationAllowedSymbols`:
 *      - reader.getRecent + evaluateLiquidationCascade
 *      - if `enter`: fetch ticker + instrument, evaluateRisk, place
 *        market order (paper-mode bypasses), and enqueue a manage job
 *        carrying SL/TP prices computed via buildPositionTargets.
 *   3. Returns `opened` on first successful enter; otherwise `skipped`.
 *
 * Risk profile: standard `evaluateRisk` (not aggressive-perps).
 */

import {
  JOB_NAMES,
  STRATEGY_JOB_POLICY,
  type LiquidationCascadeManageJobData,
  type LiquidationCascadeOpenTickJobData,
} from "@ai-scalper/queueing";
import {
  buildPositionTargets,
  evaluateRisk,
} from "@ai-scalper/trading-core";
import type { createBybitClient, InstrumentInfo, MarketTicker } from "@ai-scalper/bybit-client";
import type { TickerSource } from "@ai-scalper/bybit-client/ticker-source";
import type { TraderConfig } from "../config";
import type { WebhookAlerter } from "../alerts/webhook";
import { evaluateLiquidationCascade } from "./liquidation-cascade-evaluate";
import type { LiquidationsReader } from "./liquidations-cache-reader";
import type { StrategySharedState } from "./shared/bullmq-shared-state";
import {
  computeQtyFromNotional,
  makePositionId,
} from "./shared/trade-job-helpers";

type BybitClient = ReturnType<typeof createBybitClient>;

const DEFAULT_LIQUIDATION_SPREAD_BPS = 1;

export interface ManageQueueLike<TData> {
  add(name: string, data: TData, opts?: Record<string, unknown>): Promise<unknown>;
}

export interface LiquidationCascadeOpenProcessorDeps {
  config: TraderConfig;
  client: BybitClient;
  tickerSource: TickerSource;
  alerter: WebhookAlerter;
  liquidationsReader: LiquidationsReader;
  manageQueue: ManageQueueLike<LiquidationCascadeManageJobData>;
  sharedState: StrategySharedState;
  log?: (payload: Record<string, unknown>) => void;
  now?: () => number;
}

export type LiquidationCascadeOpenTickResult =
  | { status: "skipped"; reason: string }
  | {
      status: "opened";
      positionId: string;
      symbol: string;
      side: "long" | "short";
      qty: number;
      entryPrice: number;
      notionalUsd: number;
      leverage: number;
      stopLossPrice: number;
      takeProfitPrice: number;
    };

export async function processLiquidationCascadeOpenTick(
  _jobData: LiquidationCascadeOpenTickJobData,
  deps: LiquidationCascadeOpenProcessorDeps,
): Promise<LiquidationCascadeOpenTickResult> {
  const { config, client, tickerSource, alerter, liquidationsReader, manageQueue, sharedState } = deps;
  const log = deps.log ?? ((p) => console.log(JSON.stringify(p)));
  const now = (deps.now ?? Date.now)();
  const observedAt = new Date(now).toISOString();

  // (1) 1-position invariant
  if (await sharedState.hasActivePosition()) {
    log({ ts: observedAt, event: "liquidation-cascade-open-skip", reason: "active-position-exists" });
    return { status: "skipped", reason: "active-position-exists" };
  }

  // (2) iterate allowed symbols looking for a cluster
  for (const symbol of config.liquidationAllowedSymbols) {
    const since = now - config.liquidationWindowMs;
    let recent: Array<{ ts: number; side: "Buy" | "Sell"; sizeUsd: number }> = [];
    try {
      recent = await liquidationsReader.getRecent(symbol, since);
    } catch (err) {
      log({
        ts: observedAt,
        event: "liquidation-cascade-reader-failed",
        symbol,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (recent.length === 0) continue;

    const decision = await evaluateLiquidationCascade({
      cache: { getRecent: async () => recent },
      symbols: [symbol],
      windowMs: config.liquidationWindowMs,
      minClusterUsd: config.liquidationMinClusterUsd,
      minCount: config.liquidationMinCount,
      now,
    });

    if (decision.kind !== "enter") continue;

    // (3) fetch ticker
    let ticker: MarketTicker;
    try {
      ticker = await tickerSource.getTicker(symbol, { category: config.category });
    } catch (err) {
      log({
        ts: observedAt,
        event: "liquidation-cascade-ticker-unavailable",
        symbol,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const lastPrice = Number(ticker.lastPrice);
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) {
      log({ ts: observedAt, event: "liquidation-cascade-ticker-invalid", symbol });
      continue;
    }

    const bid = Number(ticker.bid1Price ?? 0);
    const ask = Number(ticker.ask1Price ?? 0);
    let spreadBps = DEFAULT_LIQUIDATION_SPREAD_BPS;
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
      const mid = (bid + ask) / 2;
      spreadBps = mid > 0 ? ((ask - bid) / mid) * 10_000 : DEFAULT_LIQUIDATION_SPREAD_BPS;
    }

    const notionalUsd = config.liquidationOrderUsd * config.liquidationLeverage;

    // (4) risk gate
    const riskDecision = evaluateRisk({
      action: decision.side,
      limits: {
        maxPositionUsd: Math.max(config.maxPositionUsd, notionalUsd),
        maxDailyLossUsd: config.maxDailyLossUsd,
        minTradeIntervalMs: config.minTradeIntervalMs,
        maxSpreadBps: config.maxSpreadBps,
      },
      market: { lastPrice, markPrice: lastPrice },
      now,
      orderUsd: notionalUsd,
      // Shared state has no realized-pnl / position view — use a flat
      // synthetic state. Manage workers handle per-position SL/TP exits.
      state: { lastTradeAt: null, realizedPnlUsd: 0, position: null, dayStartedAt: null },
    });

    if (!riskDecision.allowed) {
      log({
        ts: observedAt,
        event: "liquidation-cascade-risk-blocked",
        symbol,
        side: decision.side,
        reason: riskDecision.reason,
        spreadBps,
        clusterUsd: decision.clusterUsd,
      });
      continue;
    }

    // (5) instrument info + qty
    let instrument: InstrumentInfo;
    try {
      instrument = await client.getInstrumentInfo({ category: config.category, symbol });
    } catch (err) {
      log({
        ts: observedAt,
        event: "liquidation-cascade-instrument-unavailable",
        symbol,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const qtyOut = computeQtyFromNotional({
      notionalUsd: config.liquidationOrderUsd,
      leverage: config.liquidationLeverage,
      price: lastPrice,
      qtyStep: instrument.lotSizeFilter.qtyStep,
      minOrderQty: instrument.lotSizeFilter.minOrderQty,
    });
    if (!qtyOut) {
      log({
        ts: observedAt,
        event: "liquidation-cascade-qty-below-min",
        symbol,
        notionalUsd,
        leverage: config.liquidationLeverage,
        price: lastPrice,
        minOrderQty: instrument.lotSizeFilter.minOrderQty,
      });
      continue;
    }

    // (6) live order placement (paper bypasses)
    if (!config.paperTrading) {
      try {
        await client.setLeverage({
          category: config.category,
          symbol,
          buyLeverage: String(config.liquidationLeverage),
          sellLeverage: String(config.liquidationLeverage),
        });
      } catch (err) {
        log({
          ts: observedAt,
          event: "liquidation-cascade-set-leverage-failed",
          symbol,
          error: err instanceof Error ? err.message : String(err),
        });
        // non-fatal
      }
      try {
        await client.createOrder({
          category: config.category,
          symbol,
          side: decision.side === "long" ? "Buy" : "Sell",
          qty: qtyOut.qtyStr,
          orderType: "Market",
        });
      } catch (err) {
        log({
          ts: observedAt,
          event: "liquidation-cascade-open-order-failed",
          symbol,
          error: err instanceof Error ? err.message : String(err),
        });
        await alerter.send(`liquidation-cascade open order failed: ${symbol}`).catch(() => {});
        return { status: "skipped", reason: "open-order-failed" };
      }
    }

    const targets = buildPositionTargets({
      action: decision.side,
      price: lastPrice,
      stopLossBps: config.liquidationStopLossBps,
      takeProfitBps: config.liquidationTakeProfitBps,
    });

    // (7) enqueue manage job
    const positionId = makePositionId({ strategy: "liquidation-cascade", now, discriminator: symbol });
    const manageData: LiquidationCascadeManageJobData = {
      positionId,
      symbol,
      side: decision.side,
      qty: qtyOut.qty,
      qtyStep: instrument.lotSizeFilter.qtyStep,
      minOrderQty: instrument.lotSizeFilter.minOrderQty,
      entryPrice: lastPrice,
      notionalUsd,
      leverage: config.liquidationLeverage,
      openedAt: new Date(now).toISOString(),
      stopLossPrice: targets.stopLossPrice,
      takeProfitPrice: targets.takeProfitPrice,
      maxHoldSec: config.liquidationMaxHoldSec,
      decisionsHistory: [{
        at: new Date(now).toISOString(),
        action: "enter",
        reasoning: decision.reason,
      }],
      lastReviewAt: new Date(now).toISOString(),
    };

    await manageQueue.add(
      JOB_NAMES.liquidationCascadeManageTick,
      manageData,
      {
        ...STRATEGY_JOB_POLICY,
        jobId: positionId,
        repeat: { every: Math.max(config.liquidationCheckIntervalMs, config.pollMs) },
      },
    );

    log({
      ts: observedAt,
      event: "liquidation-cascade-opened",
      positionId,
      symbol,
      side: decision.side,
      qty: qtyOut.qty,
      entryPrice: lastPrice,
      notionalUsd,
      leverage: config.liquidationLeverage,
      stopLossPrice: targets.stopLossPrice,
      takeProfitPrice: targets.takeProfitPrice,
      clusterUsd: decision.clusterUsd,
    });

    return {
      status: "opened",
      positionId,
      symbol,
      side: decision.side,
      qty: qtyOut.qty,
      entryPrice: lastPrice,
      notionalUsd,
      leverage: config.liquidationLeverage,
      stopLossPrice: targets.stopLossPrice,
      takeProfitPrice: targets.takeProfitPrice,
    };
  }

  return { status: "skipped", reason: "no-cluster-detected" };
}
