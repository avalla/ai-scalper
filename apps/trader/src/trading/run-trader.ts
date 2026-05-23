import {
  createBybitClient,
  type CreateOrderRequest,
  type InstrumentInfo,
  type PositionInfo,
  type RealtimeOrder,
} from "@ai-scalper/bybit-client";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyConfidenceSizing,
  buildSignal,
  computeTrailingStop,
  evaluateAggressivePerpsRisk,
  evaluateDrawdownVelocity,
  evaluateRisk,
  getExitReason,
  reconcilePositions,
  recordPnlSample,
  resolveProjectPath,
  rolloverDailyPnlIfNeeded,
  selectLeverageForOpportunity,
  updatePaperState,
  type DrawdownVelocityState,
  type StrategySignal,
  type TraderState,
} from "@ai-scalper/trading-core";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { step, type StepContext } from "./step";
import { defaultVariantPool, type Variant } from "../meta/variant-pool";
import {
  emptyAllocatorState,
  loadAllocatorState,
  persistAllocatorState,
  recordClosedTrade,
  selectChampion,
  type AllocatorState,
} from "../meta/allocator";
import {
  autoTuneSetupGate,
  loadScanHistory,
  rankTradeSetups,
  readScanConfig,
  type RankedTradeSetup,
} from "@ai-scalper/market-scanner";
import { createWebhookAlerter, type WebhookAlerter } from "../alerts/webhook";
import type { TraderConfig } from "../config";
import { buildEntryExecutionPlan } from "./execution-policy";
import {
  isSymbolInTickerCooldown,
  registerTickerFailure,
  registerTickerSuccess,
  type SymbolAvailabilityState,
} from "./symbol-availability";
import { resolveWalletOrderUsd } from "./wallet-sizing";
import {
  createPositionLedger,
  type ClosedPositionLedgerEntry,
  type PersistedTraderSnapshot,
} from "./position-ledger";
import { fundingArbDecide } from "../strategies/funding-arb";
import { longerTfSignal, type LongerTfKlineCache } from "../strategies/longer-tf";
import {
  basisArbDecide,
  computeBasisBps,
  type BasisPosition,
} from "../strategies/basis-arb";
import {
  calendarDecide,
  computeCalendarSpreadBps,
  type CalendarPosition,
} from "../strategies/calendar-spread";
import {
  pairsDecide,
  type PairsCache,
  type PairsPosition,
} from "../strategies/pairs-trading";
import {
  bollingerAdxDecide,
  type BollingerAdxKlineCache,
  type BollingerAdxPosition,
} from "../strategies/bollinger-adx";
import {
  checkSafetyOverride as llmManagedCheckSafetyOverride,
  computePnlBps as llmManagedComputePnlBps,
  computePnlUsd as llmManagedComputePnlUsd,
  getManageDecision as llmManagedGetManageDecision,
  getOpenDecision as llmManagedGetOpenDecision,
  updateExcursions as llmManagedUpdateExcursions,
  type LlmManagedMarketContext,
  type LlmManagedPosition,
  type ManageDecision as LlmManageDecision,
} from "../strategies/llm-managed";
import {
  getOrderApproval,
  type OrderSupervisorContext,
  type SupervisedStrategy,
} from "../meta/order-supervisor";

const SUPERVISED_STRATEGY_TYPES: ReadonlyArray<SupervisedStrategy> = [
  "funding-arb",
  "basis-arb",
  "pairs-trading",
  "calendar-spread",
];

function isSupervisedStrategy(s: string): s is SupervisedStrategy {
  return (SUPERVISED_STRATEGY_TYPES as ReadonlyArray<string>).includes(s);
}

/**
 * Pre-entry LLM order supervisor gate. Returns true to PROCEED with the
 * entry, false to SKIP it. Hard-coded fail-safe: any unexpected throw is
 * caught and treated per `orderSupervisorOnErrorBehavior` (default reject).
 *
 * NOTE: this is a synchronous blocking call (typically 2–5s, bounded by
 * `orderSupervisorTimeoutMs`). It is intentionally NOT applied to fast
 * strategies (ma-crossover, longer-tf, bollinger-adx) where the latency
 * would kill the setup. It is also NOT applied to exits — exits must be
 * deterministic so a failed LLM call cannot leave a dangling position.
 */
async function maybeSupervisedApprove(args: {
  alerter: WebhookAlerter;
  config: TraderConfig;
  context: OrderSupervisorContext;
  observedAt: string;
}): Promise<boolean> {
  const { alerter, config, context, observedAt } = args;
  if (!config.orderSupervisorEnabled) return true;
  if (!isSupervisedStrategy(context.strategyType)) return true;
  if (!config.orderSupervisorStrategies.includes(context.strategyType)) return true;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    // Not configured — treat per onErrorBehavior (default reject).
    const approve = config.orderSupervisorOnErrorBehavior === "approve";
    console.log(JSON.stringify({
      ts: observedAt,
      event: "order-supervisor-skipped",
      reason: "no-api-key",
      strategyType: context.strategyType,
      symbol: context.symbol,
      effectiveApprove: approve,
    }));
    return approve;
  }
  let verdict;
  try {
    verdict = await getOrderApproval({
      context,
      apiKey,
      model: config.orderSupervisorModel,
      timeoutMs: config.orderSupervisorTimeoutMs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const approve = config.orderSupervisorOnErrorBehavior === "approve";
    console.log(JSON.stringify({
      ts: observedAt,
      event: "order-supervisor-unexpected-error",
      strategyType: context.strategyType,
      symbol: context.symbol,
      error: msg,
      effectiveApprove: approve,
    }));
    return approve;
  }
  const effectiveApprove =
    verdict.approved && verdict.confidence >= config.orderSupervisorMinConfidence;
  console.log(JSON.stringify({
    ts: observedAt,
    event: "order-supervisor-verdict",
    strategyType: context.strategyType,
    symbol: context.symbol,
    side: context.side,
    notionalUsd: context.notionalUsd,
    approved: verdict.approved,
    effectiveApprove,
    confidence: verdict.confidence,
    reasoning: verdict.reasoning,
    concerns: verdict.concerns,
  }));
  if (!effectiveApprove) {
    await alerter.send(
      `order rejected by supervisor: ${verdict.reasoning}`,
      { symbol: context.symbol, side: context.side, strategyType: context.strategyType },
    ).catch(() => {});
  }
  return effectiveApprove;
}

function toNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value: ${value}`);
  }
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toOrderSide(action: Exclude<StrategySignal, "flat">): "Buy" | "Sell" {
  return action === "long" ? "Buy" : "Sell";
}

function countDecimals(value: string): number {
  const parts = value.split(".");
  return parts[1]?.length ?? 0;
}

function toStep(value: string): number {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    throw new Error(`Invalid step value: ${value}`);
  }
  return numericValue;
}

function clampLeverage(configuredLeverage: number, instrument: InstrumentInfo): number {
  const minLeverage = Number(instrument.leverageFilter.minLeverage);
  const maxLeverage = Number(instrument.leverageFilter.maxLeverage);

  if (!Number.isFinite(minLeverage) || !Number.isFinite(maxLeverage)) {
    throw new Error("Invalid leverage limits from instrument metadata");
  }

  return Math.min(Math.max(configuredLeverage, minLeverage), maxLeverage);
}

function computeNotionalUsd(orderUsd: number, leverage: number): number {
  return orderUsd * leverage;
}

function toOrderQty(params: {
  instrument: InstrumentInfo;
  notionalUsd: number;
  price: number;
}): string {
  const rawQty = params.notionalUsd / params.price;
  const qtyStep = toStep(params.instrument.lotSizeFilter.qtyStep);
  const minQty = toStep(params.instrument.lotSizeFilter.minOrderQty);
  const maxQty = toStep(params.instrument.lotSizeFilter.maxMktOrderQty);
  const normalizedQty = Math.floor(rawQty / qtyStep) * qtyStep;

  if (normalizedQty < minQty) {
    throw new Error(`Order quantity ${normalizedQty} is below instrument minimum ${minQty}`);
  }

  if (normalizedQty > maxQty) {
    throw new Error(`Order quantity ${normalizedQty} exceeds market maximum ${maxQty}`);
  }

  return normalizedQty.toFixed(countDecimals(params.instrument.lotSizeFilter.qtyStep));
}


async function executeTrade(params: {
  action: Exclude<StrategySignal, "flat">;
  client: ReturnType<typeof createBybitClient>;
  config: TraderConfig;
  instrument: InstrumentInfo;
  lastPrice: number;
  symbol: string;
  tickerBidPrice?: string;
  tickerAskPrice?: string;
  qty: string;
  reduceOnly?: boolean;
}): Promise<{
  executionMode: string;
  fallbackUsed: boolean;
  filled: boolean;
  fillPrice: number;
  orderLinkId?: string;

}> {
  if (params.reduceOnly || params.config.entryExecutionMode === "taker") {
    if (params.reduceOnly) {
      // Close position with a limit maker order at best bid/ask to avoid taker fees.
      // For a long close (sell): limit at bid1Price — sits at top of book, fills as maker.
      // For a short close (buy): limit at ask1Price — same logic.
      const makerClosePrice = params.action === "short"
        ? (params.tickerBidPrice ?? params.lastPrice.toString())
        : (params.tickerAskPrice ?? params.lastPrice.toString());
      const decimals = countDecimals(params.instrument.priceFilter.tickSize);
      const makerClosePriceStr = Number(makerClosePrice).toFixed(decimals);

      const closeLinkId = crypto.randomUUID();
      const request: CreateOrderRequest = {
        category: params.config.category,
        symbol: params.symbol,
        side: toOrderSide(params.action),
        qty: params.qty,
        orderType: "Limit",
        price: makerClosePriceStr,
        timeInForce: "GTC",
        reduceOnly: true,
        closeOnTrigger: true,
        orderLinkId: closeLinkId,
      };

      if (!params.config.paperTrading) {
        try {
          await params.client.createOrder(request);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (msg.includes("reduce-only") || msg.includes("position idx not match") || msg.includes("order quantity exceeded lower limit")) {
            console.log(`[executeTrade] reduce-only limit rejected (position already closed): ${msg}`);
            return { executionMode: "maker-reduce-only", fallbackUsed: false, filled: true, fillPrice: Number(makerClosePrice) };
          }
          throw error;
        }
        // Order placed — caller tracks orderLinkId for fill confirmation
        return {
          executionMode: "maker-reduce-only",
          fallbackUsed: false,
          filled: false,
          fillPrice: Number(makerClosePrice),
          orderLinkId: closeLinkId,
        };
      }

      // Paper trading: treat as immediate fill
      return {
        executionMode: "maker-reduce-only",
        fallbackUsed: false,
        filled: true,
        fillPrice: Number(makerClosePrice),
      };
    }

    // Entry taker order with exchange-side TP/SL protection.
    const request: CreateOrderRequest = {
      category: params.config.category,
      symbol: params.symbol,
      side: toOrderSide(params.action),
      qty: params.qty,
      orderType: "Market",
      reduceOnly: false,
      closeOnTrigger: false,
      slippageToleranceType: "Percent",
      slippageTolerance: params.config.slippageTolerancePercent.toString(),
    };

    if (!params.config.paperTrading) {
      await params.client.createOrder(request);
    }

    return {
      executionMode: "taker",
      fallbackUsed: false,
      filled: true,
      fillPrice: params.lastPrice,

    };
  }

  const entryPlan = buildEntryExecutionPlan({
    action: params.action,
    config: params.config,
    instrument: params.instrument,
    ticker: {
      symbol: params.symbol,
      lastPrice: params.lastPrice.toString(),
      markPrice: params.lastPrice.toString(),
      indexPrice: params.lastPrice.toString(),
      prevPrice1h: params.lastPrice.toString(),
      prevPrice24h: params.lastPrice.toString(),
      price24hPcnt: "0",
      turnover24h: "0",
      volume24h: "0",
      openInterestValue: "0",
      fundingRate: "0",
      nextFundingTime: "0",
      bid1Price: params.tickerBidPrice ?? params.lastPrice.toString(),
      ask1Price: params.tickerAskPrice ?? params.lastPrice.toString(),
      bid1Size: "0",
      ask1Size: "0",
    },
  });

  if (params.config.paperTrading) {
    return {
      executionMode: entryPlan.mode,
      fallbackUsed: false,
      filled: true,
      fillPrice: entryPlan.limitPrice ?? params.lastPrice,
    };
  }

  const orderLinkId = crypto.randomUUID();
  await params.client.createOrder({
    category: params.config.category,
    symbol: params.symbol,
    side: toOrderSide(params.action),
    qty: params.qty,
    orderType: entryPlan.orderType,
    price: entryPlan.limitPrice?.toString(),
    timeInForce: entryPlan.timeInForce,
    orderLinkId,
  });

  const resolution = await waitForEntryOrderResolution({
    action: params.action,
    client: params.client,
    config: params.config,
    orderLinkId,
    qty: params.qty,
    symbol: params.symbol,
  });

  if (resolution.status === "filled") {
    return {
      executionMode: entryPlan.mode,
      fallbackUsed: false,
      filled: true,
      fillPrice: resolution.fillPrice ?? entryPlan.limitPrice ?? params.lastPrice,

    };
  }

  if (entryPlan.shouldFallbackToTaker) {
    // Cancel the unfilled maker order first so Bybit releases the reserved margin
    await params.client.cancelOrder({
      category: params.config.category,
      symbol: params.symbol,
      orderLinkId,
    }).catch(() => {
      // Order may have already been cancelled or filled — proceed with fallback
    });

    await params.client.createOrder({
      category: params.config.category,
      symbol: params.symbol,
      side: toOrderSide(params.action),
      qty: params.qty,
      orderType: "Market",
      slippageToleranceType: "Percent",
      slippageTolerance: params.config.slippageTolerancePercent.toString(),
    });

    return {
      executionMode: entryPlan.mode,
      fallbackUsed: true,
      filled: true,
      fillPrice: params.lastPrice,

    };
  }

  return {
    executionMode: entryPlan.mode,
    fallbackUsed: false,
    filled: false,
    fillPrice: entryPlan.limitPrice ?? params.lastPrice,
  };
}

async function trySetTradingStop(params: {
  client: ReturnType<typeof createBybitClient>;
  request: {
    category: string;
    symbol: string;
    stopLoss?: string;
    takeProfit?: string;
    positionIdx?: 0 | 1 | 2;
  };
  retryMax: number;
  retryDelayMs: number;
  alertHook?: WebhookAlerter;
}): Promise<boolean> {
  const total = Math.max(1, params.retryMax + 1);
  for (let i = 0; i < total; i++) {
    try {
      await params.client.setTradingStop(params.request);
      return true;
    } catch (err) {
      const code = (err as { retCode?: number }).retCode;
      const msg = err instanceof Error ? err.message : String(err);
      if (code === 110017) {
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          event: "set-trading-stop-hedge-mismatch",
          symbol: params.request.symbol,
          retCode: code,
          error: msg,
        }));
        return false;
      }
      const isLast = i === total - 1;
      if (isLast) {
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          event: "set-trading-stop-failed-after-retries",
          symbol: params.request.symbol,
          attempts: total,
          retCode: code ?? null,
          error: msg,
        }));
        if (params.alertHook) {
          await params.alertHook.send(
            `setTradingStop failed for ${params.request.symbol} after ${total} attempts: ${msg}`,
            { retCode: code ?? null },
          );
        }
        return false;
      }
      const delay = params.retryDelayMs * Math.pow(2, i);
      await sleep(delay);
    }
  }
  return false;
}

function toExecutedQuantity(order: RealtimeOrder | null): number {
  if (!order) {
    return 0;
  }

  return toNumber(order.cumExecQty || "0");
}

async function flattenPartialEntryIfNeeded(params: {
  action: Exclude<StrategySignal, "flat">;
  client: ReturnType<typeof createBybitClient>;
  config: TraderConfig;
  order: RealtimeOrder | null;
  symbol: string;
}): Promise<void> {
  const executedQuantity = toExecutedQuantity(params.order);
  if (executedQuantity <= 0) {
    return;
  }

  const flattenAction: Exclude<StrategySignal, "flat"> = params.action === "long" ? "short" : "long";
  await params.client.createOrder({
    category: params.config.category,
    symbol: params.symbol,
    side: toOrderSide(flattenAction),
    qty: params.order?.cumExecQty ?? "0",
    orderType: "Market",
    reduceOnly: true,
    closeOnTrigger: true,
    slippageToleranceType: "Percent",
    slippageTolerance: params.config.slippageTolerancePercent.toString(),
  });
}

async function waitForEntryOrderResolution(params: {
  action: Exclude<StrategySignal, "flat">;
  client: ReturnType<typeof createBybitClient>;
  config: TraderConfig;
  orderLinkId: string;
  qty: string;
  symbol: string;
}): Promise<{
  fillPrice: number | null;
  status: "filled" | "not-filled";
}> {
  const startedAt = Date.now();
  let latestOrder: RealtimeOrder | null = null;

  while (Date.now() - startedAt < params.config.entryMakerTimeoutMs) {
    const openOrder = await params.client.getRealtimeOrder({
      category: params.config.category,
      symbol: params.symbol,
      orderLinkId: params.orderLinkId,
      openOnly: 0,
    });
    const closedOrder = openOrder ?? await params.client.getRealtimeOrder({
      category: params.config.category,
      symbol: params.symbol,
      orderLinkId: params.orderLinkId,
      openOnly: 1,
    });
    latestOrder = closedOrder;

    if (closedOrder?.orderStatus === "Filled") {
      return {
        fillPrice: closedOrder.avgPrice ? toNumber(closedOrder.avgPrice) : null,
        status: "filled",
      };
    }

    if (closedOrder?.orderStatus === "Cancelled" || closedOrder?.orderStatus === "Rejected") {
      await flattenPartialEntryIfNeeded({
        action: params.action,
        client: params.client,
        config: params.config,
        order: closedOrder,
        symbol: params.symbol,
      });
      return {
        fillPrice: null,
        status: "not-filled",
      };
    }

    await sleep(params.config.entryMakerPollMs);
  }

  await params.client.cancelOrder({
    category: params.config.category,
    symbol: params.symbol,
    orderLinkId: params.orderLinkId,
  });
  const closedOrder = await params.client.getRealtimeOrder({
    category: params.config.category,
    symbol: params.symbol,
    orderLinkId: params.orderLinkId,
    openOnly: 1,
  }) ?? latestOrder;

  await flattenPartialEntryIfNeeded({
    action: params.action,
    client: params.client,
    config: params.config,
    order: closedOrder,
    symbol: params.symbol,
  });

  return {
    fillPrice: null,
    status: "not-filled",
  };
}

async function getInstrument(params: {
  cache: Map<string, InstrumentInfo>;
  category: string;
  client: ReturnType<typeof createBybitClient>;
  symbol: string;
}): Promise<InstrumentInfo> {
  const cachedInstrument = params.cache.get(params.symbol);
  if (cachedInstrument) {
    return cachedInstrument;
  }

  const instrument = await params.client.getInstrumentInfo({
    category: params.category,
    symbol: params.symbol,
  });
  params.cache.set(params.symbol, instrument);
  return instrument;
}

function getPriceHistory(params: {
  priceHistoryBySymbol: Map<string, number[]>;
  symbol: string;
}): number[] {
  const existing = params.priceHistoryBySymbol.get(params.symbol);
  if (existing) {
    return existing;
  }

  const prices: number[] = [];
  params.priceHistoryBySymbol.set(params.symbol, prices);

  return prices;
}

function evaluateTopSetupGate(params: {
  minNetEdgeBps: number;
  minScore: number;
  setup: RankedTradeSetup | null;
}): string | null {
  const { setup } = params;

  if (!setup) {
    return "no-ranked-setup";
  }

  if (setup.score < params.minScore) {
    return "scan-score-too-low";
  }

  if (setup.netEdgeBps < params.minNetEdgeBps) {
    return "scan-edge-too-low";
  }

  if (setup.action === "flat") {
    return "scan-action-flat";
  }

  return null;
}

function maybeAggressiveLogFields(config: TraderConfig, activeAggressiveAllowedSymbols: string[]): Record<string, unknown> {
  if (config.tradingProfile !== "aggressive-perps") {
    return {};
  }

  return {
    aggressiveAllowedSymbols: activeAggressiveAllowedSymbols,
  };
}

function summarizeTopRankedSetups(setups: RankedTradeSetup[]): Array<Record<string, unknown>> {
  return setups.slice(0, 5).map((setup) => ({
    symbol: setup.symbol,
    action: setup.action,
    score: setup.score,
    netEdgeBps: setup.netEdgeBps,
    trendBps: setup.trendBps,
    spreadBps: setup.spreadBps,
    fundingRateBps: setup.fundingRateBps,
  }));
}

async function persistRuntimeArtifact(payload: {
  activeSymbol: string;
  candidateSymbols: string[];
  marketScanGate: string;
  marketScanGateGeneratedAt: string | null;
  rankedSymbols: string[];
  rankedSetupsTop: Array<Record<string, unknown>>;
  openPositionSymbol: string | null;
  perSymbol: Record<string, Record<string, unknown>>;
  scanGate: string;
  scanGateGeneratedAt: string | null;
  tradingProfile: TraderConfig["tradingProfile"];
}): Promise<string> {
  const cwd = process.cwd();
  const runtimeDir = cwd.endsWith("/apps/trader")
    ? join(cwd, "data", "runtime")
    : join(cwd, "apps", "trader", "data", "runtime");
  await mkdir(runtimeDir, { recursive: true });
  const runtimePath = join(runtimeDir, "active-symbols.json");

  await Bun.write(runtimePath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    ...payload,
  }, null, 2)}\n`);

  return runtimePath;
}

function toPersistedTraderSnapshot(params: {
  openPositionSymbol: string | null;
  state: TraderState;
}): PersistedTraderSnapshot {
  return {
    lastTradeAt: params.state.lastTradeAt,
    realizedPnlUsd: params.state.realizedPnlUsd,
    position: params.state.position,
    dayStartedAt: params.state.dayStartedAt,
    openPositionSymbol: params.openPositionSymbol,
    updatedAt: new Date().toISOString(),
  };
}

function buildClosedPositionLedgerEntry(params: {
  exitPrice: number;
  exitReason: string;
  nextState: TraderState;
  previousState: TraderState;
  previousPosition: NonNullable<TraderState["position"]>;
  symbol: string;
  feeRoundTripBps: number;
  championIdAtEntry?: string | null;
  strategyType?: "ma-crossover" | "funding-arb" | "longer-tf" | "basis-arb" | "pairs-trading" | "bollinger-adx" | "calendar-spread" | "llm-managed";
  basisEntryBps?: number;
  basisExitBps?: number;
  pairsLeg2Symbol?: string;
  pairsEntryZ?: number;
  pairsExitZ?: number;
}): ClosedPositionLedgerEntry {
  const netPnl = params.nextState.realizedPnlUsd - params.previousState.realizedPnlUsd;
  const feeUsd = params.feeRoundTripBps > 0
    ? params.previousPosition.notionalUsd * (params.feeRoundTripBps / 10_000)
    : 0;
  const grossPnl = netPnl + feeUsd;
  return {
    closedAt: new Date().toISOString(),
    cumulativeRealizedPnlUsd: params.nextState.realizedPnlUsd,
    entryPrice: params.previousPosition.entryPrice,
    exitPrice: params.exitPrice,
    exitReason: params.exitReason,
    leverage: params.previousPosition.leverage,
    notionalUsd: params.previousPosition.notionalUsd,
    openedAt: new Date(params.previousPosition.openedAt).toISOString(),
    quantity: params.previousPosition.quantity,
    realizedPnlUsd: netPnl,
    grossPnlUsd: grossPnl,
    feeUsd,
    championIdAtEntry: params.championIdAtEntry ?? null,
    strategyType: params.strategyType,
    basisEntryBps: params.basisEntryBps,
    basisExitBps: params.basisExitBps,
    pairsLeg2Symbol: params.pairsLeg2Symbol,
    pairsEntryZ: params.pairsEntryZ,
    pairsExitZ: params.pairsExitZ,
    side: params.previousPosition.side,
    stopLossPrice: params.previousPosition.stopLossPrice,
    symbol: params.symbol,
    takeProfitPrice: params.previousPosition.takeProfitPrice,
  };
}

