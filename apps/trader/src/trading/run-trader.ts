import {
  createBybitClient,
  type CreateOrderRequest,
  type InstrumentInfo,
  type PositionInfo,
  type RealtimeOrder,
} from "@ai-scalper/bybit-client";
import { mkdir } from "node:fs/promises";
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
    let cachedRankedSetups: RankedTradeSetup[] = [];
    let lastScanAt = 0;
    let lastScanGeneratedAt: string | null = null;

    // ── Meta-bandit setup (only when META_ENABLED) ──────────────────────────
    if (config.metaEnabled) {
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
    if (config.metaEnabled && allocator && pool.length > 0) {
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
        if (config.metaEnabled && allocator && championIdAtEntry) {
          const pnlDelta = state.realizedPnlUsd - previousState.realizedPnlUsd;
          allocator = recordClosedTrade(
            allocator,
            championIdAtEntry,
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
        if (config.metaEnabled && allocator && championIdAtEntry) {
          const pnlDelta = state.realizedPnlUsd - previousState.realizedPnlUsd;
          allocator = recordClosedTrade(
            allocator,
            championIdAtEntry,
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
    if (config.metaEnabled && allocator) {
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
