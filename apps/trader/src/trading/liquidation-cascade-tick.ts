/**
 * Liquidation-cascade live tick (Phase 2 v1 — legacy in-process loop).
 *
 * Single-symbol, single-position-at-a-time mean-reversion play. Per tick:
 *
 *   if no position:
 *     iterate allowedSymbols → reader.getRecent → evaluateLiquidationCascade
 *     if any cluster triggers `enter`:
 *       evaluateRisk (spread/cooldown/daily-loss) → if allowed, open
 *       (one-shot per tick — stops at first opened position)
 *
 *   if position open:
 *     fetch current ticker for tracked symbol
 *     if now - openedAt > maxHoldSec * 1000 → close (exitReason="liquidation-max-hold")
 *     else if getExitReason → close (take-profit | stop-loss)
 *
 * Risk profile: NOT aggressive-perps. Standard `evaluateRisk` only.
 *
 * DI is full: caller wires the live bybit client, ticker source, liquidations
 * reader, alerter, and ledger; tests pass stubs.
 *
 * Note on position tracking: this strategy reuses `state.position` (the same
 * slot the MA-crossover loop uses) so the single-position-invariant is shared
 * across the trader. This keeps cross-strategy risk gating (max-position,
 * daily-loss) consistent without duplicating tracking shape.
 */
import {
  buildPositionTargets,
  evaluateRisk,
  getExitReason,
  rolloverDailyPnlIfNeeded,
  updatePaperState,
  type OpenPosition,
  type TraderState,
} from "@ai-scalper/trading-core";
import type { createBybitClient, InstrumentInfo, MarketTicker } from "@ai-scalper/bybit-client";
import type { TraderConfig } from "../config";
import type { WebhookAlerter } from "../alerts/webhook";
import { evaluateLiquidationCascade } from "../strategies/liquidation-cascade-evaluate";
import type { LiquidationsReader } from "../strategies/liquidations-cache-reader";
import type { ClosedPositionLedgerEntry } from "./position-ledger";

type BybitClient = ReturnType<typeof createBybitClient>;

export interface LiquidationCascadeTickerSource {
  getTicker(symbol: string, opts?: { category?: string }): Promise<MarketTicker>;
}

export interface LiquidationCascadeLedger {
  appendClosedPosition(entry: ClosedPositionLedgerEntry): Promise<void>;
}

export interface LiquidationCascadeMutableRef<T> {
  get(): T;
  set(v: T): void;
}

export interface LiquidationCascadeTickDeps {
  config: TraderConfig;
  client: BybitClient;
  tickerSource: LiquidationCascadeTickerSource;
  alerter: WebhookAlerter;
  liquidationsReader: LiquidationsReader;
  positionLedger: LiquidationCascadeLedger;
  stateRef: LiquidationCascadeMutableRef<TraderState>;
  /** Tracks the symbol of the currently-open position (null when flat). */
  openPositionSymbolRef: LiquidationCascadeMutableRef<string | null>;
  /** Optional log sink — defaults to console.log JSON-line. */
  log?: (payload: Record<string, unknown>) => void;
  now?: () => number;
}

export type LiquidationCascadeTickResult =
  | { status: "no-action"; reason: string }
  | { status: "opened"; symbol: string; side: "long" | "short"; qty: number; entryPrice: number; clusterUsd: number }
  | { status: "closed"; symbol: string; exitReason: string; exitPrice: number; realizedPnlUsd: number };

const DEFAULT_LIQUIDATION_SPREAD_BPS = 1; // strategy doesn't fetch spread for entry; pass nominal value to evaluateRisk

function normalizeQty(rawQty: number, qtyStep: string): string {
  const step = Number(qtyStep);
  if (!Number.isFinite(step) || step <= 0) return String(rawQty);
  const steps = Math.floor(rawQty / step);
  const normalized = steps * step;
  // Match precision of qtyStep to avoid scientific notation / float dust.
  const dec = (qtyStep.split(".")[1] ?? "").length;
  return normalized.toFixed(dec);
}