function isLivePositionAligned(params: {
  livePosition: PositionInfo;
  persistedSnapshot: PersistedTraderSnapshot;
}): boolean {
  const persistedPosition = params.persistedSnapshot.position;
  if (!persistedPosition) {
    return false;
  }

  const liveSize = toNumber(params.livePosition.size);
  const sideMatches = (
    (params.livePosition.side === "Buy" && persistedPosition.side === "long")
    || (params.livePosition.side === "Sell" && persistedPosition.side === "short")
  );

  return sideMatches && Math.abs(liveSize - persistedPosition.quantity) < 0.000001;
}

function sessionLockPath(): string {
  return resolveProjectPath("apps/trader/data/runtime/session.lock");
}

function resolvePositionIdx(params: {
  side: "long" | "short";
  positionMode: "one-way" | "hedge";
}): 0 | 1 | 2 {
  if (params.positionMode === "one-way") {
    return 0;
  }
  return params.side === "long" ? 1 : 2;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM"; // EPERM = process exists but we can't signal it
  }
}

function acquireSessionLock(): void {
  const lockPath = sessionLockPath();
  if (existsSync(lockPath)) {
    try {
      const contents = readFileSync(lockPath, "utf8").trim();
      const pid = Number(contents);
      if (Number.isFinite(pid) && pid > 0 && isPidAlive(pid)) {
        throw new Error(`Another trader session is running (pid=${pid}). Refusing to start.`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Another trader session")) {
        throw err;
      }
      // stale lock — fall through and overwrite
    }
  }
  writeFileSync(lockPath, String(process.pid), "utf8");
}

function releaseSessionLock(): void {
  const lockPath = sessionLockPath();
  try {
    if (existsSync(lockPath)) {
      const contents = readFileSync(lockPath, "utf8").trim();
      if (contents === String(process.pid)) {
        unlinkSync(lockPath);
      }
    }
  } catch {
    // best effort
  }
}

interface MutableRef<T> {
  get(): T;
  set(value: T): void;
}

async function runAlternativeStrategyTick(params: {
  alerter: WebhookAlerter;
  buildClosedPositionLedgerEntry: typeof buildClosedPositionLedgerEntry;
  client: ReturnType<typeof createBybitClient>;
  config: TraderConfig;
  fundingTargetRef: MutableRef<number | null>;
  getInstrument: (symbol: string) => Promise<InstrumentInfo>;
  longerTfKlineCacheBySymbol: Map<string, LongerTfKlineCache>;
  observedAt: string;
  openPositionSymbolRef: MutableRef<string | null>;
  positionLedger: ReturnType<typeof createPositionLedger>;
  stateRef: MutableRef<TraderState>;
  toPersistedTraderSnapshot: (p: { openPositionSymbol: string | null; state: TraderState }) => PersistedTraderSnapshot;
}): Promise<{ shouldContinueLoop: boolean }> {
  const { config, client, stateRef, openPositionSymbolRef, fundingTargetRef } = params;
  const activeSymbol = params.config.tradeCandidateSymbols[0] ?? params.config.symbol;

  let instrument: InstrumentInfo;
  try {
    instrument = await params.getInstrument(activeSymbol);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify({
      ts: params.observedAt,
      strategyType: config.strategyType,
      symbol: activeSymbol,
      event: "instrument-unavailable",
      error: msg,
    }));
    return { shouldContinueLoop: true };
  }

  let ticker;
  try {
    ticker = await client.getTicker({ category: config.category, symbol: activeSymbol });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify({
      ts: params.observedAt,
      strategyType: config.strategyType,
      symbol: activeSymbol,
      event: "ticker-unavailable",
      error: msg,
    }));
    return { shouldContinueLoop: true };
  }

  const lastPrice = Number(ticker.lastPrice);
  const markPrice = Number(ticker.markPrice);
  const bid = Number(ticker.bid1Price);
  const ask = Number(ticker.ask1Price);
  const mid = (bid + ask) / 2;
  const spreadBps = mid > 0 ? ((ask - bid) / mid) * 10_000 : 0;
  const fundingRateBps = Number(ticker.fundingRate) * 10_000;
  const state = stateRef.get();

  // Decide action.
  let entryAction: "long" | "short" | null = null;
  let exitRequested = false;
  let decisionReason = "";
  let leverageForEntry = config.leverage;
  let orderUsdForEntry = config.orderUsd;
  let stopLossBpsForEntry = config.stopLossBps;
  let takeProfitBpsForEntry = config.takeProfitBps;
  let fundingTimeTargetForEntry: number | null = null;

  if (config.strategyType === "funding-arb") {
    const nextFundingTime = Number(ticker.nextFundingTime);
    const decision = fundingArbDecide({
      fundingRateBps,
      nextFundingTime: Number.isFinite(nextFundingTime) ? nextFundingTime : 0,
      now: Date.now(),
      symbol: activeSymbol,
      hasOpenPosition: state.position !== null && openPositionSymbolRef.get() === activeSymbol,
      openPositionEnteredForFundingTime: fundingTargetRef.get() ?? undefined,
      config: {
        minAbsRateBps: config.fundingArbMinAbsRateBps,
        entryWindowMinutesBefore: config.fundingArbEntryWindowMinutesBefore,
        exitDelayMinutesAfter: config.fundingArbExitDelayMinutesAfter,
      },
    });
    decisionReason = decision.reason;
    if (decision.kind === "enter") {
      entryAction = decision.side;
      fundingTimeTargetForEntry = decision.fundingTimeTarget;
      leverageForEntry = config.fundingArbMaxLeverage;
      orderUsdForEntry = Math.min(config.orderUsd, config.fundingArbMaxNotionalUsd / Math.max(1, leverageForEntry));
    } else if (decision.kind === "exit") {
      exitRequested = true;
    }
  } else {
    // longer-tf
    let cache = params.longerTfKlineCacheBySymbol.get(activeSymbol) ?? null;
    let sig = longerTfSignal({
      cache,
      now: Date.now(),
      refreshSec: config.longerTfKlineRefreshSec,
      symbol: activeSymbol,
      fastWindow: config.longerTfFastWindow,
      slowWindow: config.longerTfSlowWindow,
      thresholdBps: config.longerTfThresholdBps,
    });
    if (sig === "needs-refresh") {
      try {
        const klines = await client.getKlines({
          category: config.category,
          symbol: activeSymbol,
          interval: config.longerTfKlineInterval,
          limit: config.longerTfSlowWindow + 5,
        });
        // Bybit returns newest first; reverse for oldest-first MA series.
        const closePrices = klines.map((k) => Number(k.closePrice)).reverse();
        cache = { symbol: activeSymbol, fetchedAt: Date.now(), closePrices };
        params.longerTfKlineCacheBySymbol.set(activeSymbol, cache);
        sig = longerTfSignal({
          cache,
          now: Date.now(),
          refreshSec: config.longerTfKlineRefreshSec,
          symbol: activeSymbol,
          fastWindow: config.longerTfFastWindow,
          slowWindow: config.longerTfSlowWindow,
          thresholdBps: config.longerTfThresholdBps,
        });
      } catch (err) {
        console.log(JSON.stringify({
          ts: params.observedAt,
          strategyType: config.strategyType,
          symbol: activeSymbol,
          event: "klines-fetch-failed",
          error: err instanceof Error ? err.message : String(err),
        }));
        return { shouldContinueLoop: true };
      }
    }
    decisionReason = `longer-tf:${sig}`;
    leverageForEntry = config.leverage;
    orderUsdForEntry = config.orderUsd;
    stopLossBpsForEntry = config.longerTfStopLossBps;
    takeProfitBpsForEntry = config.longerTfTakeProfitBps;

    // Check exit conditions if we have an open position.
    const hasPos = state.position !== null && openPositionSymbolRef.get() === activeSymbol;
    if (hasPos) {
      const exitReason = getExitReason({
        marketPrice: lastPrice,
        signal: sig === "long" || sig === "short" || sig === "flat" ? sig : "flat",
        state,
      });
      if (exitReason) {
        exitRequested = true;
        decisionReason = `longer-tf-exit:${exitReason}`;
      }
    } else if (sig === "long" || sig === "short") {
      entryAction = sig;
    }
  }

  // ── EXIT path ────────────────────────────────────────────────────────────
  if (exitRequested && state.position && openPositionSymbolRef.get() === activeSymbol) {
    const closeAction: "long" | "short" = state.position.side === "long" ? "short" : "long";
    const closeQty = state.position.quantity.toFixed(countDecimals(instrument.lotSizeFilter.qtyStep));
    const exec = await executeTrade({
      action: closeAction,
      client,
      config,
      instrument,
      lastPrice,
      symbol: activeSymbol,
      tickerBidPrice: ticker.bid1Price,
      tickerAskPrice: ticker.ask1Price,
      qty: closeQty,
      reduceOnly: true,
    });
    if (exec.filled) {
      const previousState = state;
      const previousPosition = state.position;
      const newState = updatePaperState({
        action: closeAction,
        leverage: state.position.leverage,
        notionalUsd: state.position.notionalUsd,
        price: exec.fillPrice,
        previous: state,
        now: Date.now(),
        stopLossBps: stopLossBpsForEntry,
        takeProfitBps: takeProfitBpsForEntry,
        reduceOnly: true,
        feeRoundTripBps: config.feeRoundTripBps,
      });
      stateRef.set(newState);
      openPositionSymbolRef.set(null);
      fundingTargetRef.set(null);
      await params.positionLedger.appendClosedPosition(params.buildClosedPositionLedgerEntry({
        exitPrice: exec.fillPrice,
        exitReason: decisionReason,
        nextState: newState,
        previousState,
        previousPosition,
        symbol: activeSymbol,
        feeRoundTripBps: config.feeRoundTripBps,
        championIdAtEntry: null,
        strategyType: config.strategyType,
      }));
      await params.positionLedger.syncSnapshot(params.toPersistedTraderSnapshot({
        openPositionSymbol: null,
        state: newState,
      }));
    }
  }

  // ── ENTRY path ───────────────────────────────────────────────────────────
  if (entryAction && !state.position) {
    const notionalUsd = orderUsdForEntry * leverageForEntry;
    const risk = evaluateRisk({
      action: entryAction,
      limits: {
        maxPositionUsd: config.maxPositionUsd,
        maxDailyLossUsd: config.maxDailyLossUsd,
        minTradeIntervalMs: config.minTradeIntervalMs,
        maxSpreadBps: config.maxSpreadBps,
      },
      market: { lastPrice, markPrice },
      now: Date.now(),
      orderUsd: notionalUsd,
      state,
    });
    if (!risk.allowed) {
      console.log(JSON.stringify({
        ts: params.observedAt,
        strategyType: config.strategyType,
        symbol: activeSymbol,
        event: "entry-blocked-by-risk",
        reason: risk.reason,
        fundingRateBps,
        spreadBps,
      }));
      return { shouldContinueLoop: true };
    }
    const minLeverage = Number(instrument.leverageFilter.minLeverage);
    const maxLeverage = Number(instrument.leverageFilter.maxLeverage);
    const clampedLeverage = Math.min(Math.max(leverageForEntry, minLeverage), maxLeverage);
    const qtyStep = Number(instrument.lotSizeFilter.qtyStep);
    const rawQty = notionalUsd / lastPrice;
    const normalizedQty = Math.floor(rawQty / qtyStep) * qtyStep;
    const minQty = Number(instrument.lotSizeFilter.minOrderQty);
    if (normalizedQty < minQty) {
      console.log(JSON.stringify({
        ts: params.observedAt,
        strategyType: config.strategyType,
        symbol: activeSymbol,
        event: "qty-below-min",
        normalizedQty,
        minQty,
      }));
      return { shouldContinueLoop: true };
    }
    const qty = normalizedQty.toFixed(countDecimals(instrument.lotSizeFilter.qtyStep));
    // Pre-entry LLM order supervisor gate (only for supervised strategies).
    // Synchronous: blocks this tick up to `orderSupervisorTimeoutMs` (default 8s).
    // For funding-arb that latency is acceptable since trades are ~3/day.
    if (config.strategyType === "funding-arb") {
      const approve = await maybeSupervisedApprove({
        alerter: params.alerter,
        config,
        observedAt: params.observedAt,
        context: {
          strategyType: "funding-arb",
          symbol: activeSymbol,
          side: entryAction,
          notionalUsd,
          leverage: clampedLeverage,
          signalSnapshot: {
            fundingRateBps,
            nextFundingTime: Number(ticker.nextFundingTime),
            minutesToFunding: Number.isFinite(Number(ticker.nextFundingTime))
              ? Math.max(0, (Number(ticker.nextFundingTime) - Date.now()) / 60_000)
              : null,
          },
          recentTrades: 0,
          recentWinRate: 0,
          recentNetPnlUsd: 0,
          walletAvailableUsd: 0,
          openPositionsCount: state.position ? 1 : 0,
          cumulativeDailyPnlUsd: state.realizedPnlUsd,
        },
      });
      if (!approve) {
        return { shouldContinueLoop: true };
      }
    }
    const exec = await executeTrade({
      action: entryAction,
      client,
      config,
      instrument,
      lastPrice,
      symbol: activeSymbol,
      tickerBidPrice: ticker.bid1Price,
      tickerAskPrice: ticker.ask1Price,
      qty,
    });
    if (exec.filled) {
      const newState = updatePaperState({
        action: entryAction,
        leverage: clampedLeverage,
        notionalUsd,
        price: exec.fillPrice,
        previous: state,
        now: Date.now(),
        stopLossBps: stopLossBpsForEntry,
        takeProfitBps: takeProfitBpsForEntry,
      });
      stateRef.set(newState);
      openPositionSymbolRef.set(activeSymbol);
      if (config.strategyType === "funding-arb" && fundingTimeTargetForEntry !== null) {
        fundingTargetRef.set(fundingTimeTargetForEntry);
      }
      await params.positionLedger.syncSnapshot(params.toPersistedTraderSnapshot({
        openPositionSymbol: activeSymbol,
        state: newState,
      }));
    }
  }

  // Heartbeat log.
  console.log(JSON.stringify({
    ts: params.observedAt,
    event: "tick-alt-strategy",
    strategyType: config.strategyType,
    symbol: activeSymbol,
    lastPrice,
    fundingRateBps,
    spreadBps,
    decisionReason,
    entryAction,
    exitRequested,
    position: stateRef.get().position,
    realizedPnlUsd: stateRef.get().realizedPnlUsd,
    fundingTimeTarget: fundingTargetRef.get(),
  }));

  return { shouldContinueLoop: true };
}

/**
 * Basis-arbitrage tick: spot + perp two-leg market-neutral spread.
 *
 * Safety invariant for v1: if leg-1 fills and leg-2 fails, we IMMEDIATELY
 * submit a compensating close on leg-1 (best-effort, market reduceOnly on
 * perp / market opposite on spot) so we never end up with naked directional
 * exposure. The compensation attempt is logged + alerted; if it ALSO fails,
 * a critical alert is emitted and the position is NOT recorded in trader
 * state (the operator must reconcile manually).
 *
 * PnL is approximated as the sum of the per-leg paper PnL plus an
 * approximate funding accrual: `notional × |fundingRate| × holdMs / 8h`
 * (positive sign in our favor, since we're always on the receiving side of
 * funding when basis > 0 and entering opposite directions).
 */
