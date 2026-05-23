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
  buildSignal,
  evaluateAggressivePerpsRisk,
  evaluateRisk,
  getExitReason,
  selectLeverageForOpportunity,
  updatePaperState,
  type StrategySignal,
  type TraderState,
} from "@ai-scalper/trading-core";
import {
  rankTradeSetups,
  readScanConfig,
  type RankedTradeSetup,
} from "@ai-scalper/market-scanner";
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
}): ClosedPositionLedgerEntry {
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
    realizedPnlUsd: params.nextState.realizedPnlUsd - params.previousState.realizedPnlUsd,
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

export async function runTrader(config: TraderConfig): Promise<void> {
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
  let state: TraderState = {
    lastTradeAt: null,
    realizedPnlUsd: 0,
    position: null,
  };
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

    while (config.maxTicks === 0 || ticks < config.maxTicks) {
      const observedAt = new Date().toISOString();
      if ((Date.now() - lastScanAt) >= config.tradeScanRefreshMs || cachedRankedSetups.length === 0) {
        cachedRankedSetups = await rankTradeSetups(scanConfig);
        lastScanAt = Date.now();
        lastScanGeneratedAt = observedAt;

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

    const activeSymbol: string = openPositionSymbol ?? candidateSymbols[0] ?? config.symbol;
    const activeSymbolReason = openPositionSymbol
      ? "open-position"
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
    const baseLeverage = clampLeverage(config.leverage, instrument);
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
      minNetEdgeBps: config.tradeMinSetupNetEdgeBps,
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
    const entryAction: StrategySignal = action !== "flat" && action === localSignal && !fundingBlocked ? action : "flat";
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
        });
        openPositionSymbol = null;
        safetyStopPlaced = false;
        entryTick = null;
        if (previousPosition) {
          await positionLedger.appendClosedPosition(buildClosedPositionLedgerEntry({
            exitPrice: fillPrice,
            exitReason: pendingClose.exitReason,
            nextState: state,
            previousState,
            previousPosition,
            symbol: activeSymbol,
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
        });
        openPositionSymbol = null;
        safetyStopPlaced = false;
        entryTick = null;
        if (previousPosition) {
          await positionLedger.appendClosedPosition(buildClosedPositionLedgerEntry({
            exitPrice: lastExecution.fillPrice,
            exitReason,
            nextState: state,
            previousState,
            previousPosition,
            symbol: activeSymbol,
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

    const notionalUsd = computeNotionalUsd(effectiveOrderUsd, activeLeverage);
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

    if (entryAction !== "flat" && !state.position && risk.allowed && aggressiveRisk.allowed) {
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
          stopLossBps: config.stopLossBps,
          takeProfitBps: config.takeProfitBps,
        });
        openPositionSymbol = activeSymbol;
        entryTick = ticks;
        await positionLedger.syncSnapshot(toPersistedTraderSnapshot({
          openPositionSymbol,
          state,
        }));
      }
    }

    // ── Delayed safety stop (logical mode only) ─────────────────────────
    if (state.position && entryTick !== null && !safetyStopPlaced && config.exitPolicyMode === "logical" && !config.paperTrading) {
      const ticksSinceEntry = ticks - entryTick;
      const safetyDelayTicks = Math.ceil(config.exitPolicySafetyDelayMs / config.pollMs);
      if (ticksSinceEntry >= safetyDelayTicks) {
        const safetyStopPrice = state.position.side === "long"
          ? lastPrice * (1 - config.exitPolicySafetyStopBps / 10000)
          : lastPrice * (1 + config.exitPolicySafetyStopBps / 10000);
        const decimals = countDecimals(instrument.priceFilter.tickSize);
        const safetyStopPriceStr = safetyStopPrice.toFixed(decimals);
        await client.setTradingStop({
          category: config.category,
          symbol: activeSymbol,
          stopLoss: safetyStopPriceStr,
          positionIdx: state.position.side === "long" ? 1 : 2,
        }).catch((err: Error) => {
          console.log(`[safetyStop] failed: ${err.message}`);
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

    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      symbol: activeSymbol,
      activeSymbolReason,
      candidateSymbols: rankedSymbols,
      rankedSymbols,
      rankedSetupsTop: summarizeTopRankedSetups(resolvedRankedSetups),
      lastPrice,
      markPrice,
      ticks: prices.length,
      action,
      intent,
      intentReason,
      scanScore: activeSetup?.score ?? null,
      scanNetEdgeBps: activeSetup?.netEdgeBps ?? null,
      scanTrendBps: activeSetup?.trendBps ?? null,
      leverage: activeLeverage,
      baseLeverage,
      effectiveOrderUsd,
      walletAvailableUsd: walletSizing.walletAvailableUsd,
      walletSizingReason: walletSizing.reason,
      leverageDecision: leverageDecision.reason,
      exceptionalLeverage: leverageDecision.exceptional,
      entryExecutionMode: config.entryExecutionMode,
      lastExecution,

      tradingProfile: config.tradingProfile,
      marketScanGate: marketScanGate.reason,
      marketScanGateGeneratedAt: marketScanGate.generatedAt,
      scanGate: scanGate.reason,
      scanGateGeneratedAt: scanGate.generatedAt,
      ...maybeAggressiveLogFields(config, activeAggressiveAllowedSymbols),
      fundingRateBps,
      realizedPnlUsd: state.realizedPnlUsd,
      exitReason,
      risk: risk.allowed ? "allowed" : risk.reason,
      aggressiveRisk: aggressiveRisk.allowed ? "allowed" : aggressiveRisk.reason,
      position: state.position,
      mode: config.paperTrading ? "paper" : "live",
      runtimeArtifactPath,
    }));

    ticks += 1;
    await sleep(config.pollMs);
  }
  } finally {
    await positionLedger.close();
  }
}