export async function runLiquidationCascadeTick(
  deps: LiquidationCascadeTickDeps,
): Promise<LiquidationCascadeTickResult> {
  const { config, client, tickerSource, alerter, liquidationsReader, positionLedger } = deps;
  const log = deps.log ?? ((p) => console.log(JSON.stringify(p)));
  const now = (deps.now ?? Date.now)();
  const observedAt = new Date(now).toISOString();

  // Daily rollover (defensive — caller usually does this at top-of-tick too)
  deps.stateRef.set(rolloverDailyPnlIfNeeded(deps.stateRef.get(), now));
  const state = deps.stateRef.get();

  // ── Path A: position open → manage exits ────────────────────────────────
  if (state.position && deps.openPositionSymbolRef.get()) {
    const symbol = deps.openPositionSymbolRef.get() as string;
    const position = state.position;

    // Fetch ticker for current price.
    let currentPrice = position.entryPrice;
    try {
      const ticker = await tickerSource.getTicker(symbol, { category: config.category });
      const p = Number(ticker.lastPrice);
      if (Number.isFinite(p) && p > 0) currentPrice = p;
    } catch (err) {
      log({
        ts: observedAt,
        event: "liquidation-cascade-ticker-unavailable",
        symbol,
        error: err instanceof Error ? err.message : String(err),
      });
      return { status: "no-action", reason: "ticker-unavailable" };
    }

    // Time-based exit
    const heldMs = now - position.openedAt;
    let exitReason: string | null = null;
    if (heldMs > config.liquidationMaxHoldSec * 1000) {
      exitReason = "liquidation-max-hold";
    } else {
      // SL/TP via trading-core. We pass signal="flat" so signal-reversal cannot fire
      // (liquidation-cascade has no MA-style "current signal").
      const reason = getExitReason({ marketPrice: currentPrice, signal: "flat", state });
      if (reason === "take-profit" || reason === "stop-loss") {
        exitReason = reason;
      }
    }

    if (!exitReason) {
      return { status: "no-action", reason: "position-held" };
    }

    return await closePosition({
      ...deps, log, now, observedAt, symbol, position, currentPrice, exitReason,
      alerter, client, positionLedger,
    });
  }

  // ── Path B: flat → look for entry ───────────────────────────────────────
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

    // ── Entry path ────────────────────────────────────────────────────────
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

    // Standard risk gate. Spread is unknown here (we don't always have bid/ask)
    // so use the ticker if present, fallback to nominal.
    const bid = Number(ticker.bid1Price ?? 0);
    const ask = Number(ticker.ask1Price ?? 0);
    let spreadBps = DEFAULT_LIQUIDATION_SPREAD_BPS;
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
      const mid = (bid + ask) / 2;
      spreadBps = mid > 0 ? ((ask - bid) / mid) * 10_000 : DEFAULT_LIQUIDATION_SPREAD_BPS;
    }

    const notionalUsd = config.liquidationOrderUsd * config.liquidationLeverage;
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
      state: deps.stateRef.get(),
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
      // Risk-blocked at one symbol → try the next.
      continue;
    }

    // qty from notional
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

    const rawQty = notionalUsd / lastPrice;
    const qtyStr = normalizeQty(rawQty, instrument.lotSizeFilter.qtyStep);
    const qty = Number(qtyStr);
    const minQty = Number(instrument.lotSizeFilter.minOrderQty);
    if (!Number.isFinite(qty) || qty <= 0 || (Number.isFinite(minQty) && qty < minQty)) {
      log({
        ts: observedAt,
        event: "liquidation-cascade-qty-below-min",
        symbol,
        rawQty,
        normalizedQty: qty,
        minOrderQty: instrument.lotSizeFilter.minOrderQty,
      });
      continue;
    }

    // Live: set leverage + market order. Paper: skip.
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
        // non-fatal — leverage may already be configured
      }

      try {
        await client.createOrder({
          category: config.category,
          symbol,
          side: decision.side === "long" ? "Buy" : "Sell",
          qty: qtyStr,
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
        continue;
      }
    }

    // Update local state — reuse the standard updatePaperState so the position
    // slot is consistent with other strategies.
    const nextState = updatePaperState({
      action: decision.side,
      leverage: config.liquidationLeverage,
      notionalUsd,
      price: lastPrice,
      previous: deps.stateRef.get(),
      now,
      stopLossBps: config.liquidationStopLossBps,
      takeProfitBps: config.liquidationTakeProfitBps,
    });
    deps.stateRef.set(nextState);
    deps.openPositionSymbolRef.set(symbol);

    const targets = buildPositionTargets({
      action: decision.side,
      price: lastPrice,
      stopLossBps: config.liquidationStopLossBps,
      takeProfitBps: config.liquidationTakeProfitBps,
    });

    log({
      ts: observedAt,
      event: "liquidation-cascade-open",
      symbol,
      side: decision.side,
      qty,
      entryPrice: lastPrice,
      notionalUsd,
      leverage: config.liquidationLeverage,
      clusterUsd: decision.clusterUsd,
      reason: decision.reason,
      stopLossPrice: targets.stopLossPrice,
      takeProfitPrice: targets.takeProfitPrice,
    });

    return {
      status: "opened",
      symbol,
      side: decision.side,
      qty,
      entryPrice: lastPrice,
      clusterUsd: decision.clusterUsd,
    };
  }

  return { status: "no-action", reason: "no-cluster-detected" };
}