async function runBasisArbTick(params: {
  alerter: WebhookAlerter;
  client: ReturnType<typeof createBybitClient>;
  config: TraderConfig;
  getInstrument: (symbol: string) => Promise<InstrumentInfo>;
  observedAt: string;
  basisPositionRef: MutableRef<BasisPosition | null>;
  basisEntryPerpPriceRef: MutableRef<number | null>;
  basisEntrySpotPriceRef: MutableRef<number | null>;
  basisEntryQtyRef: MutableRef<number | null>;
  basisFundingRateAtEntryRef: MutableRef<number | null>;
  positionLedger: ReturnType<typeof createPositionLedger>;
  stateRef: MutableRef<TraderState>;
  openPositionSymbolRef: MutableRef<string | null>;
  toPersistedTraderSnapshot: (p: { openPositionSymbol: string | null; state: TraderState }) => PersistedTraderSnapshot;
}): Promise<{ shouldContinueLoop: boolean }> {
  const { config, client, stateRef, openPositionSymbolRef, basisPositionRef } = params;
  const symbol = config.symbol;

  let instrument: InstrumentInfo;
  try {
    instrument = await params.getInstrument(symbol);
  } catch (error) {
    console.log(JSON.stringify({
      ts: params.observedAt,
      strategyType: "basis-arb",
      symbol,
      event: "instrument-unavailable",
      error: error instanceof Error ? error.message : String(error),
    }));
    return { shouldContinueLoop: true };
  }

  // Fetch both tickers.
  let perpTicker;
  let spotTicker;
  try {
    perpTicker = await client.getTicker({ category: "linear", symbol });
  } catch (error) {
    console.log(JSON.stringify({
      ts: params.observedAt,
      strategyType: "basis-arb",
      symbol,
      event: "perp-ticker-unavailable",
      error: error instanceof Error ? error.message : String(error),
    }));
    return { shouldContinueLoop: true };
  }
  try {
    spotTicker = await client.getTicker({ category: "spot", symbol });
  } catch (error) {
    console.log(JSON.stringify({
      ts: params.observedAt,
      strategyType: "basis-arb",
      symbol,
      event: "spot-ticker-unavailable",
      error: error instanceof Error ? error.message : String(error),
    }));
    return { shouldContinueLoop: true };
  }

  const perpPrice = Number(perpTicker.lastPrice);
  const spotPrice = Number(spotTicker.lastPrice);
  const fundingRateBps = Number(perpTicker.fundingRate) * 10_000;

  if (!Number.isFinite(perpPrice) || perpPrice <= 0 || !Number.isFinite(spotPrice) || spotPrice <= 0) {
    console.log(JSON.stringify({
      ts: params.observedAt,
      strategyType: "basis-arb",
      symbol,
      event: "invalid-prices",
      perpPrice,
      spotPrice,
    }));
    return { shouldContinueLoop: true };
  }

  const decision = basisArbDecide({
    spotPrice,
    perpPrice,
    now: Date.now(),
    position: basisPositionRef.get(),
    config: {
      entryThresholdBps: config.basisArbEntryThresholdBps,
      exitThresholdBps: config.basisArbExitThresholdBps,
      maxHoldMinutes: config.basisArbMaxHoldMinutes,
    },
  });

  const currentBasisBps = computeBasisBps(spotPrice, perpPrice);

  if (decision.kind === "hold") {
    console.log(JSON.stringify({
      ts: params.observedAt,
      event: "tick-basis-arb",
      symbol,
      perpPrice,
      spotPrice,
      basisBps: currentBasisBps,
      fundingRateBps,
      decision: "hold",
      reason: decision.reason,
      position: basisPositionRef.get(),
    }));
    return { shouldContinueLoop: true };
  }

  // ── ENTRY ────────────────────────────────────────────────────────────────
  if (decision.kind === "enter") {
    const notionalUsd = config.basisArbMaxNotionalUsd;
    const qtyStep = Number(instrument.lotSizeFilter.qtyStep);
    const rawQty = notionalUsd / perpPrice;
    const normalizedQty = Math.floor(rawQty / qtyStep) * qtyStep;
    const minQty = Number(instrument.lotSizeFilter.minOrderQty);
    if (normalizedQty < minQty) {
      console.log(JSON.stringify({
        ts: params.observedAt,
        strategyType: "basis-arb",
        symbol,
        event: "qty-below-min",
        normalizedQty,
        minQty,
      }));
      return { shouldContinueLoop: true };
    }
    const qtyStr = normalizedQty.toFixed(countDecimals(instrument.lotSizeFilter.qtyStep));
    const perpOrderSide: "Buy" | "Sell" = decision.perpSide === "long" ? "Buy" : "Sell";
    const spotOrderSide: "Buy" | "Sell" = decision.spotSide === "long" ? "Buy" : "Sell";

    // Pre-entry LLM supervisor gate (basis-arb is ~3-10 trades/day; latency OK).
    {
      const approve = await maybeSupervisedApprove({
        alerter: params.alerter,
        config,
        observedAt: params.observedAt,
        context: {
          strategyType: "basis-arb",
          symbol,
          side: decision.perpSide,
          notionalUsd,
          leverage: 1,
          signalSnapshot: {
            spotPrice,
            perpPrice,
            basisBps: decision.basisBps,
            fundingRateBps,
          },
          recentTrades: 0,
          recentWinRate: 0,
          recentNetPnlUsd: 0,
          walletAvailableUsd: 0,
          openPositionsCount: basisPositionRef.get() ? 1 : 0,
          cumulativeDailyPnlUsd: stateRef.get().realizedPnlUsd,
        },
      });
      if (!approve) {
        return { shouldContinueLoop: true };
      }
    }

    if (config.paperTrading) {
      // Paper mode: simulate both fills at current mid prices.
      const now = Date.now();
      basisPositionRef.set({
        perpSide: decision.perpSide,
        spotSide: decision.spotSide,
        entryBasisBps: decision.basisBps,
        entryAt: now,
      });
      params.basisEntryPerpPriceRef.set(perpPrice);
      params.basisEntrySpotPriceRef.set(spotPrice);
      params.basisEntryQtyRef.set(normalizedQty);
      params.basisFundingRateAtEntryRef.set(fundingRateBps);
      openPositionSymbolRef.set(symbol);
      console.log(JSON.stringify({
        ts: params.observedAt,
        event: "basis-arb-enter-paper",
        symbol,
        perpSide: decision.perpSide,
        spotSide: decision.spotSide,
        qty: qtyStr,
        perpPrice,
        spotPrice,
        basisBps: decision.basisBps,
        fundingRateBps,
      }));
      return { shouldContinueLoop: true };
    }

    // ── LIVE two-leg execution ───────────────────────────────────────────
    // Order matters: place perp first (faster, deterministic) then spot.
    // If spot fails, we close perp immediately to avoid naked exposure.
    const perpReq: CreateOrderRequest = {
      category: "linear",
      symbol,
      side: perpOrderSide,
      qty: qtyStr,
      orderType: "Market",
    };
    let perpOrderId: string | undefined;
    try {
      const perpResp = await client.createOrder(perpReq);
      perpOrderId = perpResp.orderId;
    } catch (err) {
      console.log(JSON.stringify({
        ts: params.observedAt,
        event: "basis-arb-perp-leg-failed",
        symbol,
        error: err instanceof Error ? err.message : String(err),
      }));
      await params.alerter.send(
        `basis-arb perp leg failed (no exposure): symbol=${symbol} side=${perpOrderSide} qty=${qtyStr}`,
      ).catch(() => {});
      return { shouldContinueLoop: true };
    }

    // Perp filled — now spot.
    const spotReq: CreateOrderRequest = {
      category: "spot",
      symbol,
      side: spotOrderSide,
      qty: qtyStr,
      orderType: "Market",
    };
    try {
      await client.createOrder(spotReq);
    } catch (err) {
      // Spot failed → CLOSE THE PERP LEG IMMEDIATELY (naked-exposure guard).
      console.log(JSON.stringify({
        ts: params.observedAt,
        event: "basis-arb-spot-leg-failed-closing-perp",
        symbol,
        perpOrderId,
        error: err instanceof Error ? err.message : String(err),
      }));
      const compensateSide: "Buy" | "Sell" = perpOrderSide === "Buy" ? "Sell" : "Buy";
      try {
        await client.createOrder({
          category: "linear",
          symbol,
          side: compensateSide,
          qty: qtyStr,
          orderType: "Market",
          reduceOnly: true,
        });
        await params.alerter.send(
          `basis-arb: spot leg failed, perp compensated — symbol=${symbol} closed perp leg (qty=${qtyStr}) to avoid naked exposure`,
        ).catch(() => {});
      } catch (compErr) {
        // CRITICAL: naked perp exposure. Alert loudly.
        await params.alerter.send(
          `CRITICAL: basis-arb naked exposure — manual reconcile required: symbol=${symbol} perpOrderId=${perpOrderId} qty=${qtyStr} compensateErr=${
            compErr instanceof Error ? compErr.message : String(compErr)
          }`,
        ).catch(() => {});
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          event: "basis-arb-naked-exposure",
          symbol,
          perpOrderId,
          qty: qtyStr,
        }));
      }
      return { shouldContinueLoop: true };
    }

    // Both legs filled.
    const now = Date.now();
    basisPositionRef.set({
      perpSide: decision.perpSide,
      spotSide: decision.spotSide,
      entryBasisBps: decision.basisBps,
      entryAt: now,
    });
    params.basisEntryPerpPriceRef.set(perpPrice);
    params.basisEntrySpotPriceRef.set(spotPrice);
    params.basisEntryQtyRef.set(normalizedQty);
    params.basisFundingRateAtEntryRef.set(fundingRateBps);
    openPositionSymbolRef.set(symbol);
    console.log(JSON.stringify({
      ts: params.observedAt,
      event: "basis-arb-enter-live",
      symbol,
      perpSide: decision.perpSide,
      spotSide: decision.spotSide,
      qty: qtyStr,
      perpPrice,
      spotPrice,
      basisBps: decision.basisBps,
      fundingRateBps,
    }));
    return { shouldContinueLoop: true };
  }

  // ── EXIT ─────────────────────────────────────────────────────────────────
  const pos = basisPositionRef.get();
  if (!pos) return { shouldContinueLoop: true };

  const entryQty = params.basisEntryQtyRef.get() ?? 0;
  const entryPerp = params.basisEntryPerpPriceRef.get() ?? perpPrice;
  const entrySpot = params.basisEntrySpotPriceRef.get() ?? spotPrice;
  const entryFundingBps = params.basisFundingRateAtEntryRef.get() ?? 0;
  const qtyStr = entryQty.toFixed(countDecimals(instrument.lotSizeFilter.qtyStep));

  // Per-leg PnL (per unit × qty). Long leg profits when price rises; short profits when it falls.
  const perpLegPnl = (pos.perpSide === "long" ? perpPrice - entryPerp : entryPerp - perpPrice) * entryQty;
  const spotLegPnl = (pos.spotSide === "long" ? spotPrice - entrySpot : entrySpot - spotPrice) * entryQty;
  // Funding approximation: notional × |fundingBps/10000| × holdMs / (8h ms).
  const notional = entryQty * entryPerp;
  const holdMs = Date.now() - pos.entryAt;
  const fundingApprox = notional * (Math.abs(entryFundingBps) / 10_000) * (holdMs / 28_800_000);
  // Fees (round-trip configured): charge once per leg.
  const feeRoundTripBps = config.feeRoundTripBps;
  const feePerLeg = notional * (feeRoundTripBps / 10_000);
  const netPnl = perpLegPnl + spotLegPnl + fundingApprox - 2 * feePerLeg;

  if (!config.paperTrading) {
    // Close both legs (best-effort; both as market). If either fails we log + alert
    // but still record the state-side close to avoid runaway tracking.
    const perpCloseSide: "Buy" | "Sell" = pos.perpSide === "long" ? "Sell" : "Buy";
    const spotCloseSide: "Buy" | "Sell" = pos.spotSide === "long" ? "Sell" : "Buy";
    let perpClosed = false;
    let spotClosed = false;
    try {
      await client.createOrder({
        category: "linear",
        symbol,
        side: perpCloseSide,
        qty: qtyStr,
        orderType: "Market",
        reduceOnly: true,
      });
      perpClosed = true;
    } catch (err) {
      console.log(JSON.stringify({
        ts: params.observedAt,
        event: "basis-arb-perp-exit-failed",
        symbol,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
    try {
      await client.createOrder({
        category: "spot",
        symbol,
        side: spotCloseSide,
        qty: qtyStr,
        orderType: "Market",
      });
      spotClosed = true;
    } catch (err) {
      console.log(JSON.stringify({
        ts: params.observedAt,
        event: "basis-arb-spot-exit-failed",
        symbol,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
    if (!perpClosed || !spotClosed) {
      await params.alerter.send(
        `basis-arb exit incomplete — manual reconcile: symbol=${symbol} perpClosed=${perpClosed} spotClosed=${spotClosed} qty=${qtyStr}`,
      ).catch(() => {});
    }
  }

  // Update state and record ledger entry.
  const previousState = stateRef.get();
  const nextState: TraderState = {
    ...previousState,
    realizedPnlUsd: previousState.realizedPnlUsd + netPnl,
    lastTradeAt: Date.now(),
    position: null,
  };
  stateRef.set(nextState);
  basisPositionRef.set(null);
  params.basisEntryPerpPriceRef.set(null);
  params.basisEntrySpotPriceRef.set(null);
  params.basisEntryQtyRef.set(null);
  params.basisFundingRateAtEntryRef.set(null);
  openPositionSymbolRef.set(null);

  // Build a synthetic ledger entry (basis-arb has no SL/TP — set to 0).
  const ledgerEntry: ClosedPositionLedgerEntry = {
    closedAt: new Date().toISOString(),
    cumulativeRealizedPnlUsd: nextState.realizedPnlUsd,
    entryPrice: entryPerp,
    exitPrice: perpPrice,
    exitReason: decision.reason,
    leverage: 1,
    notionalUsd: notional,
    openedAt: new Date(pos.entryAt).toISOString(),
    quantity: entryQty,
    realizedPnlUsd: netPnl,
    grossPnlUsd: perpLegPnl + spotLegPnl + fundingApprox,
    feeUsd: 2 * feePerLeg,
    championIdAtEntry: null,
    strategyType: "basis-arb",
    basisEntryBps: pos.entryBasisBps,
    basisExitBps: currentBasisBps,
    side: pos.perpSide,
    stopLossPrice: 0,
    symbol,
    takeProfitPrice: 0,
  };
  await params.positionLedger.appendClosedPosition(ledgerEntry);
  await params.positionLedger.syncSnapshot(params.toPersistedTraderSnapshot({
    openPositionSymbol: null,
    state: nextState,
  }));

  console.log(JSON.stringify({
    ts: params.observedAt,
    event: "basis-arb-exit",
    symbol,
    reason: decision.reason,
    entryBasisBps: pos.entryBasisBps,
    exitBasisBps: currentBasisBps,
    perpLegPnl,
    spotLegPnl,
    fundingApprox,
    feeUsd: 2 * feePerLeg,
    netPnl,
  }));

  return { shouldContinueLoop: true };
}

/**
 * Build a snapshot of market context for the LLM-managed strategy. Cheap
 * approximation (single BTC ticker + funding) — kept lightweight to fit the
 * per-tick budget. Errors surface as a default `LlmManagedMarketContext`
 * with zeroed fields and an observedAt timestamp.
 */
async function collectLlmMarketContext(
  client: ReturnType<typeof createBybitClient>,
  observedAt: string,
): Promise<LlmManagedMarketContext> {
  const ctx: LlmManagedMarketContext = {
    observedAt,
    btcPrice: 0,
    btcTrendBps4h: 0,
    btcRealizedVol1h: 0,
    avgFundingRateBps: 0,
    spotPerpBasisBps: 0,
    topRankedSetups: [],
  };
  try {
    const t = await client.getTicker({ category: "linear", symbol: "BTCUSDT" });
    const last = Number(t.lastPrice);
    const prev1h = Number(t.prevPrice1h);
    const prev24h = Number(t.prevPrice24h);
    if (Number.isFinite(last) && last > 0) ctx.btcPrice = last;
    if (Number.isFinite(prev24h) && prev24h > 0) {
      ctx.btcTrendBps4h = ((last - prev24h) / prev24h) * 10_000 / 6; // approx 4h slice of 24h
    }
    if (Number.isFinite(prev1h) && prev1h > 0) {
      ctx.btcRealizedVol1h = Math.abs((last - prev1h) / prev1h) * 100;
    }
    const fr = Number(t.fundingRate);
    if (Number.isFinite(fr)) ctx.avgFundingRateBps = fr * 10_000;
  } catch {
    // Swallow — caller falls back to defaults.
  }
  // Spot-perp basis (BTC).
  try {
    const spot = await client.getTicker({ category: "spot", symbol: "BTCUSDT" });
    const spotLast = Number(spot.lastPrice);
    if (Number.isFinite(spotLast) && spotLast > 0 && ctx.btcPrice > 0) {
      ctx.spotPerpBasisBps = ((ctx.btcPrice - spotLast) / spotLast) * 10_000;
    }
  } catch { /* ignore */ }
  // Top ranked setups from scan-latest.json artifact.
  try {
    const path = resolveProjectPath("apps/trader/data/scan-latest.json");
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as {
      candidates?: Array<{ symbol: string; score: number; netEdgeBps: number; action: string }>;
      setups?: Array<{ symbol: string; score: number; netEdgeBps: number; action: string }>;
    };
    const list = parsed.candidates ?? parsed.setups ?? [];
    ctx.topRankedSetups = list.slice(0, 5).map((s) => ({
      symbol: s.symbol,
      score: s.score,
      netEdgeBps: s.netEdgeBps,
      action: s.action,
    }));
  } catch { /* ignore */ }
  return ctx;
}

/**
 * Execute a single management action against the current llm-managed position.
 * Mutates the supplied refs in place. Persists a ledger entry on every close
 * (full or partial). Caller MUST have already pushed the decision into
 * `position.decisionsHistory` if applicable.
 */
async function executeLlmManagedAction(args: {
  alerter: WebhookAlerter;
  client: ReturnType<typeof createBybitClient>;
  config: TraderConfig;
  decision: LlmManageDecision;
  observedAt: string;
  positionRef: MutableRef<LlmManagedPosition | null>;
  openPositionSymbolRef: MutableRef<string | null>;
  stateRef: MutableRef<TraderState>;
  currentPrice: number;
  positionLedger: ReturnType<typeof createPositionLedger>;
  toPersistedTraderSnapshot: (p: { openPositionSymbol: string | null; state: TraderState }) => PersistedTraderSnapshot;
  setLastCutLossAt: (at: number) => void;
}): Promise<void> {
  const {
    alerter, client, config, decision, observedAt, positionRef,
    openPositionSymbolRef, stateRef, currentPrice, positionLedger,
    toPersistedTraderSnapshot, setLastCutLossAt,
  } = args;
  const pos = positionRef.get();
  if (!pos) return;

  const isFullClose = decision.action === "tp-full" || decision.action === "cut-loss";
  const partialFraction =
    decision.action === "tp-partial" || decision.action === "scale-out"
      ? Math.max(0.1, Math.min(0.9, decision.params?.tpPartialFraction ?? 0.5))
      : null;

  // ── HOLD ────────────────────────────────────────────────────────────────
  if (decision.action === "hold") {
    return;
  }

  // ── Full or partial close on the primary leg ───────────────────────────
  if (isFullClose || partialFraction !== null) {
    const closeQty = partialFraction !== null ? pos.qty * partialFraction : pos.qty;
    const closeSide: "Buy" | "Sell" = pos.side === "long" ? "Sell" : "Buy";
    const closeNotional = closeQty * currentPrice;

    if (!config.paperTrading) {
      try {
        await client.createOrder({
          category: "linear",
          symbol: pos.symbol,
          side: closeSide,
          qty: closeQty.toString(),
          orderType: "Market",
          reduceOnly: true,
        });
      } catch (err) {
        console.log(JSON.stringify({
          ts: observedAt,
          event: "llm-managed-close-failed",
          symbol: pos.symbol,
          action: decision.action,
          error: err instanceof Error ? err.message : String(err),
        }));
        await alerter.send(
          `llm-managed close failed: symbol=${pos.symbol} action=${decision.action}`,
        ).catch(() => {});
        return;
      }
    }

    // Realize PnL on the closed slice.
    const sliceSign = pos.side === "long" ? 1 : -1;
    const grossPnl = sliceSign * (currentPrice - pos.entryPrice) * closeQty;
    const feePerLeg = closeNotional * (config.feeRoundTripBps / 10_000) / 2;
    const netPnl = grossPnl - 2 * feePerLeg;

    const previousState = stateRef.get();
    const nextState: TraderState = {
      ...previousState,
      realizedPnlUsd: previousState.realizedPnlUsd + netPnl,
      lastTradeAt: Date.now(),
      position: null,
    };
    stateRef.set(nextState);

    if (isFullClose) {
      positionRef.set(null);
      openPositionSymbolRef.set(null);
      if (decision.action === "cut-loss") {
        setLastCutLossAt(Date.now());
      }
    } else {
      // Partial: shrink qty + notional pro-rata.
      const remainingQty = pos.qty - closeQty;
      const remainingNotional = pos.notionalUsd * (remainingQty / pos.qty);
      positionRef.set({
        ...pos,
        qty: remainingQty,
        notionalUsd: remainingNotional,
      });
    }

    const ledgerEntry: ClosedPositionLedgerEntry = {
      closedAt: new Date().toISOString(),
      cumulativeRealizedPnlUsd: nextState.realizedPnlUsd,
      entryPrice: pos.entryPrice,
      exitPrice: currentPrice,
      exitReason: decision.reasoning,
      leverage: pos.leverage,
      notionalUsd: closeNotional,
      openedAt: new Date(pos.openedAt).toISOString(),
      quantity: closeQty,
      realizedPnlUsd: netPnl,
      grossPnlUsd: grossPnl,
      feeUsd: 2 * feePerLeg,
      championIdAtEntry: null,
      strategyType: "llm-managed",
      llmManagedAction: decision.action,
      llmManagedReasoning: decision.reasoning,
      side: pos.side,
      stopLossPrice: 0,
      symbol: pos.symbol,
      takeProfitPrice: 0,
    };
    await positionLedger.appendClosedPosition(ledgerEntry);
    await positionLedger.syncSnapshot(toPersistedTraderSnapshot({
      openPositionSymbol: positionRef.get() ? pos.symbol : null,
      state: nextState,
    }));

    console.log(JSON.stringify({
      ts: observedAt,
      event: "llm-managed-close",
      action: decision.action,
      symbol: pos.symbol,
      closeQty,
      currentPrice,
      grossPnl,
      feeUsd: 2 * feePerLeg,
      netPnl,
      reasoning: decision.reasoning,
    }));
    return;
  }

  // ── open-hedge ─────────────────────────────────────────────────────────
  if (decision.action === "open-hedge") {
    if (pos.hedge !== null) {
      console.log(JSON.stringify({
        ts: observedAt,
        event: "llm-managed-hedge-rejected",
        reason: "hedge-already-open",
      }));
      return;
    }
    const hedgeSymbol = decision.params?.hedgeSymbol ?? pos.symbol;
    if (!config.llmManagedAllowedSymbols.includes(hedgeSymbol)) {
      console.log(JSON.stringify({
        ts: observedAt,
        event: "llm-managed-hedge-rejected",
        reason: "hedge-symbol-not-allowed",
        hedgeSymbol,
      }));
      return;
    }
    const hedgeNotional = Math.min(pos.notionalUsd, config.llmManagedHedgeMaxNotionalUsd);
    const hedgeSide: "long" | "short" = pos.side === "long" ? "short" : "long";
    // Use current price as hedge entry approximation; if the symbol differs we'd
    // need its own ticker — fetch best-effort.
    let hedgePrice = currentPrice;
    if (hedgeSymbol !== pos.symbol) {
      try {
        const t = await client.getTicker({ category: "linear", symbol: hedgeSymbol });
        const p = Number(t.lastPrice);
        if (Number.isFinite(p) && p > 0) hedgePrice = p;
      } catch {
        console.log(JSON.stringify({
          ts: observedAt,
          event: "llm-managed-hedge-price-fallback",
          hedgeSymbol,
        }));
      }
    }
    const hedgeQty = hedgePrice > 0 ? hedgeNotional / hedgePrice : 0;
    if (hedgeQty <= 0) {
      console.log(JSON.stringify({
        ts: observedAt,
        event: "llm-managed-hedge-rejected",
        reason: "invalid-hedge-qty",
        hedgePrice, hedgeNotional,
      }));
      return;
    }

    if (!config.paperTrading) {
      try {
        await client.createOrder({
          category: "linear",
          symbol: hedgeSymbol,
          side: hedgeSide === "long" ? "Buy" : "Sell",
          qty: hedgeQty.toString(),
          orderType: "Market",
        });
      } catch (err) {
        console.log(JSON.stringify({
          ts: observedAt,
          event: "llm-managed-hedge-open-failed",
          error: err instanceof Error ? err.message : String(err),
        }));
        await alerter.send(`llm-managed hedge open failed: ${hedgeSymbol}`).catch(() => {});
        return;
      }
    }

    positionRef.set({
      ...pos,
      hedge: {
        symbol: hedgeSymbol,
        side: hedgeSide,
        entryPrice: hedgePrice,
        qty: hedgeQty,
        notionalUsd: hedgeNotional,
        openedAt: Date.now(),
      },
    });
    console.log(JSON.stringify({
      ts: observedAt,
      event: "llm-managed-hedge-opened",
      hedgeSymbol, hedgeSide, hedgeQty, hedgePrice, hedgeNotional,
    }));
    return;
  }

  // ── close-hedge ────────────────────────────────────────────────────────
  if (decision.action === "close-hedge") {
    const hedge = pos.hedge;
    if (!hedge) {
      console.log(JSON.stringify({
        ts: observedAt,
        event: "llm-managed-close-hedge-noop",
        reason: "no-active-hedge",
      }));
      return;
    }
    // Fetch current hedge price.
    let hedgeCurrentPrice = hedge.entryPrice;
    try {
      const t = await client.getTicker({ category: "linear", symbol: hedge.symbol });
      const p = Number(t.lastPrice);
      if (Number.isFinite(p) && p > 0) hedgeCurrentPrice = p;
    } catch {
      // Use entry price as fallback.
    }
    if (!config.paperTrading) {
      try {
        await client.createOrder({
          category: "linear",
          symbol: hedge.symbol,
          side: hedge.side === "long" ? "Sell" : "Buy",
          qty: hedge.qty.toString(),
          orderType: "Market",
          reduceOnly: true,
        });
      } catch (err) {
        console.log(JSON.stringify({
          ts: observedAt,
          event: "llm-managed-hedge-close-failed",
          error: err instanceof Error ? err.message : String(err),
        }));
        await alerter.send(`llm-managed hedge close failed: ${hedge.symbol}`).catch(() => {});
        return;
      }
    }
    const hSign = hedge.side === "long" ? 1 : -1;
    const hedgePnl = hSign * (hedgeCurrentPrice - hedge.entryPrice) * hedge.qty;
    const hedgeFee = hedge.notionalUsd * (config.feeRoundTripBps / 10_000);
    const hedgeNet = hedgePnl - hedgeFee;
    const previousState = stateRef.get();
    const nextState: TraderState = {
      ...previousState,
      realizedPnlUsd: previousState.realizedPnlUsd + hedgeNet,
      lastTradeAt: Date.now(),
    };
    stateRef.set(nextState);
    positionRef.set({ ...pos, hedge: null });
    console.log(JSON.stringify({
      ts: observedAt,
      event: "llm-managed-hedge-closed",
      hedgeSymbol: hedge.symbol,
      hedgePnl,
      hedgeFee,
      hedgeNet,
    }));
    return;
  }

  // ── scale-in ───────────────────────────────────────────────────────────
  if (decision.action === "scale-in") {
    const addNotional = decision.params?.scaleNotionalUsd ?? 0;
    if (addNotional <= 0) {
      console.log(JSON.stringify({
        ts: observedAt,
        event: "llm-managed-scale-in-rejected",
        reason: "non-positive-notional",
      }));
      return;
    }
    const cap = config.llmManagedMaxNotionalUsd * 2;
    const totalAfter = pos.notionalUsd + addNotional;
    if (totalAfter > cap) {
      console.log(JSON.stringify({
        ts: observedAt,
        event: "llm-managed-scale-in-rejected",
        reason: "notional-cap",
        totalAfter, cap,
      }));
      return;
    }
    const addQty = currentPrice > 0 ? addNotional / currentPrice : 0;
    if (addQty <= 0) return;
    if (!config.paperTrading) {
      try {
        await client.createOrder({
          category: "linear",
          symbol: pos.symbol,
          side: pos.side === "long" ? "Buy" : "Sell",
          qty: addQty.toString(),
          orderType: "Market",
        });
      } catch (err) {
        console.log(JSON.stringify({
          ts: observedAt,
          event: "llm-managed-scale-in-failed",
          error: err instanceof Error ? err.message : String(err),
        }));
        await alerter.send(`llm-managed scale-in failed: ${pos.symbol}`).catch(() => {});
        return;
      }
    }
    // New weighted-average entry price.
    const totalQty = pos.qty + addQty;
    const newEntryPrice = ((pos.entryPrice * pos.qty) + (currentPrice * addQty)) / totalQty;
    positionRef.set({
      ...pos,
      qty: totalQty,
      notionalUsd: totalAfter,
      entryPrice: newEntryPrice,
    });
    console.log(JSON.stringify({
      ts: observedAt,
      event: "llm-managed-scale-in",
      addNotional, addQty, newEntryPrice, totalQty, totalAfter,
    }));
    return;
  }
}

/**
 * llm-managed tick: fully autonomous LLM-driven trader.  Two modes:
 *   - OPEN-DECISION (no position): periodically asks the LLM whether to open.
 *   - MANAGE (position open): periodically asks the LLM how to manage. Hard
 *     safety overrides (cut-loss / tp-full) bypass the LLM entirely.
 *
 * See `apps/trader/src/strategies/llm-managed.ts` for the safety + cost model.
 */
async function runLlmManagedTick(params: {
  alerter: WebhookAlerter;
  client: ReturnType<typeof createBybitClient>;
  config: TraderConfig;
  observedAt: string;
  positionRef: MutableRef<LlmManagedPosition | null>;
  lastOpenDecisionAtRef: MutableRef<number>;
  lastManageDecisionAtRef: MutableRef<number>;
  lastCutLossAtRef: MutableRef<number>;
  openPositionSymbolRef: MutableRef<string | null>;
  positionLedger: ReturnType<typeof createPositionLedger>;
  stateRef: MutableRef<TraderState>;
  toPersistedTraderSnapshot: (p: { openPositionSymbol: string | null; state: TraderState }) => PersistedTraderSnapshot;
}): Promise<{ shouldContinueLoop: boolean }> {
  const {
    alerter, client, config, observedAt,
    positionRef, lastOpenDecisionAtRef, lastManageDecisionAtRef, lastCutLossAtRef,
    openPositionSymbolRef, positionLedger, stateRef, toPersistedTraderSnapshot,
  } = params;
  const now = Date.now();
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";

  const market = await collectLlmMarketContext(client, observedAt);
  const pos = positionRef.get();

  // ─────────────────────────── OPEN-DECISION MODE ──────────────────────────
  if (pos === null) {
    if (now < lastCutLossAtRef.get() + config.llmManagedPostCutLossCooldownMs) {
      console.log(JSON.stringify({
        ts: observedAt,
        event: "llm-managed-cooldown",
        msRemaining: lastCutLossAtRef.get() + config.llmManagedPostCutLossCooldownMs - now,
      }));
      return { shouldContinueLoop: true };
    }
    if (now < lastOpenDecisionAtRef.get() + config.llmManagedOpenReviewIntervalSec * 1000) {
      // Throttled — no log spam.
      return { shouldContinueLoop: true };
    }
    lastOpenDecisionAtRef.set(now);

    // Wallet available — best-effort fetch via the shared sizing helper.
    let walletAvailableUsd = 0;
    try {
      const sizing = resolveWalletOrderUsd({
        accountType: config.walletAccountType,
        autoSizeFromWallet: true,
        fallbackOrderUsd: 0,
        maxOrderUsdCap: null,
        walletBalanceResponse: await client.getWalletBalance(config.walletAccountType),
        walletCoin: config.walletCoin,
        walletFraction: 1,
      });
      walletAvailableUsd = sizing.walletAvailableUsd ?? 0;
    } catch {
      // Use 0 fallback.
    }

    const decision = await llmManagedGetOpenDecision({
      market,
      walletAvailableUsd,
      recentTrades: 0,
      recentWinRate: 0,
      recentNetPnlUsd: stateRef.get().realizedPnlUsd,
      allowedSymbols: config.llmManagedAllowedSymbols,
      maxNotionalUsd: config.llmManagedMaxNotionalUsd,
      maxLeverage: config.llmManagedMaxLeverage,
      apiKey,
      model: config.llmManagedModel,
      timeoutMs: config.llmManagedTimeoutMs,
    });

    console.log(JSON.stringify({
      ts: observedAt,
      event: "llm-managed-open-decision",
      action: decision.action,
      reasoning: decision.reasoning,
      symbol: decision.symbol,
      side: decision.side,
      notionalUsd: decision.notionalUsd,
      leverage: decision.leverage,
      targetPnlUsd: decision.targetPnlUsd,
      maxLossUsd: decision.maxLossUsd,
    }));

    if (decision.action !== "open") return { shouldContinueLoop: true };

    // ── Validate + clamp the LLM's open request ────────────────────────────
    const symbol = decision.symbol!;
    if (!config.llmManagedAllowedSymbols.includes(symbol)) {
      console.log(JSON.stringify({
        ts: observedAt,
        event: "llm-managed-open-rejected",
        reason: "symbol-not-allowed",
        symbol,
      }));
      await alerter.send(`llm-managed rejected: symbol-not-allowed (${symbol})`).catch(() => {});
      return { shouldContinueLoop: true };
    }
    const clampedNotional = Math.min(
      decision.notionalUsd ?? config.llmManagedMaxNotionalUsd,
      config.llmManagedMaxNotionalUsd,
    );
    const clampedLeverage = Math.max(1, Math.min(
      decision.leverage ?? config.llmManagedMaxLeverage,
      config.llmManagedMaxLeverage,
    ));
    if (clampedNotional <= 0) {
      console.log(JSON.stringify({
        ts: observedAt,
        event: "llm-managed-open-rejected",
        reason: "non-positive-notional",
      }));
      return { shouldContinueLoop: true };
    }

    // Fetch entry price.
    let entryPrice = 0;
    try {
      const t = await client.getTicker({ category: "linear", symbol });
      entryPrice = Number(t.lastPrice);
    } catch (err) {
      console.log(JSON.stringify({
        ts: observedAt,
        event: "llm-managed-open-rejected",
        reason: "ticker-unavailable",
        symbol,
        error: err instanceof Error ? err.message : String(err),
      }));
      return { shouldContinueLoop: true };
    }
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return { shouldContinueLoop: true };
    const qty = clampedNotional / entryPrice;

    // Set leverage (live only).
    if (!config.paperTrading) {
      try {
        await client.setLeverage({
          category: "linear",
          symbol,
          buyLeverage: clampedLeverage.toString(),
          sellLeverage: clampedLeverage.toString(),
        });
      } catch (err) {
        console.log(JSON.stringify({
          ts: observedAt,
          event: "llm-managed-set-leverage-failed",
          symbol,
          error: err instanceof Error ? err.message : String(err),
        }));
        // Continue anyway — Bybit may have already set this leverage.
      }
      try {
        await client.createOrder({
          category: "linear",
          symbol,
          side: decision.side === "long" ? "Buy" : "Sell",
          qty: qty.toString(),
          orderType: "Market",
        });
      } catch (err) {
        console.log(JSON.stringify({
          ts: observedAt,
          event: "llm-managed-open-order-failed",
          symbol,
          error: err instanceof Error ? err.message : String(err),
        }));
        await alerter.send(`llm-managed open order failed: ${symbol}`).catch(() => {});
        return { shouldContinueLoop: true };
      }
    }

    const newPos: LlmManagedPosition = {
      symbol,
      side: decision.side!,
      entryPrice,
      qty,
      notionalUsd: clampedNotional,
      leverage: clampedLeverage,
      openedAt: now,
      targetPnlUsd: decision.targetPnlUsd ?? 0,
      maxLossUsd: decision.maxLossUsd ?? config.llmManagedMaxAbsoluteLossUsd,
      entryReasoning: decision.reasoning,
      mfeUsd: 0,
      maeUsd: 0,
      decisionsHistory: [],
      hedge: null,
    };
    positionRef.set(newPos);
    openPositionSymbolRef.set(symbol);
    console.log(JSON.stringify({
      ts: observedAt,
      event: "llm-managed-opened",
      symbol, side: newPos.side, qty, entryPrice,
      notionalUsd: clampedNotional, leverage: clampedLeverage,
      targetPnlUsd: newPos.targetPnlUsd, maxLossUsd: newPos.maxLossUsd,
    }));
    return { shouldContinueLoop: true };
  }

  // ─────────────────────────── MANAGE MODE ─────────────────────────────────
  // Refresh price + excursions every tick.
  let currentPrice = pos.entryPrice;
  try {
    const t = await client.getTicker({ category: "linear", symbol: pos.symbol });
    const p = Number(t.lastPrice);
    if (Number.isFinite(p) && p > 0) currentPrice = p;
  } catch (err) {
    console.log(JSON.stringify({
      ts: observedAt,
      event: "llm-managed-ticker-unavailable",
      symbol: pos.symbol,
      error: err instanceof Error ? err.message : String(err),
    }));
    return { shouldContinueLoop: true };
  }

  const currentPnlUsd = llmManagedComputePnlUsd(pos, currentPrice);
  const currentPnlBps = llmManagedComputePnlBps(pos, currentPrice);
  const minutesHeld = (now - pos.openedAt) / 60_000;
  const updatedPos = llmManagedUpdateExcursions(pos, currentPnlUsd);
  if (updatedPos !== pos) positionRef.set(updatedPos);

  // Hard safety overrides BEFORE any LLM call.
  const override = llmManagedCheckSafetyOverride({
    position: updatedPos,
    currentPnlUsd,
    minutesHeld,
    maxAbsoluteLossUsd: config.llmManagedMaxAbsoluteLossUsd,
    maxHoldHours: config.llmManagedMaxHoldHours,
  });
  if (override) {
    console.log(JSON.stringify({
      ts: observedAt,
      event: "llm-managed-safety-trigger",
      rule: override.reasoning,
      action: override.action,
      currentPnlUsd, minutesHeld,
    }));
    await alerter.send(
      `llm-managed safety: ${override.reasoning} → ${override.action} (pnl=${currentPnlUsd.toFixed(2)})`,
    ).catch(() => {});
    // Push to history so the operator can audit forced decisions too.
    const nextPos = positionRef.get();
    if (nextPos) {
      positionRef.set({
        ...nextPos,
        decisionsHistory: [
          ...nextPos.decisionsHistory,
          { at: now, action: override.action, reasoning: override.reasoning },
        ],
      });
    }
    await executeLlmManagedAction({
      alerter, client, config, decision: override, observedAt,
      positionRef, openPositionSymbolRef, stateRef, currentPrice,
      positionLedger, toPersistedTraderSnapshot,
      setLastCutLossAt: (at) => lastCutLossAtRef.set(at),
    });
    return { shouldContinueLoop: true };
  }

  // Throttle manage reviews.
  if (now < lastManageDecisionAtRef.get() + config.llmManagedManageReviewIntervalSec * 1000) {
    return { shouldContinueLoop: true };
  }
  lastManageDecisionAtRef.set(now);

  const manage = await llmManagedGetManageDecision({
    position: updatedPos,
    currentPrice,
    currentPnlUsd,
    currentPnlBps,
    minutesHeld,
    market,
    apiKey,
    model: config.llmManagedModel,
    timeoutMs: config.llmManagedTimeoutMs,
  });

  console.log(JSON.stringify({
    ts: observedAt,
    event: "llm-managed-decision",
    action: manage.action,
    reasoning: manage.reasoning,
    params: manage.params,
    currentPrice, currentPnlUsd, currentPnlBps, minutesHeld,
  }));

  // Record decision in history first (even on no-op holds).
  const posForHistory = positionRef.get();
  if (posForHistory) {
    positionRef.set({
      ...posForHistory,
      decisionsHistory: [
        ...posForHistory.decisionsHistory,
        { at: now, action: manage.action, reasoning: manage.reasoning },
      ],
    });
  }

  await executeLlmManagedAction({
    alerter, client, config, decision: manage, observedAt,
    positionRef, openPositionSymbolRef, stateRef, currentPrice,
    positionLedger, toPersistedTraderSnapshot,
    setLastCutLossAt: (at) => lastCutLossAtRef.set(at),
  });
  return { shouldContinueLoop: true };
}

/**
 * Calendar-spread tick: two-leg convergence trade between a linear perpetual
 * and a dated linear quarterly futures contract on Bybit. Both legs are
 * `category: "linear"` but with different symbols.
 *
 * Safety invariant matches basis-arb: perp leg goes first. If the dated leg
 * fails after the perp filled, we IMMEDIATELY submit a compensating
 * reduceOnly close on the perp. If compensation also fails, we emit a
 * CRITICAL alert and do NOT record the position in state (manual reconcile
 * required).
 *
 * Operator note: this v1 takes the dated symbol + delivery time from config.
 * The operator must populate `calendarSpread.datedSymbol` and
 * `calendarSpread.datedDeliveryAt` (Unix ms) from Bybit's listed quarterlies.
 * If either is missing, the tick is a no-op with a structured warning.
 */
async function runCalendarSpreadTick(params: {
  alerter: WebhookAlerter;
  client: ReturnType<typeof createBybitClient>;
  config: TraderConfig;
  getInstrument: (symbol: string) => Promise<InstrumentInfo>;
  observedAt: string;
  calendarPositionRef: MutableRef<CalendarPosition | null>;
  positionLedger: ReturnType<typeof createPositionLedger>;
  stateRef: MutableRef<TraderState>;
  openPositionSymbolRef: MutableRef<string | null>;
  toPersistedTraderSnapshot: (p: { openPositionSymbol: string | null; state: TraderState }) => PersistedTraderSnapshot;
}): Promise<{ shouldContinueLoop: boolean }> {
  const { config, client, stateRef, openPositionSymbolRef, calendarPositionRef } = params;
  const perpSymbol = config.calendarPerpSymbol;
  const datedSymbol = config.calendarDatedSymbol;
  const datedDeliveryAt = config.calendarDatedDeliveryAt;

  if (!datedSymbol || datedSymbol.trim() === "" || datedDeliveryAt <= 0) {
    console.warn(JSON.stringify({
      ts: params.observedAt,
      strategyType: "calendar-spread",
      event: "config-incomplete",
      message: "Operator must set calendarSpread.datedSymbol and calendarSpread.datedDeliveryAt from Bybit's listed quarterlies",
      datedSymbol,
      datedDeliveryAt,
    }));
    return { shouldContinueLoop: true };
  }

  // Per-leg instruments.
  let perpInstrument: InstrumentInfo;
  let datedInstrument: InstrumentInfo;
  try {
    perpInstrument = await params.getInstrument(perpSymbol);
    datedInstrument = await params.getInstrument(datedSymbol);
  } catch (err) {
    console.log(JSON.stringify({
      ts: params.observedAt,
      strategyType: "calendar-spread",
      event: "instrument-unavailable",
      perpSymbol,
      datedSymbol,
      error: err instanceof Error ? err.message : String(err),
    }));
    return { shouldContinueLoop: true };
  }

  // Tickers.
  let perpTicker;
  let datedTicker;
  try {
    perpTicker = await client.getTicker({ category: "linear", symbol: perpSymbol });
  } catch (err) {
    console.log(JSON.stringify({
      ts: params.observedAt,
      strategyType: "calendar-spread",
      event: "perp-ticker-unavailable",
      perpSymbol,
      error: err instanceof Error ? err.message : String(err),
    }));
    return { shouldContinueLoop: true };
  }
  try {
    datedTicker = await client.getTicker({ category: "linear", symbol: datedSymbol });
  } catch (err) {
    console.log(JSON.stringify({
      ts: params.observedAt,
      strategyType: "calendar-spread",
      event: "dated-ticker-unavailable",
      datedSymbol,
      error: err instanceof Error ? err.message : String(err),
    }));
    return { shouldContinueLoop: true };
  }

  const perpPrice = Number(perpTicker.lastPrice);
  const datedPrice = Number(datedTicker.lastPrice);
  if (!Number.isFinite(perpPrice) || perpPrice <= 0 || !Number.isFinite(datedPrice) || datedPrice <= 0) {
    console.log(JSON.stringify({
      ts: params.observedAt,
      strategyType: "calendar-spread",
      event: "invalid-prices",
      perpPrice,
      datedPrice,
    }));
    return { shouldContinueLoop: true };
  }

  const decision = calendarDecide({
    perpPrice,
    datedPrice,
    datedDeliveryAt,
    now: Date.now(),
    position: calendarPositionRef.get(),
    config: {
      entryThresholdBps: config.calendarEntryThresholdBps,
      exitThresholdBps: config.calendarExitThresholdBps,
      preSettlementCloseHours: config.calendarPreSettlementCloseHours,
    },
  });

  const currentSpreadBps = computeCalendarSpreadBps(perpPrice, datedPrice);

  if (decision.kind === "hold") {
    console.log(JSON.stringify({
      ts: params.observedAt,
      event: "tick-calendar-spread",
      perpSymbol,
      datedSymbol,
      perpPrice,
      datedPrice,
      spreadBps: currentSpreadBps,
      decision: "hold",
      reason: decision.reason,
      position: calendarPositionRef.get(),
    }));
    return { shouldContinueLoop: true };
  }

  // ── ENTRY ────────────────────────────────────────────────────────────────
  if (decision.kind === "enter") {
    const notionalPerLeg = config.calendarMaxNotionalUsdPerLeg;
    // Use perp's qtyStep for both legs (qty matched). Caller is responsible for
    // ensuring perp + dated have compatible lot sizes for the chosen underlying.
    const qtyStep = Number(perpInstrument.lotSizeFilter.qtyStep);
    const minQty = Math.max(
      Number(perpInstrument.lotSizeFilter.minOrderQty),
      Number(datedInstrument.lotSizeFilter.minOrderQty),
    );
    const rawQty = notionalPerLeg / perpPrice;
    const normalizedQty = Math.floor(rawQty / qtyStep) * qtyStep;
    if (normalizedQty < minQty) {
      console.log(JSON.stringify({
        ts: params.observedAt,
        strategyType: "calendar-spread",
        event: "qty-below-min",
        normalizedQty,
        minQty,
      }));
      return { shouldContinueLoop: true };
    }
    const qtyStr = normalizedQty.toFixed(countDecimals(perpInstrument.lotSizeFilter.qtyStep));
    const perpOrderSide: "Buy" | "Sell" = decision.perpSide === "long" ? "Buy" : "Sell";
    const datedOrderSide: "Buy" | "Sell" = decision.datedSide === "long" ? "Buy" : "Sell";

    // Pre-entry LLM supervisor gate (calendar-spread is ~1 trade/quarter; latency negligible).
    {
      const hoursToSettlement = (datedDeliveryAt - Date.now()) / 3_600_000;
      const approve = await maybeSupervisedApprove({
        alerter: params.alerter,
        config,
        observedAt: params.observedAt,
        context: {
          strategyType: "calendar-spread",
          symbol: perpSymbol,
          side: decision.perpSide,
          notionalUsd: notionalPerLeg,
          leverage: 1,
          signalSnapshot: {
            perpSymbol,
            datedSymbol,
            perpPrice,
            datedPrice,
            spreadBps: decision.spreadBps,
            hoursToSettlement,
          },
          recentTrades: 0,
          recentWinRate: 0,
          recentNetPnlUsd: 0,
          walletAvailableUsd: 0,
          openPositionsCount: calendarPositionRef.get() ? 1 : 0,
          cumulativeDailyPnlUsd: stateRef.get().realizedPnlUsd,
        },
      });
      if (!approve) {
        return { shouldContinueLoop: true };
      }
    }

    if (config.paperTrading) {
      const now = Date.now();
      calendarPositionRef.set({
        perpSide: decision.perpSide,
        datedSide: decision.datedSide,
        perpEntryPrice: perpPrice,
        datedEntryPrice: datedPrice,
        qty: normalizedQty,
        entrySpreadBps: decision.spreadBps,
        entryAt: now,
        datedDeliveryAt,
      });
      openPositionSymbolRef.set(perpSymbol);
      console.log(JSON.stringify({
        ts: params.observedAt,
        event: "calendar-spread-enter-paper",
        perpSymbol,
        datedSymbol,
        perpSide: decision.perpSide,
        datedSide: decision.datedSide,
        qty: qtyStr,
        perpPrice,
        datedPrice,
        spreadBps: decision.spreadBps,
      }));
      return { shouldContinueLoop: true };
    }

    // ── LIVE two-leg execution ───────────────────────────────────────────
    // Perp first, then dated. If dated fails, close perp immediately.
    const perpReq: CreateOrderRequest = {
      category: "linear",
      symbol: perpSymbol,
      side: perpOrderSide,
      qty: qtyStr,
      orderType: "Market",
    };
    let perpOrderId: string | undefined;
    try {
      const resp = await client.createOrder(perpReq);
      perpOrderId = resp.orderId;
    } catch (err) {
      console.log(JSON.stringify({
        ts: params.observedAt,
        event: "calendar-spread-perp-leg-failed",
        perpSymbol,
        error: err instanceof Error ? err.message : String(err),
      }));
      await params.alerter.send(
        `calendar-spread perp leg failed (no exposure): perpSymbol=${perpSymbol} side=${perpOrderSide} qty=${qtyStr}`,
      ).catch(() => {});
      return { shouldContinueLoop: true };
    }

    // Perp filled — now dated.
    const datedReq: CreateOrderRequest = {
      category: "linear",
      symbol: datedSymbol,
      side: datedOrderSide,
      qty: qtyStr,
      orderType: "Market",
    };
    try {
      await client.createOrder(datedReq);
    } catch (err) {
      // Dated failed → CLOSE THE PERP LEG IMMEDIATELY (naked-exposure guard).
      console.log(JSON.stringify({
        ts: params.observedAt,
        event: "calendar-spread-dated-leg-failed-closing-perp",
        perpSymbol,
        datedSymbol,
        perpOrderId,
        error: err instanceof Error ? err.message : String(err),
      }));
      const compensateSide: "Buy" | "Sell" = perpOrderSide === "Buy" ? "Sell" : "Buy";
      try {
        await client.createOrder({
          category: "linear",
          symbol: perpSymbol,
          side: compensateSide,
          qty: qtyStr,
          orderType: "Market",
          reduceOnly: true,
        });
        await params.alerter.send(
          `calendar-spread: dated leg failed, perp compensated — perpSymbol=${perpSymbol} closed perp leg (qty=${qtyStr}) to avoid naked exposure`,
        ).catch(() => {});
      } catch (compErr) {
        await params.alerter.send(
          `CRITICAL: calendar-spread naked exposure — manual reconcile required: perpSymbol=${perpSymbol} perpOrderId=${perpOrderId} qty=${qtyStr} compensateErr=${
            compErr instanceof Error ? compErr.message : String(compErr)
          }`,
        ).catch(() => {});
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          event: "calendar-spread-naked-exposure",
          perpSymbol,
          perpOrderId,
          qty: qtyStr,
        }));
      }
      return { shouldContinueLoop: true };
    }

    // Both legs filled.
    const now = Date.now();
    calendarPositionRef.set({
      perpSide: decision.perpSide,
      datedSide: decision.datedSide,
      perpEntryPrice: perpPrice,
      datedEntryPrice: datedPrice,
      qty: normalizedQty,
      entrySpreadBps: decision.spreadBps,
      entryAt: now,
      datedDeliveryAt,
    });
    openPositionSymbolRef.set(perpSymbol);
    console.log(JSON.stringify({
      ts: params.observedAt,
      event: "calendar-spread-enter-live",
      perpSymbol,
      datedSymbol,
      perpSide: decision.perpSide,
      datedSide: decision.datedSide,
      qty: qtyStr,
      perpPrice,
      datedPrice,
      spreadBps: decision.spreadBps,
    }));
    return { shouldContinueLoop: true };
  }

  // ── EXIT ─────────────────────────────────────────────────────────────────
  const pos = calendarPositionRef.get();
  if (!pos) return { shouldContinueLoop: true };

  const qtyStr = pos.qty.toFixed(countDecimals(perpInstrument.lotSizeFilter.qtyStep));

  // Per-leg PnL.
  const perpLegPnl = (pos.perpSide === "long" ? perpPrice - pos.perpEntryPrice : pos.perpEntryPrice - perpPrice) * pos.qty;
  const datedLegPnl = (pos.datedSide === "long" ? datedPrice - pos.datedEntryPrice : pos.datedEntryPrice - datedPrice) * pos.qty;
  const notional = pos.qty * pos.perpEntryPrice;
  const feeRoundTripBps = config.feeRoundTripBps;
  const feePerLeg = notional * (feeRoundTripBps / 10_000);
  const netPnl = perpLegPnl + datedLegPnl - 2 * feePerLeg;

  if (!config.paperTrading) {
    const perpCloseSide: "Buy" | "Sell" = pos.perpSide === "long" ? "Sell" : "Buy";
    const datedCloseSide: "Buy" | "Sell" = pos.datedSide === "long" ? "Sell" : "Buy";
    let perpClosed = false;
    let datedClosed = false;
    try {
      await client.createOrder({
        category: "linear",
        symbol: perpSymbol,
        side: perpCloseSide,
        qty: qtyStr,
        orderType: "Market",
        reduceOnly: true,
      });
      perpClosed = true;
    } catch (err) {
      console.log(JSON.stringify({
        ts: params.observedAt,
        event: "calendar-spread-perp-exit-failed",
        perpSymbol,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
    try {
      await client.createOrder({
        category: "linear",
        symbol: datedSymbol,
        side: datedCloseSide,
        qty: qtyStr,
        orderType: "Market",
        reduceOnly: true,
      });
      datedClosed = true;
    } catch (err) {
      console.log(JSON.stringify({
        ts: params.observedAt,
        event: "calendar-spread-dated-exit-failed",
        datedSymbol,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
    if (!perpClosed || !datedClosed) {
      await params.alerter.send(
        `calendar-spread exit incomplete — manual reconcile: perpSymbol=${perpSymbol} datedSymbol=${datedSymbol} perpClosed=${perpClosed} datedClosed=${datedClosed} qty=${qtyStr}`,
      ).catch(() => {});
    }
  }

  const previousState = stateRef.get();
  const nextState: TraderState = {
    ...previousState,
    realizedPnlUsd: previousState.realizedPnlUsd + netPnl,
    lastTradeAt: Date.now(),
    position: null,
  };
  stateRef.set(nextState);
  calendarPositionRef.set(null);
  openPositionSymbolRef.set(null);

  const ledgerEntry: ClosedPositionLedgerEntry = {
    closedAt: new Date().toISOString(),
    cumulativeRealizedPnlUsd: nextState.realizedPnlUsd,
    entryPrice: pos.perpEntryPrice,
    exitPrice: perpPrice,
    exitReason: decision.reason,
    leverage: 1,
    notionalUsd: notional,
    openedAt: new Date(pos.entryAt).toISOString(),
    quantity: pos.qty,
    realizedPnlUsd: netPnl,
    grossPnlUsd: perpLegPnl + datedLegPnl,
    feeUsd: 2 * feePerLeg,
    championIdAtEntry: null,
    strategyType: "calendar-spread",
    calendarDatedSymbol: datedSymbol,
    calendarEntrySpreadBps: pos.entrySpreadBps,
    calendarExitSpreadBps: currentSpreadBps,
    side: pos.perpSide,
    stopLossPrice: 0,
    symbol: perpSymbol,
    takeProfitPrice: 0,
  };
  await params.positionLedger.appendClosedPosition(ledgerEntry);
  await params.positionLedger.syncSnapshot(params.toPersistedTraderSnapshot({
    openPositionSymbol: null,
    state: nextState,
  }));

  console.log(JSON.stringify({
    ts: params.observedAt,
    event: "calendar-spread-exit",
    perpSymbol,
    datedSymbol,
    reason: decision.reason,
    entrySpreadBps: pos.entrySpreadBps,
    exitSpreadBps: currentSpreadBps,
    perpLegPnl,
    datedLegPnl,
    feeUsd: 2 * feePerLeg,
    netPnl,
  }));

  return { shouldContinueLoop: true };
}

/**
 * Pairs-trading tick: two-leg cointegration mean reversion on two linear-perp
 * symbols (e.g. BTCUSDT / ETHUSDT).
 *
 * Safety invariant matches basis-arb: if leg1 fills and leg2 fails, we
 * IMMEDIATELY submit a compensating reduceOnly close on leg1. If compensation
 * itself fails, we emit a CRITICAL alert and do NOT record the position in
 * state (manual reconcile required).
 */
async function runPairsTradingTick(params: {
  alerter: WebhookAlerter;
  client: ReturnType<typeof createBybitClient>;
  config: TraderConfig;
  getInstrument: (symbol: string) => Promise<InstrumentInfo>;
  observedAt: string;
  pairsCacheRef: MutableRef<PairsCache | null>;
  pairsPositionRef: MutableRef<PairsPosition | null>;
  positionLedger: ReturnType<typeof createPositionLedger>;
  stateRef: MutableRef<TraderState>;
  openPositionSymbolRef: MutableRef<string | null>;
  toPersistedTraderSnapshot: (p: { openPositionSymbol: string | null; state: TraderState }) => PersistedTraderSnapshot;
}): Promise<{ shouldContinueLoop: boolean }> {
  const { config, client, stateRef, openPositionSymbolRef, pairsPositionRef, pairsCacheRef } = params;
  const leg1Symbol = config.pairsLeg1Symbol;
  const leg2Symbol = config.pairsLeg2Symbol;

  // ── Refresh kline cache if stale or absent ───────────────────────────────
  const existingCache = pairsCacheRef.get();
  const cacheStale =
    existingCache === null
    || existingCache.leg1Symbol !== leg1Symbol
    || existingCache.leg2Symbol !== leg2Symbol
    || (Date.now() - existingCache.fetchedAt) >= config.pairsKlineRefreshSec * 1000;
  if (cacheStale) {
    try {
      const limit = config.pairsWindowSize + 10;
      const [leg1Klines, leg2Klines] = await Promise.all([
        client.getKlines({
          category: "linear",
          symbol: leg1Symbol,
          interval: config.pairsKlineInterval,
          limit,
        }),
        client.getKlines({
          category: "linear",
          symbol: leg2Symbol,
          interval: config.pairsKlineInterval,
          limit,
        }),
      ]);
      // Bybit returns newest-first; reverse to oldest-first and align lengths.
      const leg1Closes = leg1Klines.map((k) => Number(k.closePrice)).reverse();
      const leg2Closes = leg2Klines.map((k) => Number(k.closePrice)).reverse();
      const aligned = Math.min(leg1Closes.length, leg2Closes.length);
      pairsCacheRef.set({
        leg1Symbol,
        leg2Symbol,
        fetchedAt: Date.now(),
        leg1Closes: leg1Closes.slice(leg1Closes.length - aligned),
        leg2Closes: leg2Closes.slice(leg2Closes.length - aligned),
      });
    } catch (err) {
      console.log(JSON.stringify({
        ts: params.observedAt,
        strategyType: "pairs-trading",
        event: "klines-fetch-failed",
        leg1Symbol,
        leg2Symbol,
        error: err instanceof Error ? err.message : String(err),
      }));
      return { shouldContinueLoop: true };
    }
  }

  // ── Per-leg instruments + current prices ─────────────────────────────────
  let leg1Instrument: InstrumentInfo;
  let leg2Instrument: InstrumentInfo;
  try {
    leg1Instrument = await params.getInstrument(leg1Symbol);
    leg2Instrument = await params.getInstrument(leg2Symbol);
  } catch (err) {
    console.log(JSON.stringify({
      ts: params.observedAt,
      strategyType: "pairs-trading",
      event: "instrument-unavailable",
      error: err instanceof Error ? err.message : String(err),
    }));
    return { shouldContinueLoop: true };
  }

  let leg1Ticker;
  let leg2Ticker;
  try {
    leg1Ticker = await client.getTicker({ category: "linear", symbol: leg1Symbol });
    leg2Ticker = await client.getTicker({ category: "linear", symbol: leg2Symbol });
  } catch (err) {
    console.log(JSON.stringify({
      ts: params.observedAt,
      strategyType: "pairs-trading",
      event: "ticker-unavailable",
      error: err instanceof Error ? err.message : String(err),
    }));
    return { shouldContinueLoop: true };
  }
  const leg1Price = Number(leg1Ticker.lastPrice);
  const leg2Price = Number(leg2Ticker.lastPrice);
  if (!Number.isFinite(leg1Price) || leg1Price <= 0 || !Number.isFinite(leg2Price) || leg2Price <= 0) {
    return { shouldContinueLoop: true };
  }

  const decision = pairsDecide({
    cache: pairsCacheRef.get(),
    position: pairsPositionRef.get(),
    now: Date.now(),
    refreshSec: config.pairsKlineRefreshSec,
    windowSize: config.pairsWindowSize,
    entryZ: config.pairsEntryZ,
    exitZ: config.pairsExitZ,
    maxHoldMinutes: config.pairsMaxHoldMinutes,
    leg1Symbol,
    leg2Symbol,
  });

  if (decision.kind === "hold") {
    console.log(JSON.stringify({
      ts: params.observedAt,
      event: "tick-pairs-trading",
      leg1Symbol,
      leg2Symbol,
      leg1Price,
      leg2Price,
      decision: "hold",
      reason: decision.reason,
      z: decision.z,
      position: pairsPositionRef.get(),
    }));
    return { shouldContinueLoop: true };
  }

  // ── ENTRY ────────────────────────────────────────────────────────────────
  if (decision.kind === "enter") {
    const notionalPerLeg = config.pairsMaxNotionalUsdPerLeg;
    const leg1QtyStep = Number(leg1Instrument.lotSizeFilter.qtyStep);
    const leg2QtyStep = Number(leg2Instrument.lotSizeFilter.qtyStep);
    const leg1MinQty = Number(leg1Instrument.lotSizeFilter.minOrderQty);
    const leg2MinQty = Number(leg2Instrument.lotSizeFilter.minOrderQty);

    const leg1QtyRaw = notionalPerLeg / leg1Price;
    const leg2QtyRaw = notionalPerLeg / leg2Price;
    const leg1Qty = Math.floor(leg1QtyRaw / leg1QtyStep) * leg1QtyStep;
    const leg2Qty = Math.floor(leg2QtyRaw / leg2QtyStep) * leg2QtyStep;
    if (leg1Qty < leg1MinQty || leg2Qty < leg2MinQty) {
      console.log(JSON.stringify({
        ts: params.observedAt,
        strategyType: "pairs-trading",
        event: "qty-below-min",
        leg1Qty,
        leg2Qty,
        leg1MinQty,
        leg2MinQty,
      }));
      return { shouldContinueLoop: true };
    }
    const leg1QtyStr = leg1Qty.toFixed(countDecimals(leg1Instrument.lotSizeFilter.qtyStep));
    const leg2QtyStr = leg2Qty.toFixed(countDecimals(leg2Instrument.lotSizeFilter.qtyStep));
    const leg1OrderSide: "Buy" | "Sell" = decision.leg1Side === "long" ? "Buy" : "Sell";
    const leg2OrderSide: "Buy" | "Sell" = decision.leg2Side === "long" ? "Buy" : "Sell";

    // Pre-entry LLM supervisor gate (pairs-trading is ~1-5 trades/day; latency OK).
    {
      const spread = decision.hedgeRatio
        ? Math.log(leg1Price) - decision.hedgeRatio * Math.log(leg2Price)
        : 0;
      const approve = await maybeSupervisedApprove({
        alerter: params.alerter,
        config,
        observedAt: params.observedAt,
        context: {
          strategyType: "pairs-trading",
          symbol: leg1Symbol,
          side: decision.leg1Side,
          notionalUsd: notionalPerLeg,
          leverage: 1,
          signalSnapshot: {
            leg1Symbol,
            leg2Symbol,
            z: decision.z,
            hedgeRatio: decision.hedgeRatio,
            leg1Price,
            leg2Price,
            spread,
          },
          recentTrades: 0,
          recentWinRate: 0,
          recentNetPnlUsd: 0,
          walletAvailableUsd: 0,
          openPositionsCount: pairsPositionRef.get() ? 1 : 0,
          cumulativeDailyPnlUsd: stateRef.get().realizedPnlUsd,
        },
      });
      if (!approve) {
        return { shouldContinueLoop: true };
      }
    }

    if (config.paperTrading) {
      const now = Date.now();
      pairsPositionRef.set({
        leg1Symbol,
        leg1Side: decision.leg1Side,
        leg1EntryPrice: leg1Price,
        leg1Qty,
        leg2Symbol,
        leg2Side: decision.leg2Side,
        leg2EntryPrice: leg2Price,
        leg2Qty,
        entryZ: decision.z,
        hedgeRatio: decision.hedgeRatio,
        entryAt: now,
      });
      openPositionSymbolRef.set(leg1Symbol);
      console.log(JSON.stringify({
        ts: params.observedAt,
        event: "pairs-trading-enter-paper",
        leg1Symbol,
        leg2Symbol,
        leg1Side: decision.leg1Side,
        leg2Side: decision.leg2Side,
        leg1Qty: leg1QtyStr,
        leg2Qty: leg2QtyStr,
        leg1Price,
        leg2Price,
        z: decision.z,
        hedgeRatio: decision.hedgeRatio,
      }));
      return { shouldContinueLoop: true };
    }

    // LIVE: order leg1 first, then leg2; compensate leg1 reduceOnly if leg2 fails.
    const leg1Req: CreateOrderRequest = {
      category: "linear",
      symbol: leg1Symbol,
      side: leg1OrderSide,
      qty: leg1QtyStr,
      orderType: "Market",
    };
    let leg1OrderId: string | undefined;
    try {
      const resp = await client.createOrder(leg1Req);
      leg1OrderId = resp.orderId;
    } catch (err) {
      console.log(JSON.stringify({
        ts: params.observedAt,
        event: "pairs-trading-leg1-failed",
        leg1Symbol,
        error: err instanceof Error ? err.message : String(err),
      }));
      await params.alerter.send(
        `pairs-trading leg1 failed (no exposure): ${leg1Symbol} ${leg1OrderSide} qty=${leg1QtyStr}`,
      ).catch(() => {});
      return { shouldContinueLoop: true };
    }

    const leg2Req: CreateOrderRequest = {
      category: "linear",
      symbol: leg2Symbol,
      side: leg2OrderSide,
      qty: leg2QtyStr,
      orderType: "Market",
    };
    try {
      await client.createOrder(leg2Req);
    } catch (err) {
      // Leg2 failed → CLOSE LEG1 IMMEDIATELY (naked-exposure guard).
      console.log(JSON.stringify({
        ts: params.observedAt,
        event: "pairs-trading-leg2-failed-closing-leg1",
        leg1Symbol,
        leg2Symbol,
        leg1OrderId,
        error: err instanceof Error ? err.message : String(err),
      }));
      const compensateSide: "Buy" | "Sell" = leg1OrderSide === "Buy" ? "Sell" : "Buy";
      try {
        await client.createOrder({
          category: "linear",
          symbol: leg1Symbol,
          side: compensateSide,
          qty: leg1QtyStr,
          orderType: "Market",
          reduceOnly: true,
        });
        await params.alerter.send(
          `pairs-trading: leg2 failed, leg1 compensated — closed ${leg1Symbol} qty=${leg1QtyStr}`,
        ).catch(() => {});
      } catch (compErr) {
        await params.alerter.send(
          `CRITICAL: pairs-trading naked exposure — manual reconcile: ${leg1Symbol} orderId=${leg1OrderId} qty=${leg1QtyStr} compensateErr=${
            compErr instanceof Error ? compErr.message : String(compErr)
          }`,
        ).catch(() => {});
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          event: "pairs-trading-naked-exposure",
          leg1Symbol,
          leg1OrderId,
          qty: leg1QtyStr,
        }));
      }
      return { shouldContinueLoop: true };
    }

    // Both legs filled.
    const now = Date.now();
    pairsPositionRef.set({
      leg1Symbol,
      leg1Side: decision.leg1Side,
      leg1EntryPrice: leg1Price,
      leg1Qty,
      leg2Symbol,
      leg2Side: decision.leg2Side,
      leg2EntryPrice: leg2Price,
      leg2Qty,
      entryZ: decision.z,
      hedgeRatio: decision.hedgeRatio,
      entryAt: now,
    });
    openPositionSymbolRef.set(leg1Symbol);
    console.log(JSON.stringify({
      ts: params.observedAt,
      event: "pairs-trading-enter-live",
      leg1Symbol,
      leg2Symbol,
      leg1Side: decision.leg1Side,
      leg2Side: decision.leg2Side,
      leg1Qty: leg1QtyStr,
      leg2Qty: leg2QtyStr,
      z: decision.z,
      hedgeRatio: decision.hedgeRatio,
    }));
    return { shouldContinueLoop: true };
  }

  // ── EXIT ─────────────────────────────────────────────────────────────────
  const pos = pairsPositionRef.get();
  if (!pos) return { shouldContinueLoop: true };

  const leg1QtyStr = pos.leg1Qty.toFixed(countDecimals(leg1Instrument.lotSizeFilter.qtyStep));
  const leg2QtyStr = pos.leg2Qty.toFixed(countDecimals(leg2Instrument.lotSizeFilter.qtyStep));

  // Per-leg PnL: long profits on rise; short profits on fall.
  const leg1Pnl = (pos.leg1Side === "long" ? leg1Price - pos.leg1EntryPrice : pos.leg1EntryPrice - leg1Price) * pos.leg1Qty;
  const leg2Pnl = (pos.leg2Side === "long" ? leg2Price - pos.leg2EntryPrice : pos.leg2EntryPrice - leg2Price) * pos.leg2Qty;
  const leg1Notional = pos.leg1Qty * pos.leg1EntryPrice;
  const leg2Notional = pos.leg2Qty * pos.leg2EntryPrice;
  const feeRoundTripBps = config.feeRoundTripBps;
  const leg1Fee = leg1Notional * (feeRoundTripBps / 10_000);
  const leg2Fee = leg2Notional * (feeRoundTripBps / 10_000);
  const netPnl = leg1Pnl + leg2Pnl - leg1Fee - leg2Fee;

  if (!config.paperTrading) {
    const leg1CloseSide: "Buy" | "Sell" = pos.leg1Side === "long" ? "Sell" : "Buy";
    const leg2CloseSide: "Buy" | "Sell" = pos.leg2Side === "long" ? "Sell" : "Buy";
    let leg1Closed = false;
    let leg2Closed = false;
    try {
      await client.createOrder({
        category: "linear",
        symbol: pos.leg1Symbol,
        side: leg1CloseSide,
        qty: leg1QtyStr,
        orderType: "Market",
        reduceOnly: true,
      });
      leg1Closed = true;
    } catch (err) {
      console.log(JSON.stringify({
        ts: params.observedAt,
        event: "pairs-trading-leg1-exit-failed",
        leg1Symbol: pos.leg1Symbol,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
    try {
      await client.createOrder({
        category: "linear",
        symbol: pos.leg2Symbol,
        side: leg2CloseSide,
        qty: leg2QtyStr,
        orderType: "Market",
        reduceOnly: true,
      });
      leg2Closed = true;
    } catch (err) {
      console.log(JSON.stringify({
        ts: params.observedAt,
        event: "pairs-trading-leg2-exit-failed",
        leg2Symbol: pos.leg2Symbol,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
    if (!leg1Closed || !leg2Closed) {
      await params.alerter.send(
        `pairs-trading exit incomplete — manual reconcile: leg1Closed=${leg1Closed} leg2Closed=${leg2Closed}`,
      ).catch(() => {});
    }
  }

  // Compute current z using the FROZEN entry hedge ratio for ledger transparency.
  let currentZ = decision.currentZ;
  const cache = pairsCacheRef.get();
  if (cache && cache.leg1Closes.length > 0 && cache.leg1Closes.length === cache.leg2Closes.length) {
    // Already supplied by decision; nothing more to compute.
    currentZ = decision.currentZ;
  }

  const previousState = stateRef.get();
  const nextState: TraderState = {
    ...previousState,
    realizedPnlUsd: previousState.realizedPnlUsd + netPnl,
    lastTradeAt: Date.now(),
    position: null,
  };
  stateRef.set(nextState);
  pairsPositionRef.set(null);
  openPositionSymbolRef.set(null);

  const ledgerEntry: ClosedPositionLedgerEntry = {
    closedAt: new Date().toISOString(),
    cumulativeRealizedPnlUsd: nextState.realizedPnlUsd,
    entryPrice: pos.leg1EntryPrice,
    exitPrice: leg1Price,
    exitReason: decision.reason,
    leverage: 1,
    notionalUsd: leg1Notional + leg2Notional,
    openedAt: new Date(pos.entryAt).toISOString(),
    quantity: pos.leg1Qty,
    realizedPnlUsd: netPnl,
    grossPnlUsd: leg1Pnl + leg2Pnl,
    feeUsd: leg1Fee + leg2Fee,
    championIdAtEntry: null,
    strategyType: "pairs-trading",
    pairsLeg2Symbol: pos.leg2Symbol,
    pairsEntryZ: pos.entryZ,
    pairsExitZ: currentZ,
    side: pos.leg1Side,
    stopLossPrice: 0,
    symbol: pos.leg1Symbol,
    takeProfitPrice: 0,
  };
  await params.positionLedger.appendClosedPosition(ledgerEntry);
  await params.positionLedger.syncSnapshot(params.toPersistedTraderSnapshot({
    openPositionSymbol: null,
    state: nextState,
  }));

  console.log(JSON.stringify({
    ts: params.observedAt,
    event: "pairs-trading-exit",
    leg1Symbol: pos.leg1Symbol,
    leg2Symbol: pos.leg2Symbol,
    reason: decision.reason,
    entryZ: pos.entryZ,
    exitZ: currentZ,
    leg1Pnl,
    leg2Pnl,
    feeUsd: leg1Fee + leg2Fee,
    netPnl,
  }));

  return { shouldContinueLoop: true };
}

/**
 * Bollinger + ADX regime-filter tick — single-leg, single-symbol, kline-cache
 * driven. Uses standard risk gates (cooldown, daily-loss, position-limit) via
 * the shared `evaluateRisk`. Bandit / scan-gate are not applied.
 */
async function runBollingerAdxTick(params: {
  alerter: WebhookAlerter;
  buildClosedPositionLedgerEntry: typeof buildClosedPositionLedgerEntry;
  client: ReturnType<typeof createBybitClient>;
  config: TraderConfig;
  getInstrument: (symbol: string) => Promise<InstrumentInfo>;
  klineCacheRef: MutableRef<BollingerAdxKlineCache | null>;
  observedAt: string;
  openPositionSymbolRef: MutableRef<string | null>;
  positionLedger: ReturnType<typeof createPositionLedger>;
  stateRef: MutableRef<TraderState>;
  toPersistedTraderSnapshot: (p: { openPositionSymbol: string | null; state: TraderState }) => PersistedTraderSnapshot;
}): Promise<{ shouldContinueLoop: boolean }> {
  const { config, client, stateRef, openPositionSymbolRef, klineCacheRef } = params;
  const activeSymbol = config.tradeCandidateSymbols[0] ?? config.symbol;

  let instrument: InstrumentInfo;
  try {
    instrument = await params.getInstrument(activeSymbol);
  } catch (err) {
    console.log(JSON.stringify({
      ts: params.observedAt,
      strategyType: "bollinger-adx",
      symbol: activeSymbol,
      event: "instrument-unavailable",
      error: err instanceof Error ? err.message : String(err),
    }));
    return { shouldContinueLoop: true };
  }

  let ticker;
  try {
    ticker = await client.getTicker({ category: config.category, symbol: activeSymbol });
  } catch (err) {
    console.log(JSON.stringify({
      ts: params.observedAt,
      strategyType: "bollinger-adx",
      symbol: activeSymbol,
      event: "ticker-unavailable",
      error: err instanceof Error ? err.message : String(err),
    }));
    return { shouldContinueLoop: true };
  }
  const lastPrice = Number(ticker.lastPrice);
  const markPrice = Number(ticker.markPrice);
  const bid = Number(ticker.bid1Price);
  const ask = Number(ticker.ask1Price);
  const mid = (bid + ask) / 2;
  const spreadBps = mid > 0 ? ((ask - bid) / mid) * 10_000 : 0;

  // Refresh kline cache (highs/lows/closes) when stale.
  const existing = klineCacheRef.get();
  const cacheStale =
    existing === null
    || existing.symbol !== activeSymbol
    || (Date.now() - existing.fetchedAt) >= config.bollingerAdxKlineRefreshSec * 1000;
  if (cacheStale) {
    try {
      const limit = Math.max(config.bollingerAdxBbPeriod, config.bollingerAdxAdxPeriod * 2 + 5) + 5;
      const klines = await client.getKlines({
        category: config.category,
        symbol: activeSymbol,
        interval: config.bollingerAdxKlineInterval,
        limit,
      });
      const highs = klines.map((k) => Number(k.highPrice)).reverse();
      const lows = klines.map((k) => Number(k.lowPrice)).reverse();
      const closes = klines.map((k) => Number(k.closePrice)).reverse();
      klineCacheRef.set({ symbol: activeSymbol, fetchedAt: Date.now(), highs, lows, closes });
    } catch (err) {
      console.log(JSON.stringify({
        ts: params.observedAt,
        strategyType: "bollinger-adx",
        symbol: activeSymbol,
        event: "klines-fetch-failed",
        error: err instanceof Error ? err.message : String(err),
      }));
      return { shouldContinueLoop: true };
    }
  }

  const state = stateRef.get();
  const hasPos = state.position !== null && openPositionSymbolRef.get() === activeSymbol;
  const adxPosition: BollingerAdxPosition | null = hasPos && state.position
    ? { side: state.position.side, entryPrice: state.position.entryPrice }
    : null;

  const decision = bollingerAdxDecide({
    klineCache: klineCacheRef.get(),
    position: adxPosition,
    symbol: activeSymbol,
    currentPrice: lastPrice,
    now: Date.now(),
    refreshSec: config.bollingerAdxKlineRefreshSec,
    bbPeriod: config.bollingerAdxBbPeriod,
    bbStdDev: config.bollingerAdxBbStdDev,
    adxPeriod: config.bollingerAdxAdxPeriod,
    adxRangingThreshold: config.bollingerAdxAdxRangingThreshold,
    adxTrendingThreshold: config.bollingerAdxAdxTrendingThreshold,
    stopLossBps: config.bollingerAdxStopLossBps,
    takeProfitBps: config.bollingerAdxTakeProfitBps,
  });

  // ── EXIT ────────────────────────────────────────────────────────────────
  if (decision.kind === "exit" && state.position && hasPos) {
    const closeAction: "long" | "short" = state.position.side === "long" ? "short" : "long";
    const closeQty = state.position.quantity.toFixed(countDecimals(instrument.lotSizeFilter.qtyStep));
    const exec = await executeTrade({
      action: closeAction,
      client,
      config,
      instrument,
      lastPrice,
      symbol: activeSymbol,
      tickerBidPrice: ticker.bid1Price,
      tickerAskPrice: ticker.ask1Price,
      qty: closeQty,
      reduceOnly: true,
    });
    if (exec.filled) {
      const previousState = state;
      const previousPosition = state.position;
      const newState = updatePaperState({
        action: closeAction,
        leverage: state.position.leverage,
        notionalUsd: state.position.notionalUsd,
        price: exec.fillPrice,
        previous: state,
        now: Date.now(),
        stopLossBps: config.bollingerAdxStopLossBps,
        takeProfitBps: config.bollingerAdxTakeProfitBps,
        reduceOnly: true,
        feeRoundTripBps: config.feeRoundTripBps,
      });
      stateRef.set(newState);
      openPositionSymbolRef.set(null);
      await params.positionLedger.appendClosedPosition(params.buildClosedPositionLedgerEntry({
        exitPrice: exec.fillPrice,
        exitReason: `bollinger-adx:${decision.reason}`,
        nextState: newState,
        previousState,
        previousPosition,
        symbol: activeSymbol,
        feeRoundTripBps: config.feeRoundTripBps,
        championIdAtEntry: null,
        strategyType: "bollinger-adx",
      }));
      await params.positionLedger.syncSnapshot(params.toPersistedTraderSnapshot({
        openPositionSymbol: null,
        state: newState,
      }));
    }
  }

  // ── ENTRY ───────────────────────────────────────────────────────────────
  if (decision.kind === "enter" && !state.position) {
    const notionalUsd = config.orderUsd * config.leverage;
    const risk = evaluateRisk({
      action: decision.side,
      limits: {
        maxPositionUsd: config.maxPositionUsd,
        maxDailyLossUsd: config.maxDailyLossUsd,
        minTradeIntervalMs: config.minTradeIntervalMs,
        maxSpreadBps: config.maxSpreadBps,
      },
      market: { lastPrice, markPrice },
      now: Date.now(),
      orderUsd: notionalUsd,
      state,
    });
    if (!risk.allowed) {
      console.log(JSON.stringify({
        ts: params.observedAt,
        strategyType: "bollinger-adx",
        symbol: activeSymbol,
        event: "entry-blocked-by-risk",
        reason: risk.reason,
        spreadBps,
      }));
      return { shouldContinueLoop: true };
    }
    const minLeverage = Number(instrument.leverageFilter.minLeverage);
    const maxLeverage = Number(instrument.leverageFilter.maxLeverage);
    const clampedLeverage = Math.min(Math.max(config.leverage, minLeverage), maxLeverage);
    const qtyStep = Number(instrument.lotSizeFilter.qtyStep);
    const rawQty = notionalUsd / lastPrice;
    const normalizedQty = Math.floor(rawQty / qtyStep) * qtyStep;
    const minQty = Number(instrument.lotSizeFilter.minOrderQty);
    if (normalizedQty < minQty) {
      return { shouldContinueLoop: true };
    }
    const qty = normalizedQty.toFixed(countDecimals(instrument.lotSizeFilter.qtyStep));
    const exec = await executeTrade({
      action: decision.side,
      client,
      config,
      instrument,
      lastPrice,
      symbol: activeSymbol,
      tickerBidPrice: ticker.bid1Price,
      tickerAskPrice: ticker.ask1Price,
      qty,
    });
    if (exec.filled) {
      const newState = updatePaperState({
        action: decision.side,
        leverage: clampedLeverage,
        notionalUsd,
        price: exec.fillPrice,
        previous: state,
        now: Date.now(),
        stopLossBps: config.bollingerAdxStopLossBps,
        takeProfitBps: config.bollingerAdxTakeProfitBps,
      });
      stateRef.set(newState);
      openPositionSymbolRef.set(activeSymbol);
      await params.positionLedger.syncSnapshot(params.toPersistedTraderSnapshot({
        openPositionSymbol: activeSymbol,
        state: newState,
      }));
    }
  }

  console.log(JSON.stringify({
    ts: params.observedAt,
    event: "tick-bollinger-adx",
    symbol: activeSymbol,
    lastPrice,
    spreadBps,
    decision: decision.kind,
    reason: decision.kind === "hold" || decision.kind === "enter" ? decision.reason : `exit:${decision.reason}`,
    regime: decision.kind === "exit" ? undefined : decision.regime,
    position: stateRef.get().position,
    realizedPnlUsd: stateRef.get().realizedPnlUsd,
  }));

  return { shouldContinueLoop: true };
}

export async function runTrader(config: TraderConfig): Promise<void> {
  await mkdir(resolveProjectPath("apps/trader/data/runtime"), { recursive: true });
  acquireSessionLock();

  let stopRequested = false;
  const onShutdownSignal = (signal: NodeJS.Signals) => {
    if (stopRequested) {
      return;
    }
    stopRequested = true;
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      event: "shutdown-signal",
      signal,
    }));
  };
  process.once("SIGINT", onShutdownSignal);
  process.once("SIGTERM", onShutdownSignal);

  const client = createBybitClient();
  const positionLedger = createPositionLedger();
  const scanConfig = readScanConfig(process.env);
  // Plumb TraderConfig JSON fields that the scanner needs but readScanConfig
  // only reads from env. JSON values win unless env explicitly overrode them.
  if (config.scanMinOpenInterestUsd > 0) {
    scanConfig.scanMinOpenInterestUsd = config.scanMinOpenInterestUsd;
  }
  if (config.scanMinListingAgeDays > 0) {
    scanConfig.scanMinListingAgeDays = config.scanMinListingAgeDays;
  }
  if (config.scanExcludedSymbols.length > 0) {
    scanConfig.scanExcludedSymbols = config.scanExcludedSymbols;
  }
  const instrumentCache = new Map<string, InstrumentInfo>();
  const configuredLiveLeverageBySymbol = new Map<string, number>();
  const priceHistoryBySymbol = new Map<string, number[]>();
  const symbolAvailability = new Map<string, SymbolAvailabilityState>();
  const symbolStatuses = new Map<string, {
    action: StrategySignal;
    aggressiveRisk: string;
    error: string | null;
    fundingRateBps: number;
    lastPrice: number;
    netEdgeBps: number;
    observedAt: string;
    risk: string;
    spreadBps: number;
  }>();
  let ticks = 0;
  let openPositionSymbol: string | null = null;
  let pendingClose: {
    orderLinkId: string;
    exitReason: string;
    closeAction: Exclude<StrategySignal, "flat">;
    notionalUsd: number;
    activeLeverage: number;
  } | null = null;
  let lastExecution: {
    executionMode: string;
    fallbackUsed: boolean;
    filled: boolean;
    fillPrice: number;
    orderLinkId?: string;
  } | null = null;
  let entryTick: number | null = null;
  let safetyStopPlaced = false;
  // Phase 1B additions
  const alerter = createWebhookAlerter(config.alertWebhookUrl);
  let forceLogicalExitForCurrentPosition = false;
  let lastReconcileTick = 0;
  let haltEntriesUntilCleared = false;
  let drawdownVelocityState: DrawdownVelocityState = { recentPnlSamples: [] };
  const recentOutcomes: Array<"win" | "loss"> = [];
  let effectiveMinSetupNetEdgeBps: number = config.tradeMinSetupNetEdgeBps;
  const filteredVariantLoggedFor = new Set<string>();
  let state: TraderState = {
    lastTradeAt: null,
    realizedPnlUsd: 0,
    position: null,
    dayStartedAt: null,
  };
  // Meta-bandit scope (declared at function level for finally-block access).
  let pool: Variant[] = [];
  let allocator: AllocatorState | null = null;
  const perVariantStates: Map<string, TraderState> = new Map();
  let championIdAtEntry: string | null = null;
  let lastAllocatorFlushTick = 0;
  const championClampedSymbols = new Set<string>();
  // Tick-log throttling: emit full diagnostic only on state change or every N ticks.
  let lastTickSignature: string | null = null;
  const verboseHeartbeatTicks = Math.max(config.runtimeArtifactFlushTicks, 30);
  // tick-quiet emitted at most once every N ticks (env QUIET_HEARTBEAT_TICKS, default 30).
  const quietHeartbeatTicks = Math.max(1, Number(process.env.QUIET_HEARTBEAT_TICKS ?? "30"));
  let lastQuietLogTick = -quietHeartbeatTicks; // ensure first tick emits one
  // Per-symbol verdict tracking — log only when a candidate's accept/reject reason changes.
  const lastVerdictBySymbol: Map<string, string> = new Map();
  // Cumulative counter of active-symbol verdicts (top-level reason only, e.g.
  // "warmup", "scanner-no-direction", "signal-disagreement", "risk:...", "aggressive-risk:...").
  // Logged inside the verbose tick so user can see what's gating most ticks.
  const activeVerdictCounts: Map<string, number> = new Map();
  // Drawdown-halt is a TEMPORARY pause, not a process kill. drawdownHaltUntilMs is the
  // wall-clock the trader can resume entries. Resets recentOutcomes on resume.
  let drawdownHaltUntilMs: number = 0;
  const drawdownHaltCooldownMs = Number(process.env.DRAWDOWN_HALT_COOLDOWN_MS ?? String(60 * 60 * 1000)); // 1h
  try {
    const persistedSnapshot = await positionLedger.loadSnapshot();
    if (persistedSnapshot) {
      let hydratedSnapshot = persistedSnapshot;

      if (!config.paperTrading && persistedSnapshot.position && persistedSnapshot.openPositionSymbol) {
        const livePosition = await client.getPosition({
          category: config.category,
          symbol: persistedSnapshot.openPositionSymbol,
        });

        if (!livePosition) {
          hydratedSnapshot = {
            ...persistedSnapshot,
            position: null,
            openPositionSymbol: null,
            updatedAt: new Date().toISOString(),
          };
          await positionLedger.syncSnapshot(hydratedSnapshot);
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            reconciliation: "cleared-stale-position-snapshot",
            symbol: persistedSnapshot.openPositionSymbol,
          }));
        } else if (!isLivePositionAligned({
          livePosition,
          persistedSnapshot,
        })) {
          console.warn(JSON.stringify({
            ts: new Date().toISOString(),
            reconciliation: "position-snapshot-mismatch",
            symbol: persistedSnapshot.openPositionSymbol,
            persistedQuantity: persistedSnapshot.position.quantity,
            liveQuantity: toNumber(livePosition.size),
            persistedSide: persistedSnapshot.position.side,
            liveSide: livePosition.side,
          }));
        }
      }

      state = {
        lastTradeAt: hydratedSnapshot.lastTradeAt,
        realizedPnlUsd: hydratedSnapshot.realizedPnlUsd,
        position: hydratedSnapshot.position,
        dayStartedAt: hydratedSnapshot.dayStartedAt,
      };
      openPositionSymbol = hydratedSnapshot.openPositionSymbol;
    }
    if (!config.paperTrading && config.autoSizeFromWallet && config.walletFraction >= 1 && config.walletMaxOrderUsdCap === null) {
      console.warn(JSON.stringify({
        ts: new Date().toISOString(),
        warning: "live-wallet-uncapped",
        message: "AUTO_SIZE_FROM_WALLET=true with WALLET_FRACTION>=1 and no WALLET_MAX_ORDER_USD_CAP — full wallet balance will be used as order size. Set WALLET_MAX_ORDER_USD_CAP to limit exposure.",
      }));
    }

    let walletSizing = {
      orderUsd: config.orderUsd,
      reason: config.paperTrading ? "paper-trading" : "wallet-fallback-config",
      walletAvailableUsd: null as number | null,
    };
    // ── Phase-2 strategy state ──────────────────────────────────────────────
    let fundingTargetForOpenPosition: number | null = null;
    const longerTfKlineCacheBySymbol: Map<string, LongerTfKlineCache> = new Map();
    // basis-arb state
    let basisArbPosition: BasisPosition | null = null;
    let basisArbEntryPerpPrice: number | null = null;
    let basisArbEntrySpotPrice: number | null = null;
    let basisArbEntryQty: number | null = null;
    let basisArbFundingRateAtEntry: number | null = null;
    // pairs-trading state
    let pairsCache: PairsCache | null = null;
    let pairsPosition: PairsPosition | null = null;
    // bollinger-adx state
    let bollingerAdxKlineCache: BollingerAdxKlineCache | null = null;
    // calendar-spread state
    let calendarPosition: CalendarPosition | null = null;
    // llm-managed state
    let llmManagedPosition: LlmManagedPosition | null = null;
    let llmManagedLastOpenDecisionAt = 0;
    let llmManagedLastManageDecisionAt = 0;
    let llmManagedLastCutLossAt = 0;
    let cachedRankedSetups: RankedTradeSetup[] = [];
    let lastScanAt = 0;
    let lastScanGeneratedAt: string | null = null;

    // ── Meta-bandit setup (only when META_ENABLED and strategyType=ma-crossover) ──
    if (config.metaEnabled && config.strategyType === "ma-crossover") {
      pool = defaultVariantPool(config);
      const persisted = await loadAllocatorState();
      if (persisted) {
        allocator = persisted.allocator;
      } else {
        allocator = emptyAllocatorState();
      }
      for (const v of pool) {
        perVariantStates.set(v.id, {
          lastTradeAt: null,
          realizedPnlUsd: 0,
          position: null,
          dayStartedAt: null,
        });
      }
    }

    while ((config.maxTicks === 0 || ticks < config.maxTicks) && !stopRequested) {
      const observedAt = new Date().toISOString();
      // Daily rollover at top-of-tick — handles UTC day crossings even when idle.
      state = rolloverDailyPnlIfNeeded(state, Date.now());

      // ── Strategy dispatch: non-MA strategies short-circuit the MA loop. ──
      if (config.strategyType === "llm-managed") {
        const handled = await runLlmManagedTick({
          alerter,
          client,
          config,
          observedAt,
          positionRef: {
            get: () => llmManagedPosition,
            set: (v) => { llmManagedPosition = v; },
          },
          lastOpenDecisionAtRef: {
            get: () => llmManagedLastOpenDecisionAt,
            set: (v) => { llmManagedLastOpenDecisionAt = v; },
          },
          lastManageDecisionAtRef: {
            get: () => llmManagedLastManageDecisionAt,
            set: (v) => { llmManagedLastManageDecisionAt = v; },
          },
          lastCutLossAtRef: {
            get: () => llmManagedLastCutLossAt,
            set: (v) => { llmManagedLastCutLossAt = v; },
          },
          openPositionSymbolRef: {
            get: () => openPositionSymbol,
            set: (v) => { openPositionSymbol = v; },
          },
          positionLedger,
          stateRef: {
            get: () => state,
            set: (v) => { state = v; },
          },
          toPersistedTraderSnapshot: (p) => toPersistedTraderSnapshot(p),
        });
        ticks += 1;
        if (!handled.shouldContinueLoop) break;
        if (config.pollMs > 0) await sleep(config.pollMs);
        continue;
      }
      if (config.strategyType === "calendar-spread") {
        const handled = await runCalendarSpreadTick({
          alerter,
          client,
          config,
          getInstrument: (symbol) => getInstrument({
            cache: instrumentCache,
            category: "linear",
            client,
            symbol,
          }),
          observedAt,
          calendarPositionRef: {
            get: () => calendarPosition,
            set: (v) => { calendarPosition = v; },
          },
          positionLedger,
          stateRef: {
            get: () => state,
            set: (v) => { state = v; },
          },
          openPositionSymbolRef: {
            get: () => openPositionSymbol,
            set: (v) => { openPositionSymbol = v; },
          },
          toPersistedTraderSnapshot: (p) => toPersistedTraderSnapshot(p),
        });
        ticks += 1;
        if (!handled.shouldContinueLoop) break;
        // calendar-spread polls slowly (pollSec, default 60).
        const calPollMs = Math.max(config.calendarPollSec * 1000, 1);
        await sleep(calPollMs);
        continue;
      }
      if (config.strategyType === "basis-arb") {
        const handled = await runBasisArbTick({
          alerter,
          client,
          config,
          getInstrument: (symbol) => getInstrument({
            cache: instrumentCache,
            category: "linear",
            client,
            symbol,
          }),
          observedAt,
          basisPositionRef: {
            get: () => basisArbPosition,
            set: (v) => { basisArbPosition = v; },
          },
          basisEntryPerpPriceRef: {
            get: () => basisArbEntryPerpPrice,
            set: (v) => { basisArbEntryPerpPrice = v; },
          },
          basisEntrySpotPriceRef: {
            get: () => basisArbEntrySpotPrice,
            set: (v) => { basisArbEntrySpotPrice = v; },
          },
          basisEntryQtyRef: {
            get: () => basisArbEntryQty,
            set: (v) => { basisArbEntryQty = v; },
          },
          basisFundingRateAtEntryRef: {
            get: () => basisArbFundingRateAtEntry,
            set: (v) => { basisArbFundingRateAtEntry = v; },
          },
          positionLedger,
          stateRef: {
            get: () => state,
            set: (v) => { state = v; },
          },
          openPositionSymbolRef: {
            get: () => openPositionSymbol,
            set: (v) => { openPositionSymbol = v; },
          },
          toPersistedTraderSnapshot: (p) => toPersistedTraderSnapshot(p),
        });
        ticks += 1;
        if (!handled.shouldContinueLoop) break;
        if (config.pollMs > 0) await sleep(config.pollMs);
        continue;
      }
      if (config.strategyType === "pairs-trading") {
        const handled = await runPairsTradingTick({
          alerter,
          client,
          config,
          getInstrument: (symbol) => getInstrument({
            cache: instrumentCache,
            category: "linear",
            client,
            symbol,
          }),
          observedAt,
          pairsCacheRef: {
            get: () => pairsCache,
            set: (v) => { pairsCache = v; },
          },
          pairsPositionRef: {
            get: () => pairsPosition,
            set: (v) => { pairsPosition = v; },
          },
          positionLedger,
          stateRef: {
            get: () => state,
            set: (v) => { state = v; },
          },
          openPositionSymbolRef: {
            get: () => openPositionSymbol,
            set: (v) => { openPositionSymbol = v; },
          },
          toPersistedTraderSnapshot: (p) => toPersistedTraderSnapshot(p),
        });
        ticks += 1;
        if (!handled.shouldContinueLoop) break;
        if (config.pollMs > 0) await sleep(config.pollMs);
        continue;
      }
      if (config.strategyType === "bollinger-adx") {
        const handled = await runBollingerAdxTick({
          alerter,
          buildClosedPositionLedgerEntry,
          client,
          config,
          getInstrument: (symbol) => getInstrument({
            cache: instrumentCache,
            category: config.category,
            client,
            symbol,
          }),
          klineCacheRef: {
            get: () => bollingerAdxKlineCache,
            set: (v) => { bollingerAdxKlineCache = v; },
          },
          observedAt,
          openPositionSymbolRef: {
            get: () => openPositionSymbol,
            set: (v) => { openPositionSymbol = v; },
          },
          positionLedger,
          stateRef: {
            get: () => state,
            set: (v) => { state = v; },
          },
          toPersistedTraderSnapshot: (p) => toPersistedTraderSnapshot(p),
        });
        ticks += 1;
        if (!handled.shouldContinueLoop) break;
        if (config.pollMs > 0) await sleep(config.pollMs);
        continue;
      }
      if (config.strategyType === "funding-arb" || config.strategyType === "longer-tf") {
        const handled = await runAlternativeStrategyTick({
          alerter,
          buildClosedPositionLedgerEntry,
          client,
          config,
          fundingTargetRef: {
            get: () => fundingTargetForOpenPosition,
            set: (v) => { fundingTargetForOpenPosition = v; },
          },
          getInstrument: (symbol) => getInstrument({
            cache: instrumentCache,
            category: config.category,
            client,
            symbol,
          }),
          longerTfKlineCacheBySymbol,
          observedAt,
          openPositionSymbolRef: {
            get: () => openPositionSymbol,
            set: (v) => { openPositionSymbol = v; },
          },
          positionLedger,
          stateRef: {
            get: () => state,
            set: (v) => { state = v; },
          },
          toPersistedTraderSnapshot: (p) => toPersistedTraderSnapshot(p),
        });
        ticks += 1;
        if (!handled.shouldContinueLoop) {
          break;
        }
        await sleep(config.pollMs);
        continue;
      }

      if ((Date.now() - lastScanAt) >= config.tradeScanRefreshMs || cachedRankedSetups.length === 0) {
        cachedRankedSetups = await rankTradeSetups(scanConfig);
        lastScanAt = Date.now();
        lastScanGeneratedAt = observedAt;

        if (config.scanGateAutoTuneEnabled) {
          try {
            const history = await loadScanHistory();
            const tunedGate = autoTuneSetupGate({
              scanHistory: history,
              targetPercentile: config.scanGateAutoTunePercentile,
              fallbackBps: config.scanGateAutoTuneFallbackBps,
            });
            effectiveMinSetupNetEdgeBps = tunedGate;
            console.log(JSON.stringify({
              ts: new Date().toISOString(),
              event: "setup-gate-auto-tuned",
              fallback: config.scanGateAutoTuneFallbackBps,
              tuned: tunedGate,
              historyLen: history.length,
              percentile: config.scanGateAutoTunePercentile,
            }));
          } catch (err) {
            effectiveMinSetupNetEdgeBps = config.tradeMinSetupNetEdgeBps;
            console.log(JSON.stringify({
              ts: new Date().toISOString(),
              event: "setup-gate-auto-tune-failed",
              error: err instanceof Error ? err.message : String(err),
            }));
          }
        } else {
          effectiveMinSetupNetEdgeBps = config.tradeMinSetupNetEdgeBps;
        }

        if (!config.paperTrading && config.autoSizeFromWallet) {
          try {
            walletSizing = resolveWalletOrderUsd({
              accountType: config.walletAccountType,
              autoSizeFromWallet: config.autoSizeFromWallet,
              fallbackOrderUsd: config.orderUsd,
              maxOrderUsdCap: config.walletMaxOrderUsdCap,
              walletBalanceResponse: await client.getWalletBalance(config.walletAccountType),
              walletCoin: config.walletCoin,
              walletFraction: config.walletFraction,
            });
          } catch {
            walletSizing = {
              orderUsd: config.orderUsd,
              reason: "wallet-request-failed",
              walletAvailableUsd: null,
            };
          }
        }
      }
    const effectiveOrderUsd = walletSizing.orderUsd;

    const resolvedRankedSetups = config.tradeCandidateSymbols.length > 0
      ? cachedRankedSetups.filter((setup) => config.tradeCandidateSymbols.includes(setup.symbol))
      : cachedRankedSetups;
    const activeAggressiveAllowedSymbols = config.aggressiveAllowedSymbols;
    const rankedSymbols = resolvedRankedSetups.map((setup) => setup.symbol);
    const selectableCandidateSymbols = rankedSymbols.filter((symbol) => (
      !isSymbolInTickerCooldown({
        currentTick: ticks,
        state: symbolAvailability.get(symbol),
      })
    ));
    const candidateSymbols = selectableCandidateSymbols.length > 0 ? selectableCandidateSymbols : rankedSymbols;

    for (const symbol of rankedSymbols) {
      if (!isSymbolInTickerCooldown({
        currentTick: ticks,
        state: symbolAvailability.get(symbol),
      })) {
        continue;
      }

      const previousStatus = symbolStatuses.get(symbol);
      symbolStatuses.set(symbol, {
        action: previousStatus?.action ?? "flat",
        aggressiveRisk: previousStatus?.aggressiveRisk ?? "unobserved",
        error: previousStatus?.error ?? "ticker unavailable repeatedly",
        fundingRateBps: previousStatus?.fundingRateBps ?? 0,
        lastPrice: previousStatus?.lastPrice ?? 0,
        netEdgeBps: previousStatus?.netEdgeBps ?? 0,
        observedAt,
        risk: "ticker-cooldown",
        spreadBps: previousStatus?.spreadBps ?? 0,
      });
    }

    // Pick the highest-ranked candidate whose setup ALSO passes the gate (score + netEdge + action).
    // Falls back to the bare #1 if no candidate passes — so we always have an active symbol to observe.
    const minScoreForGate = config.tradeMinSetupScore;
    const minEdgeForGate = effectiveMinSetupNetEdgeBps;
    let pickedFromGate: string | null = null;
    for (const sym of candidateSymbols) {
      const setupForSym = resolvedRankedSetups.find((s) => s.symbol === sym) ?? null;
      if (!evaluateTopSetupGate({ minScore: minScoreForGate, minNetEdgeBps: minEdgeForGate, setup: setupForSym })) {
        pickedFromGate = sym;
        break;
      }
    }
    const activeSymbol: string = openPositionSymbol ?? pickedFromGate ?? candidateSymbols[0] ?? config.symbol;
    const activeSymbolReason = openPositionSymbol
      ? "open-position"
      : pickedFromGate
        ? "scan-gated"
        : candidateSymbols.length > 0
          ? "scan-top"
          : "fallback";
    const activeSetup = resolvedRankedSetups.find((setup) => setup.symbol === activeSymbol) ?? null;
    const marketScanGate = {
      generatedAt: lastScanGeneratedAt,
      reason: resolvedRankedSetups.length > 0 ? "ok" : "empty",
    };
    const scanGate = {
      generatedAt: config.tradeCandidateSymbols.length > 0 ? null : lastScanGeneratedAt,
      reason: config.tradeCandidateSymbols.length > 0 ? "manual-filter" : "live-scan",
    };

    let instrument: InstrumentInfo;
    try {
      instrument = await getInstrument({
        cache: instrumentCache,
        category: config.category,
        client,
        symbol: activeSymbol,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      symbolStatuses.set(activeSymbol, {
        action: "flat",
        aggressiveRisk: "unobserved",
        error: message,
        fundingRateBps: 0,
        lastPrice: 0,
        netEdgeBps: 0,
        observedAt,
        risk: "instrument-unavailable",
        spreadBps: 0,
      });



      const runtimeArtifactPath = await persistRuntimeArtifact({
        activeSymbol,
        candidateSymbols: rankedSymbols,
        rankedSymbols,
        rankedSetupsTop: summarizeTopRankedSetups(resolvedRankedSetups),
        openPositionSymbol,
        perSymbol: Object.fromEntries(rankedSymbols.map((symbol) => {
          const pricesForSymbol = priceHistoryBySymbol.get(symbol) ?? [];
          const status = symbolStatuses.get(symbol);
          return [symbol, {
            action: status?.action ?? "unobserved",
            aggressiveRisk: status?.aggressiveRisk ?? "unobserved",
            error: status?.error ?? null,
            fundingRateBps: status?.fundingRateBps ?? null,
            lastPrice: status?.lastPrice ?? null,
            netEdgeBps: status?.netEdgeBps ?? null,
            observedAt: status?.observedAt ?? null,
            risk: status?.risk ?? "unobserved",
            spreadBps: status?.spreadBps ?? null,
            pricePoints: pricesForSymbol.length,
          }];
        })),
        scanGate: scanGate.reason,
        scanGateGeneratedAt: scanGate.generatedAt,
        tradingProfile: config.tradingProfile,
        marketScanGate: marketScanGate.reason,
        marketScanGateGeneratedAt: marketScanGate.generatedAt,
      });

      console.log(JSON.stringify({
        ts: observedAt,
        symbol: activeSymbol,
        activeSymbolReason,
        candidateSymbols: rankedSymbols,
        rankedSymbols,
        rankedSetupsTop: summarizeTopRankedSetups(resolvedRankedSetups),
        tradingProfile: config.tradingProfile,
        marketScanGate: marketScanGate.reason,
        marketScanGateGeneratedAt: marketScanGate.generatedAt,
        scanGate: scanGate.reason,
        scanGateGeneratedAt: scanGate.generatedAt,
        ...maybeAggressiveLogFields(config, activeAggressiveAllowedSymbols),
        mode: config.paperTrading ? "paper" : "live",
        runtimeArtifactPath,
        error: message,
        risk: "instrument-unavailable",
      }));

      ticks += 1;
      await sleep(config.pollMs);
      continue;
    }
    let ticker;
    try {
      ticker = await client.getTicker({
        category: config.category,
        symbol: activeSymbol,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      symbolStatuses.set(activeSymbol, {
        action: "flat",
        aggressiveRisk: "unobserved",
        error: message,
        fundingRateBps: 0,
        lastPrice: 0,
        netEdgeBps: 0,
        observedAt,
        risk: "ticker-unavailable",
        spreadBps: 0,
      });
      symbolAvailability.set(activeSymbol, registerTickerFailure({
        cooldownTicks: config.tickerFailureCooldownTicks,
        currentTick: ticks,
        state: symbolAvailability.get(activeSymbol),
        threshold: config.tickerFailureThreshold,
      }));

      const runtimeArtifactPath = await persistRuntimeArtifact({
        activeSymbol,
        candidateSymbols: rankedSymbols,
        rankedSymbols,
        rankedSetupsTop: summarizeTopRankedSetups(resolvedRankedSetups),
        openPositionSymbol,
        perSymbol: Object.fromEntries(rankedSymbols.map((symbol) => {
          const pricesForSymbol = priceHistoryBySymbol.get(symbol) ?? [];
          const status = symbolStatuses.get(symbol);
          return [symbol, {
            action: status?.action ?? "unobserved",
            aggressiveRisk: status?.aggressiveRisk ?? "unobserved",
            error: status?.error ?? null,
            fundingRateBps: status?.fundingRateBps ?? null,
            lastPrice: status?.lastPrice ?? null,
            netEdgeBps: status?.netEdgeBps ?? null,
            observedAt: status?.observedAt ?? null,
            risk: status?.risk ?? "unobserved",
            spreadBps: status?.spreadBps ?? null,
            pricePoints: pricesForSymbol.length,
          }];
        })),
        scanGate: scanGate.reason,
        scanGateGeneratedAt: scanGate.generatedAt,
        tradingProfile: config.tradingProfile,
        marketScanGate: marketScanGate.reason,
        marketScanGateGeneratedAt: marketScanGate.generatedAt,
      });

      console.log(JSON.stringify({
        ts: observedAt,
        symbol: activeSymbol,
        activeSymbolReason,
        candidateSymbols: rankedSymbols,
        rankedSymbols,
        rankedSetupsTop: summarizeTopRankedSetups(resolvedRankedSetups),
        tradingProfile: config.tradingProfile,
        marketScanGate: marketScanGate.reason,
        marketScanGateGeneratedAt: marketScanGate.generatedAt,
        scanGate: scanGate.reason,
        scanGateGeneratedAt: scanGate.generatedAt,
        ...maybeAggressiveLogFields(config, activeAggressiveAllowedSymbols),
        mode: config.paperTrading ? "paper" : "live",
        runtimeArtifactPath,
        error: message,
        risk: "ticker-unavailable",
      }));

      ticks += 1;
      await sleep(config.pollMs);
      continue;
    }
    const lastPrice = toNumber(ticker.lastPrice);
    symbolAvailability.set(activeSymbol, registerTickerSuccess(symbolAvailability.get(activeSymbol)));
    const markPrice = toNumber(ticker.markPrice);
    const fundingRateBps = toNumber(ticker.fundingRate) * 10_000;

    // ── Meta-bandit: shadow-trade every variant, record closures ────────────
    let championId: string | null = null;
    let championReason: string = "meta-disabled";
    let championParams: {
      stopLossBps: number;
      takeProfitBps: number;
      leverage: number;
      orderUsd: number;
    } = {
      stopLossBps: config.stopLossBps,
      takeProfitBps: config.takeProfitBps,
      leverage: config.leverage,
      orderUsd: config.orderUsd,
    };
    if (config.metaEnabled && config.strategyType === "ma-crossover" && allocator && pool.length > 0) {
      const eligibleVariants = pool.filter(
        (v) => !v.symbolFilter || v.symbolFilter.includes(activeSymbol),
      );
      if (eligibleVariants.length !== pool.length) {
        const logKey = `${activeSymbol}:${eligibleVariants.length}/${pool.length}`;
        if (!filteredVariantLoggedFor.has(logKey)) {
          filteredVariantLoggedFor.add(logKey);
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            event: "variant-filtered-by-symbol",
            activeSymbol,
            eligibleCount: eligibleVariants.length,
            totalCount: pool.length,
            excluded: pool
              .filter((v) => v.symbolFilter && !v.symbolFilter.includes(activeSymbol))
              .map((v) => v.id),
          }));
        }
      }

      for (const variant of eligibleVariants) {
        const prevVariantState = perVariantStates.get(variant.id) ?? {
          lastTradeAt: null,
          realizedPnlUsd: 0,
          position: null,
          dayStartedAt: null,
        };
        const variantPriceHistory = [...(priceHistoryBySymbol.get(activeSymbol) ?? [])];
        const ctxV: StepContext = {
          symbol: activeSymbol,
          ticker,
          instrument,
          now: Date.now(),
          priceHistory: variantPriceHistory,
          feeRoundTripBps: config.feeRoundTripBps,
        };
        const result = step(ctxV, variant.params, prevVariantState);
        // Detect close: prev had position, next does not.
        if (prevVariantState.position && !result.state.position) {
          const pnlDelta = result.state.realizedPnlUsd - prevVariantState.realizedPnlUsd;
          allocator = recordClosedTrade(
            allocator,
            variant.id,
            pnlDelta,
            Date.now(),
            config.metaPnlWindowSize,
          );
        }
        perVariantStates.set(variant.id, result.state);
      }
      const championVariants = eligibleVariants.length > 0 ? eligibleVariants : pool;
      const champion = selectChampion({
        allocator,
        variants: championVariants,
        now: Date.now(),
        warmupMinTrades: config.metaWarmupMinTrades,
        halfLifeDays: config.bandit_halfLifeDays > 0 ? config.bandit_halfLifeDays : undefined,
      });
      championId = champion.championId;
      championReason = champion.reason;
      if (champion.allocator) {
        allocator = champion.allocator;
      }
      const championVariant = pool.find((v) => v.id === championId);
      if (championVariant) {
        championParams = {
          stopLossBps: championVariant.params.stopLossBps,
          takeProfitBps: championVariant.params.takeProfitBps,
          leverage: championVariant.params.leverage,
          orderUsd: championVariant.params.orderUsd,
        };
      }
    }

    const effectiveLeverageRaw = config.metaEnabled ? championParams.leverage : config.leverage;
    const effectiveStopLossBps = config.metaEnabled ? championParams.stopLossBps : config.stopLossBps;
    const effectiveTakeProfitBps = config.metaEnabled ? championParams.takeProfitBps : config.takeProfitBps;
    // User decision #1: clamp variant.orderUsd via min(variant.orderUsd, walletSizing.orderUsd).
    let effectiveOrderUsdPreClamp = config.metaEnabled
      ? Math.min(championParams.orderUsd, walletSizing.orderUsd)
      : walletSizing.orderUsd;
    let confidenceMultiplier = 1;
    if (config.confidenceSizingEnabled && activeSetup) {
      const sized = applyConfidenceSizing({
        baseOrderUsd: effectiveOrderUsdPreClamp,
        scanScore: activeSetup.score,
        referenceScore: config.tradeMinSetupScore,
        minMultiplier: config.confidenceSizingMinMultiplier,
        maxMultiplier: config.confidenceSizingMaxMultiplier,
      });
      effectiveOrderUsdPreClamp = sized.orderUsd;
      confidenceMultiplier = sized.multiplier;
    }
    if (config.metaEnabled && championParams.orderUsd > walletSizing.orderUsd) {
      if (!championClampedSymbols.has(activeSymbol)) {
        championClampedSymbols.add(activeSymbol);
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          event: "champion-orderusd-clamped",
          symbol: activeSymbol,
          championOrderUsd: championParams.orderUsd,
          walletOrderUsd: walletSizing.orderUsd,
        }));
      }
    }
    const baseLeverage = clampLeverage(effectiveLeverageRaw, instrument);
    if (config.metaEnabled && baseLeverage < effectiveLeverageRaw) {
      const clampKey = `lev:${activeSymbol}`;
      if (!championClampedSymbols.has(clampKey)) {
        championClampedSymbols.add(clampKey);
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          event: "champion-leverage-clamped",
          symbol: activeSymbol,
          requestedLeverage: effectiveLeverageRaw,
          appliedLeverage: baseLeverage,
          instrumentMaxLeverage: Number(instrument.leverageFilter.maxLeverage),
        }));
      }
    }
    const bid = toNumber(ticker.bid1Price);
    const ask = toNumber(ticker.ask1Price);
    const mid = (bid + ask) / 2;
    const spreadBps = mid > 0 ? ((ask - bid) / mid) * 10_000 : 0;

    const prices = getPriceHistory({
      priceHistoryBySymbol,
      symbol: activeSymbol,
    });
    prices.push(lastPrice);
    if (prices.length > config.slowWindow) {
      prices.shift();
    }

    const topSetupGateReason = evaluateTopSetupGate({
      minNetEdgeBps: effectiveMinSetupNetEdgeBps,
      minScore: config.tradeMinSetupScore,
      setup: activeSetup,
    });
    const scanAction = activeSetup?.action ?? "flat";
    const action = topSetupGateReason ? "flat" : scanAction;
    // Confirm scanner signal with local MA: only enter when both agree
    const localSignal = prices.length >= config.slowWindow
      ? buildSignal({ prices, fastWindow: config.fastWindow, slowWindow: config.slowWindow, thresholdBps: config.thresholdBps })
      : "flat";
    const fundingBlocked = Math.abs(fundingRateBps) > config.riskMaxFundingRateBps;
    const localMaPasses = config.requireLocalMaConfirmation ? action === localSignal : true;
    const entryAction: StrategySignal = action !== "flat" && localMaPasses && !fundingBlocked ? action : "flat";
    const hourlyMoveBps = activeSetup?.hourlyMoveBps
      ?? Math.abs(((lastPrice - toNumber(ticker.prevPrice1h)) / toNumber(ticker.prevPrice1h)) * 10_000);
    const minuteRangeBps = activeSetup?.minuteRangeBps ?? Math.max(config.takeProfitBps, config.stopLossBps);
    const netEdgeBps = activeSetup?.netEdgeBps ?? (minuteRangeBps - 16 - spreadBps);
    const leverageDecision = config.exceptionalLeverageEnabled
      ? selectLeverageForOpportunity({
          symbol: activeSymbol,
          configuredLeverage: baseLeverage,
          fundingRateBps,
          spreadBps,
          hourlyMoveBps,
          minuteRangeBps,
          netEdgeBps,
          policy: {
            allowedSymbols: config.exceptionalAllowedSymbols,
            exceptionalLeverage: config.exceptionalLeverage,
            maxSpreadBps: config.exceptionalMaxSpreadBps,
            maxFundingRateBps: config.exceptionalMaxFundingRateBps,
            minHourlyMoveBps: config.exceptionalMinHourlyMoveBps,
            minMinuteRangeBps: config.exceptionalMinMinuteRangeBps,
            minNetEdgeBps: config.exceptionalMinNetEdgeBps,
          },
        })
      : {
          leverage: baseLeverage,
          exceptional: false,
          reason: "exceptional-disabled",
        };
    const activeLeverage = clampLeverage(leverageDecision.leverage, instrument);

    // ── Position reconciliation (live only) ──────────────────────────────────
    if (
      !config.paperTrading
      && config.positionReconcileIntervalTicks > 0
      && ticks - lastReconcileTick >= config.positionReconcileIntervalTicks
    ) {
      lastReconcileTick = ticks;
      const observed = await client.getPosition({
        category: config.category,
        symbol: activeSymbol,
      }).catch(() => null);
      const reconciled = reconcilePositions({
        expected: state.position,
        observed: observed ? {
          side: observed.side as "Buy" | "Sell",
          size: toNumber(observed.size),
          avgPrice: toNumber(observed.avgPrice),
        } : null,
      });
      if (reconciled.aligned && haltEntriesUntilCleared) {
        haltEntriesUntilCleared = false;
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          event: "halt-entries-cleared",
          symbol: activeSymbol,
        }));
      }
      if (!reconciled.aligned) {
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          event: "position-drift-detected",
          symbol: activeSymbol,
          drift: reconciled.drift,
          details: reconciled.details ?? null,
        }));
        await alerter.send(`position drift: ${reconciled.drift}`, {
          symbol: activeSymbol,
          details: reconciled.details ?? null,
        });

        if (reconciled.drift === "missing-on-exchange") {
          // Bybit closed the position (likely native SL/TP) — clear local state
          // and lift the halt: state is consistent again.
          haltEntriesUntilCleared = false;
          state = { ...state, position: null };
          openPositionSymbol = null;
          safetyStopPlaced = false;
          entryTick = null;
          championIdAtEntry = null;
          forceLogicalExitForCurrentPosition = false;
          await positionLedger.syncSnapshot(toPersistedTraderSnapshot({
            openPositionSymbol,
            state,
          }));
        } else if (reconciled.drift === "extra-on-exchange") {
          // Halt new entries until manually cleared (do not auto-close).
          haltEntriesUntilCleared = true;
        } else if (
          (reconciled.drift === "side-mismatch" || reconciled.drift === "size-mismatch")
          && observed
        ) {
          // Broker is ground truth: update local state to match.
          const observedSide: "long" | "short" = observed.side === "Buy" ? "long" : "short";
          const observedSize = toNumber(observed.size);
          const observedAvg = toNumber(observed.avgPrice);
          if (state.position) {
            state = {
              ...state,
              position: {
                ...state.position,
                side: observedSide,
                quantity: observedSize,
                entryPrice: observedAvg || state.position.entryPrice,
              },
            };
            await positionLedger.syncSnapshot(toPersistedTraderSnapshot({
              openPositionSymbol,
              state,
            }));
          }
        }
      }
    }

    const exitReason = getExitReason({
      marketPrice: lastPrice,
      signal: action,
      state,
    });

    // ── Check if a pending limit close order has been filled ─────────────────────
    if (pendingClose && state.position && !config.paperTrading) {
      const pendingOrder = await client.getRealtimeOrder({
        category: config.category,
        symbol: activeSymbol,
        orderLinkId: pendingClose.orderLinkId,
      }).catch(() => null);

      const isFilled = !pendingOrder || pendingOrder.orderStatus === "Filled";
      const isCancelledOrRejected = pendingOrder?.orderStatus === "Cancelled" || pendingOrder?.orderStatus === "Rejected";

      if (isFilled) {
        const fillPrice = pendingOrder?.avgPrice ? toNumber(pendingOrder.avgPrice) : lastPrice;
        lastExecution = { executionMode: "maker-reduce-only", fallbackUsed: false, filled: true, fillPrice };
        const previousState = state;
        const previousPosition = state.position;
        state = updatePaperState({
          action: pendingClose.closeAction,
          leverage: pendingClose.activeLeverage,
          notionalUsd: pendingClose.notionalUsd,
          price: fillPrice,
          previous: state,
          now: Date.now(),
          stopLossBps: config.stopLossBps,
          takeProfitBps: config.takeProfitBps,
          reduceOnly: true,
          feeRoundTripBps: config.feeRoundTripBps,
        });
        openPositionSymbol = null;
        safetyStopPlaced = false;
        entryTick = null;
        // Bandit reward from realized live PnL (user-decision #2).
        const championAtClose = championIdAtEntry;
        if (config.metaEnabled && allocator && championAtClose) {
          const pnlDelta = state.realizedPnlUsd - previousState.realizedPnlUsd;
          allocator = recordClosedTrade(
            allocator,
            championAtClose,
            pnlDelta,
            Date.now(),
            config.metaPnlWindowSize,
          );
        }
        championIdAtEntry = null;
        if (previousPosition) {
          await positionLedger.appendClosedPosition(buildClosedPositionLedgerEntry({
            exitPrice: fillPrice,
            exitReason: pendingClose.exitReason,
            nextState: state,
            previousState,
            previousPosition,
            symbol: activeSymbol,
            feeRoundTripBps: config.feeRoundTripBps,
            championIdAtEntry: championAtClose,
            strategyType: config.strategyType,
          }));
        }
        await positionLedger.syncSnapshot(toPersistedTraderSnapshot({
          openPositionSymbol,
          state,
        }));
        if (pendingClose.exitReason === "stop-loss" || pendingClose.exitReason === "signal-reversal") {
          const POST_LOSS_COOLDOWN_TICKS = Math.ceil(config.minTradeIntervalMs / config.pollMs);
          symbolAvailability.set(activeSymbol, registerTickerFailure({
            cooldownTicks: POST_LOSS_COOLDOWN_TICKS,
            currentTick: ticks,
            state: symbolAvailability.get(activeSymbol),
            threshold: 1,
          }));
        }
        forceLogicalExitForCurrentPosition = false;
        const pnlDelta = state.realizedPnlUsd - previousState.realizedPnlUsd;
        recentOutcomes.push(pnlDelta >= 0 ? "win" : "loss");
        if (recentOutcomes.length > 200) recentOutcomes.shift();
        drawdownVelocityState = recordPnlSample(
          drawdownVelocityState,
          Date.now(),
          state.realizedPnlUsd,
          config.drawdownVelocityWindowMs,
        );
        const verdict = evaluateDrawdownVelocity(drawdownVelocityState, {
          now: Date.now(),
          windowMs: config.drawdownVelocityWindowMs,
          maxDrawdownInWindowUsd: config.drawdownVelocityMaxUsd,
          maxConsecutiveLosses: config.drawdownMaxConsecutiveLosses,
          closedTradeOutcomes: recentOutcomes,
        });
        if (verdict.halted) {
          drawdownHaltUntilMs = Date.now() + drawdownHaltCooldownMs;
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            event: "drawdown-halt",
            reason: verdict.reason,
            cumulativePnlUsd: state.realizedPnlUsd,
            recentOutcomes: recentOutcomes.slice(-10),
            resumeAt: new Date(drawdownHaltUntilMs).toISOString(),
            cooldownMs: drawdownHaltCooldownMs,
          }));
          await alerter.send(`drawdown halt: ${verdict.reason} (resume in ${Math.round(drawdownHaltCooldownMs / 60000)}min)`, {
            cumulativePnlUsd: state.realizedPnlUsd,
          });
        }
        pendingClose = null;
      } else if (isCancelledOrRejected) {
        pendingClose = null; // will resubmit on next tick if exitReason still active
      }
      // else: order still open — skip placement below
    }

    // ── Place close order if position open, exit detected, no pending order ───
    if (state.position && exitReason && !pendingClose) {
      const closeAction: Exclude<StrategySignal, "flat"> =
        state.position.side === "long" ? "short" : "long";
      const closeQty = state.position.quantity.toFixed(
        countDecimals(instrument.lotSizeFilter.qtyStep),
      );

      lastExecution = await executeTrade({
        action: closeAction,
        client,
        config,
        instrument,
        lastPrice,
        symbol: activeSymbol,
        tickerBidPrice: ticker.bid1Price,
        tickerAskPrice: ticker.ask1Price,
        qty: closeQty,
        reduceOnly: true,
      });

      if (lastExecution.filled) {
        // Paper trade or position-already-closed edge case: settle immediately
        const previousState = state;
        const previousPosition = state.position;
        state = updatePaperState({
          action: closeAction,
          leverage: activeLeverage,
          notionalUsd: state.position.notionalUsd,
          price: lastExecution.fillPrice,
          previous: state,
          now: Date.now(),
          stopLossBps: config.stopLossBps,
          takeProfitBps: config.takeProfitBps,
          reduceOnly: true,
          feeRoundTripBps: config.feeRoundTripBps,
        });
        openPositionSymbol = null;
        safetyStopPlaced = false;
        entryTick = null;
        const championAtClose2 = championIdAtEntry;
        if (config.metaEnabled && allocator && championAtClose2) {
          const pnlDelta = state.realizedPnlUsd - previousState.realizedPnlUsd;
          allocator = recordClosedTrade(
            allocator,
            championAtClose2,
            pnlDelta,
            Date.now(),
            config.metaPnlWindowSize,
          );
        }
        championIdAtEntry = null;
        if (previousPosition) {
          await positionLedger.appendClosedPosition(buildClosedPositionLedgerEntry({
            exitPrice: lastExecution.fillPrice,
            exitReason,
            nextState: state,
            previousState,
            previousPosition,
            symbol: activeSymbol,
            feeRoundTripBps: config.feeRoundTripBps,
            championIdAtEntry: championAtClose2,
            strategyType: config.strategyType,
          }));
        }
        await positionLedger.syncSnapshot(toPersistedTraderSnapshot({
          openPositionSymbol,
          state,
        }));
        if (exitReason === "stop-loss" || exitReason === "signal-reversal") {
          const POST_LOSS_COOLDOWN_TICKS = Math.ceil(config.minTradeIntervalMs / config.pollMs);
          symbolAvailability.set(activeSymbol, registerTickerFailure({
            cooldownTicks: POST_LOSS_COOLDOWN_TICKS,
            currentTick: ticks,
            state: symbolAvailability.get(activeSymbol),
            threshold: 1,
          }));
        }
        forceLogicalExitForCurrentPosition = false;
        const pnlDelta2 = state.realizedPnlUsd - previousState.realizedPnlUsd;
        recentOutcomes.push(pnlDelta2 >= 0 ? "win" : "loss");
        if (recentOutcomes.length > 200) recentOutcomes.shift();
        drawdownVelocityState = recordPnlSample(
          drawdownVelocityState,
          Date.now(),
          state.realizedPnlUsd,
          config.drawdownVelocityWindowMs,
        );
        const verdict2 = evaluateDrawdownVelocity(drawdownVelocityState, {
          now: Date.now(),
          windowMs: config.drawdownVelocityWindowMs,
          maxDrawdownInWindowUsd: config.drawdownVelocityMaxUsd,
          maxConsecutiveLosses: config.drawdownMaxConsecutiveLosses,
          closedTradeOutcomes: recentOutcomes,
        });
        if (verdict2.halted) {
          drawdownHaltUntilMs = Date.now() + drawdownHaltCooldownMs;
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            event: "drawdown-halt",
            reason: verdict2.reason,
            cumulativePnlUsd: state.realizedPnlUsd,
            recentOutcomes: recentOutcomes.slice(-10),
            resumeAt: new Date(drawdownHaltUntilMs).toISOString(),
            cooldownMs: drawdownHaltCooldownMs,
          }));
          await alerter.send(`drawdown halt: ${verdict2.reason} (resume in ${Math.round(drawdownHaltCooldownMs / 60000)}min)`, {
            cumulativePnlUsd: state.realizedPnlUsd,
          });
        }
      } else if (lastExecution.orderLinkId) {
        // Limit close order placed — track for fill confirmation
        pendingClose = {
          orderLinkId: lastExecution.orderLinkId,
          exitReason,
          closeAction,
          notionalUsd: state.position.notionalUsd,
          activeLeverage,
        };
      }
    }

    const notionalUsd = computeNotionalUsd(effectiveOrderUsdPreClamp, activeLeverage);
    const risk = evaluateRisk({
      action,
      limits: {
        maxPositionUsd: config.maxPositionUsd,
        maxDailyLossUsd: config.maxDailyLossUsd,
        minTradeIntervalMs: config.minTradeIntervalMs,
        maxSpreadBps: config.maxSpreadBps,
      },
      market: {
        lastPrice,
        markPrice,
      },
      now: Date.now(),
      orderUsd: notionalUsd,
      state,
    });
    const aggressiveRisk = config.tradingProfile === "aggressive-perps"
      ? evaluateAggressivePerpsRisk({
          symbol: activeSymbol,
          leverage: activeLeverage,
          fundingRateBps,
          notionalUsd,
          stopLossBps: config.stopLossBps,
          limits: {
            maxLeverage: config.aggressiveMaxLeverage,
            maxFundingRateBps: config.aggressiveMaxFundingRateBps,
            maxLossPerTradeUsd: config.aggressiveMaxLossPerTradeUsd,
            minEstimatedLiqBufferBps: config.aggressiveMinEstimatedLiqBufferBps,
            allowedSymbols: activeAggressiveAllowedSymbols,
          },
        })
      : { allowed: true as const };

    symbolStatuses.set(activeSymbol, {
      action,
      aggressiveRisk: aggressiveRisk.allowed ? "allowed" : aggressiveRisk.reason,
      error: null,
      fundingRateBps,
      lastPrice,
      netEdgeBps,
      observedAt,
      risk: risk.allowed ? "allowed" : risk.reason,
      spreadBps,
    });

    // ── Candidate verdicts: explain why each ranked symbol is accepted or rejected.
    // Logged only when a symbol's verdict changes, so quiet steady states stay quiet.
    const computeActiveVerdict = (): string => {
      if (state.position && openPositionSymbol === activeSymbol) {
        return "position-already-open";
      }
      if (prices.length < config.slowWindow) {
        return "warmup";
      }
      if (topSetupGateReason) {
        return `top-setup-gate:${topSetupGateReason}`;
      }
      if (scanAction === "flat") {
        return "scanner-no-direction";
      }
      if (config.requireLocalMaConfirmation && localSignal === "flat") {
        return `local-MA-flat:scanner=${scanAction}`;
      }
      if (config.requireLocalMaConfirmation && action !== localSignal) {
        return `signal-disagreement:scanner=${scanAction},localMA=${localSignal}`;
      }
      if (fundingBlocked) {
        return `funding-blocked:${fundingRateBps.toFixed(2)}bps`;
      }
      if (entryAction === "flat") {
        return "signal-flat";
      }
      if (!risk.allowed) {
        return `risk:${risk.reason}`;
      }
      if (!aggressiveRisk.allowed) {
        return `aggressive-risk:${(aggressiveRisk as { reason: string }).reason}`;
      }
      if (haltEntriesUntilCleared) {
        return "halted-by-position-drift";
      }
      if (Date.now() < drawdownHaltUntilMs) {
        return "halted-by-drawdown";
      }
      return "entry-attempted";
    };

    // Increment cumulative counter for the active-symbol verdict (split into category).
    const activeVerdictRaw = computeActiveVerdict();
    const activeVerdictCategory = activeVerdictRaw.split(":")[0] ?? activeVerdictRaw;
    activeVerdictCounts.set(activeVerdictCategory, (activeVerdictCounts.get(activeVerdictCategory) ?? 0) + 1);

    for (const symbol of rankedSymbols) {
      let verdict: string;
      if (symbol === activeSymbol) {
        verdict = `active:${activeVerdictRaw}`;
      } else if (isSymbolInTickerCooldown({ currentTick: ticks, state: symbolAvailability.get(symbol) })) {
        verdict = "ticker-cooldown";
      } else if (
        config.tradingProfile === "aggressive-perps"
        && config.aggressiveAllowedSymbols.length > 0
        && !config.aggressiveAllowedSymbols.includes(symbol)
      ) {
        verdict = "not-whitelisted";
      } else if (
        config.tradeCandidateSymbols.length > 0
        && !config.tradeCandidateSymbols.includes(symbol)
      ) {
        verdict = "not-in-trade-candidates";
      } else {
        verdict = `ranked-not-top:active=${activeSymbol}`;
      }
      const previous = lastVerdictBySymbol.get(symbol);
      if (verdict !== previous) {
        const setup = resolvedRankedSetups.find((s) => s.symbol === symbol);
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          event: "candidate-verdict",
          symbol,
          verdict,
          previous: previous ?? null,
          score: setup?.score ?? null,
          netEdgeBps: setup?.netEdgeBps ?? null,
          scanAction: setup?.action ?? null,
        }));
        lastVerdictBySymbol.set(symbol, verdict);
      }
    }

    // Auto-clear drawdown halt + reset recent outcomes once the cooldown expires.
    if (drawdownHaltUntilMs > 0 && Date.now() >= drawdownHaltUntilMs) {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        event: "drawdown-halt-cleared",
        priorOutcomes: recentOutcomes.slice(-10),
      }));
      drawdownHaltUntilMs = 0;
      recentOutcomes.length = 0;
    }
    if (entryAction !== "flat" && !state.position && risk.allowed && aggressiveRisk.allowed && !haltEntriesUntilCleared && Date.now() >= drawdownHaltUntilMs) {
      const qty = toOrderQty({
        instrument,
        notionalUsd,
        price: lastPrice,
      });

      if (!config.paperTrading) {
        const liveLeverage = configuredLiveLeverageBySymbol.get(activeSymbol);
        if (
          (config.category === "linear" || config.category === "inverse") &&
          liveLeverage !== activeLeverage
        ) {
          await client.setLeverage({
            category: config.category,
            symbol: activeSymbol,
            buyLeverage: activeLeverage.toString(),
            sellLeverage: activeLeverage.toString(),
          });
          configuredLiveLeverageBySymbol.set(activeSymbol, activeLeverage);
        }
      }
      lastExecution = await executeTrade({
        action: entryAction as Exclude<StrategySignal, "flat">,
        client,
        config,
        instrument,
        lastPrice,
        symbol: activeSymbol,
        tickerBidPrice: ticker.bid1Price,
        tickerAskPrice: ticker.ask1Price,
        qty,
      });

      const entryExecution = lastExecution;
      if (entryExecution && entryExecution.filled) {
        state = updatePaperState({
          action: entryAction as Exclude<StrategySignal, "flat">,
          leverage: activeLeverage,
          notionalUsd,
          price: entryExecution.fillPrice,
          previous: state,
          now: Date.now(),
          stopLossBps: effectiveStopLossBps,
          takeProfitBps: effectiveTakeProfitBps,
        });
        openPositionSymbol = activeSymbol;
        entryTick = ticks;
        championIdAtEntry = championId;
        // Exchange-native SL/TP for live mode (user-decision #2).
        if (!config.paperTrading && config.exitPolicyMode === "exchange-native" && state.position) {
          const decimals = countDecimals(instrument.priceFilter.tickSize);
          const slPrice = state.position.stopLossPrice.toFixed(decimals);
          const tpPrice = state.position.takeProfitPrice.toFixed(decimals);
          const ok = await trySetTradingStop({
            client,
            request: {
              category: config.category,
              symbol: activeSymbol,
              stopLoss: slPrice,
              takeProfit: tpPrice,
              positionIdx: resolvePositionIdx({ side: state.position.side, positionMode: config.bybitPositionMode }),
            },
            retryMax: config.setTradingStopRetryMax,
            retryDelayMs: config.setTradingStopRetryDelayMs,
            alertHook: alerter,
          });
          if (!ok) {
            // Fall back to logical exit for this position.
            forceLogicalExitForCurrentPosition = true;
            console.log(JSON.stringify({
              ts: new Date().toISOString(),
              event: "exchange-native-stop-fallback-to-logical",
              symbol: activeSymbol,
            }));
          }
        }
        await positionLedger.syncSnapshot(toPersistedTraderSnapshot({
          openPositionSymbol,
          state,
        }));
      }
    }

    // ── Delayed safety stop (logical mode only) ─────────────────────────
    const effectiveExitMode = forceLogicalExitForCurrentPosition ? "logical" : config.exitPolicyMode;
    if (state.position && entryTick !== null && !safetyStopPlaced && effectiveExitMode === "logical" && !config.paperTrading) {
      const ticksSinceEntry = ticks - entryTick;
      const safetyDelayTicks = Math.ceil(config.exitPolicySafetyDelayMs / config.pollMs);
      if (ticksSinceEntry >= safetyDelayTicks) {
        const safetyStopPrice = state.position.side === "long"
          ? lastPrice * (1 - config.exitPolicySafetyStopBps / 10000)
          : lastPrice * (1 + config.exitPolicySafetyStopBps / 10000);
        const decimals = countDecimals(instrument.priceFilter.tickSize);
        const safetyStopPriceStr = safetyStopPrice.toFixed(decimals);
        await trySetTradingStop({
          client,
          request: {
            category: config.category,
            symbol: activeSymbol,
            stopLoss: safetyStopPriceStr,
            positionIdx: resolvePositionIdx({ side: state.position.side, positionMode: config.bybitPositionMode }),
          },
          retryMax: config.setTradingStopRetryMax,
          retryDelayMs: config.setTradingStopRetryDelayMs,
          alertHook: alerter,
        });
        console.log(JSON.stringify({
          action: "safety-stop",
          side: state.position.side,
          entryPrice: state.position.entryPrice,
          safetyStopPrice: safetyStopPriceStr,
          exitPolicySafetyStopBps: config.exitPolicySafetyStopBps,
          ticksSinceEntry,
        }));
        safetyStopPlaced = true;
      }
    }

    // ── Trailing stop ────────────────────────────────────────────────────────
    if (state.position && config.trailingStopEnabled) {
      const trail = computeTrailingStop({
        position: state.position,
        marketPrice: lastPrice,
        activationBps: config.trailingStopActivationBps,
        trailBps: config.trailingStopTrailBps,
      });
      if (trail.newStopLossPrice !== null && trail.newStopLossPrice !== state.position.stopLossPrice) {
        const oldStop = state.position.stopLossPrice;
        const newStop = trail.newStopLossPrice;
        const useExchangeNative =
          !config.paperTrading
          && config.exitPolicyMode === "exchange-native"
          && !forceLogicalExitForCurrentPosition;
        let applied = false;
        if (useExchangeNative) {
          const decimals = countDecimals(instrument.priceFilter.tickSize);
          applied = await trySetTradingStop({
            client,
            request: {
              category: config.category,
              symbol: activeSymbol,
              stopLoss: newStop.toFixed(decimals),
              positionIdx: resolvePositionIdx({ side: state.position.side, positionMode: config.bybitPositionMode }),
            },
            retryMax: config.setTradingStopRetryMax,
            retryDelayMs: config.setTradingStopRetryDelayMs,
            alertHook: alerter,
          });
          if (!applied) {
            forceLogicalExitForCurrentPosition = true;
          }
        }
        if (applied || !useExchangeNative) {
          state = {
            ...state,
            position: { ...state.position, stopLossPrice: newStop },
          };
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            event: "trailing-stop-updated",
            symbol: activeSymbol,
            oldStop,
            newStop,
            marketPrice: lastPrice,
          }));
        }
      }
    }

    const intent = exitReason
      ? "close"
      : action === "long"
        ? "open-long"
        : action === "short"
          ? "open-short"
          : "no-entry";
    const intentReason = exitReason
      ? exitReason
      : state.position
        ? "position-open"
        : topSetupGateReason
          ? topSetupGateReason
        : !risk.allowed
          ? risk.reason
          : !aggressiveRisk.allowed
            ? aggressiveRisk.reason
            : lastExecution?.filled === false
              ? "entry-not-filled"
              : "ready";

    const runtimeArtifactPath = await persistRuntimeArtifact({
      activeSymbol,
      candidateSymbols: rankedSymbols,
      rankedSymbols,
      rankedSetupsTop: summarizeTopRankedSetups(resolvedRankedSetups),
      openPositionSymbol,
      perSymbol: Object.fromEntries(rankedSymbols.map((symbol) => {
        const pricesForSymbol = priceHistoryBySymbol.get(symbol) ?? [];
        const status = symbolStatuses.get(symbol);
        return [symbol, {
          action: status?.action ?? "unobserved",
          aggressiveRisk: status?.aggressiveRisk ?? "unobserved",
          error: status?.error ?? null,
          fundingRateBps: status?.fundingRateBps ?? null,
          lastPrice: status?.lastPrice ?? null,
          netEdgeBps: status?.netEdgeBps ?? null,
          observedAt: status?.observedAt ?? null,
          risk: status?.risk ?? "unobserved",
          spreadBps: status?.spreadBps ?? null,
          pricePoints: pricesForSymbol.length,
        }];
      })),
      scanGate: scanGate.reason,
      scanGateGeneratedAt: scanGate.generatedAt,
      tradingProfile: config.tradingProfile,
      marketScanGate: marketScanGate.reason,
      marketScanGateGeneratedAt: marketScanGate.generatedAt,
    });

    // Build a signature that captures "material state" — emit verbose only when it changes
    // OR every verboseHeartbeatTicks. Compact one-liner otherwise.
    const positionKey = state.position ? `${state.position.side}@${state.position.entryPrice}` : "flat";
    const riskKey = risk.allowed ? "ok" : risk.reason;
    const aggRiskKey = aggressiveRisk.allowed ? "ok" : aggressiveRisk.reason;
    const tickSignature = `${activeSymbol}|${action}|${intent}|${positionKey}|${riskKey}|${aggRiskKey}|${championId ?? "-"}|${exitReason ?? "-"}`;
    const isMaterialChange = tickSignature !== lastTickSignature;
    const isHeartbeat = ticks % verboseHeartbeatTicks === 0;

    if (isMaterialChange || isHeartbeat) {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        event: "tick",
        symbol: activeSymbol,
        activeSymbolReason,
        rankedSetupsTop: summarizeTopRankedSetups(resolvedRankedSetups),
        lastPrice,
        markPrice,
        action,
        intent,
        intentReason,
        scanScore: activeSetup?.score ?? null,
        scanNetEdgeBps: activeSetup?.netEdgeBps ?? null,
        leverage: activeLeverage,
        effectiveOrderUsd: effectiveOrderUsdPreClamp,
        confidenceMultiplier,
        championId,
        championReason,
        walletAvailableUsd: walletSizing.walletAvailableUsd,
        leverageDecision: leverageDecision.reason,
        lastExecution,
        fundingRateBps,
        realizedPnlUsd: state.realizedPnlUsd,
        exitReason,
        risk: riskKey,
        aggressiveRisk: aggRiskKey,
        position: state.position,
        mode: config.paperTrading ? "paper" : "live",
        entryAction,
        localSignal,
        verdictCounts: Object.fromEntries(activeVerdictCounts),
        totalTicks: ticks + 1,
      }));
      lastTickSignature = tickSignature;
    } else if (ticks - lastQuietLogTick >= quietHeartbeatTicks) {
      // Compact heartbeat throttled to once every quietHeartbeatTicks (default 30).
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        event: "tick-quiet",
        symbol: activeSymbol,
        lastPrice,
        action,
        position: state.position ? state.position.side : null,
        pnl: Number(state.realizedPnlUsd.toFixed(4)),
      }));
      lastQuietLogTick = ticks;
    }

    // Persist allocator state on cadence (runtimeArtifactFlushTicks).
    if (
      config.metaEnabled
      && allocator
      && ticks - lastAllocatorFlushTick >= config.runtimeArtifactFlushTicks
    ) {
      await persistAllocatorState({
        allocator,
        variantStates: Object.fromEntries(perVariantStates.entries()),
        lastTickAt: Date.now(),
      });
      lastAllocatorFlushTick = ticks;
    }

    ticks += 1;
    await sleep(config.pollMs);
  }
  } finally {
    process.off("SIGINT", onShutdownSignal);
    process.off("SIGTERM", onShutdownSignal);
    if (config.metaEnabled && config.strategyType === "ma-crossover" && allocator) {
      await persistAllocatorState({
        allocator,
        variantStates: Object.fromEntries(perVariantStates.entries()),
        lastTickAt: Date.now(),
      }).catch(() => {});
    }
    if (stopRequested && state.position && !config.paperTrading) {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        event: "shutdown-with-open-position",
        symbol: openPositionSymbol,
        side: state.position.side,
        quantity: state.position.quantity,
        note: "live position left open; reconcile manually before next start",
      }));
      await alerter.send(
        `shutdown with open position: ${openPositionSymbol} ${state.position.side} qty=${state.position.quantity}`,
        { symbol: openPositionSymbol, side: state.position.side, quantity: state.position.quantity },
      ).catch(() => {});
    }
    await positionLedger.close();
    releaseSessionLock();
  }
}