async function closePosition(params: {
  config: TraderConfig;
  client: BybitClient;
  alerter: WebhookAlerter;
  positionLedger: LiquidationCascadeLedger;
  stateRef: LiquidationCascadeMutableRef<TraderState>;
  openPositionSymbolRef: LiquidationCascadeMutableRef<string | null>;
  log: (payload: Record<string, unknown>) => void;
  now: number;
  observedAt: string;
  symbol: string;
  position: OpenPosition;
  currentPrice: number;
  exitReason: string;
}): Promise<LiquidationCascadeTickResult> {
  const { config, client, alerter, positionLedger, log, symbol, position, currentPrice, exitReason } = params;
  const closeSide = position.side === "long" ? "Sell" : "Buy";

  if (!config.paperTrading) {
    try {
      await client.createOrder({
        category: config.category,
        symbol,
        side: closeSide,
        qty: String(position.quantity),
        orderType: "Market",
        reduceOnly: true,
      });
    } catch (err) {
      log({
        ts: params.observedAt,
        event: "liquidation-cascade-close-failed",
        symbol,
        error: err instanceof Error ? err.message : String(err),
      });
      await alerter.send(`liquidation-cascade close failed: ${symbol}`).catch(() => {});
      return { status: "no-action", reason: "close-order-failed" };
    }
  }

  const previousState = params.stateRef.get();
  const previousRealized = previousState.realizedPnlUsd;
  const nextState = updatePaperState({
    action: position.side,
    leverage: position.leverage,
    notionalUsd: position.notionalUsd,
    price: currentPrice,
    previous: previousState,
    now: params.now,
    stopLossBps: 0,
    takeProfitBps: 0,
    reduceOnly: true,
    feeRoundTripBps: config.feeRoundTripBps,
  });
  params.stateRef.set(nextState);
  params.openPositionSymbolRef.set(null);

  const realizedPnlUsd = nextState.realizedPnlUsd - previousRealized;
  const grossDelta = position.side === "long"
    ? (currentPrice - position.entryPrice) * position.quantity
    : (position.entryPrice - currentPrice) * position.quantity;
  const feeUsd = position.notionalUsd * (config.feeRoundTripBps / 10_000);

  await positionLedger.appendClosedPosition({
    closedAt: new Date(params.now).toISOString(),
    cumulativeRealizedPnlUsd: nextState.realizedPnlUsd,
    entryPrice: position.entryPrice,
    exitPrice: currentPrice,
    exitReason,
    leverage: position.leverage,
    notionalUsd: position.notionalUsd,
    openedAt: new Date(position.openedAt).toISOString(),
    quantity: position.quantity,
    realizedPnlUsd,
    grossPnlUsd: grossDelta,
    feeUsd,
    strategyType: "liquidation-cascade",
    side: position.side,
    stopLossPrice: position.stopLossPrice,
    symbol,
    takeProfitPrice: position.takeProfitPrice,
  });

  log({
    ts: params.observedAt,
    event: "liquidation-cascade-close",
    symbol,
    side: position.side,
    exitReason,
    entryPrice: position.entryPrice,
    exitPrice: currentPrice,
    quantity: position.quantity,
    realizedPnlUsd,
    grossPnlUsd: grossDelta,
    feeUsd,
  });

  return {
    status: "closed",
    symbol,
    exitReason,
    exitPrice: currentPrice,
    realizedPnlUsd,
  };
}
