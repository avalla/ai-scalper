import {
  createBybitClient,
  type CreateOrderRequest,
  type InstrumentInfo,
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
import type { TraderConfig } from "../config";
import { buildEntryExecutionPlan } from "./execution-policy";
import { loadRecentScanCandidatesFromMany } from "./load-scan-candidates";
import {
  resolveCandidateSymbols,
  selectActiveSymbol,
  type SymbolRuntimeMetrics,
} from "./select-active-symbol";

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
}> {
  if (params.reduceOnly || params.config.entryExecutionMode === "taker") {
    const request: CreateOrderRequest = {
      category: params.config.category,
      symbol: params.symbol,
      side: toOrderSide(params.action),
      qty: params.qty,
      orderType: "Market",
      reduceOnly: params.reduceOnly,
      closeOnTrigger: params.reduceOnly,
      slippageToleranceType: "Percent",
      slippageTolerance: params.config.slippageTolerancePercent.toString(),
    };

    if (!params.config.paperTrading) {
      await params.client.createOrder(request);
    }

    return {
      executionMode: params.reduceOnly ? "taker-reduce-only" : "taker",
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

async function persistRuntimeArtifact(payload: {
  activeSymbol: string;
  candidateSymbols: string[];
  rankedSymbols: string[];
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

export async function runTrader(config: TraderConfig): Promise<void> {
  const client = createBybitClient();
  const instrumentCache = new Map<string, InstrumentInfo>();
  const configuredLiveLeverageBySymbol = new Map<string, number>();
  const priceHistoryBySymbol = new Map<string, number[]>();
  const symbolMetrics = new Map<string, SymbolRuntimeMetrics>();
  const symbolStatuses = new Map<string, {
    action: StrategySignal;
    aggressiveRisk: string;
    fundingRateBps: number;
    lastPrice: number;
    netEdgeBps: number;
    observedAt: string;
    risk: string;
    spreadBps: number;
  }>();
  let ticks = 0;
  let openPositionSymbol: string | null = null;
  let lastExecution: {
    executionMode: string;
    fallbackUsed: boolean;
    filled: boolean;
    fillPrice: number;
  } | null = null;
  let state: TraderState = {
    lastTradeAt: null,
    realizedPnlUsd: 0,
    position: null,
  };

  while (config.maxTicks === 0 || ticks < config.maxTicks) {
    const scanGate = config.tradingProfile === "aggressive-perps" && config.aggressiveRequireScanCandidate
      ? await loadRecentScanCandidatesFromMany({
          artifactPaths: [
            config.aggressiveScanCandidatesPath,
            config.aggressiveScanLatestPath,
          ],
          maxAgeMinutes: config.aggressiveScanMaxAgeMinutes,
        })
      : {
          allowedSymbols: config.aggressiveAllowedSymbols,
          reason: "ok" as const,
          generatedAt: null,
        };
    const activeAggressiveAllowedSymbols = config.tradingProfile === "aggressive-perps" && config.aggressiveRequireScanCandidate
      ? config.aggressiveAllowedSymbols.filter((symbol) => scanGate.allowedSymbols.includes(symbol))
      : config.aggressiveAllowedSymbols;
    const candidateSymbols = resolveCandidateSymbols({
      configuredSymbol: config.symbol,
      tradeCandidateSymbols: config.tradeCandidateSymbols,
      scanCandidateSymbols: scanGate.reason === "ok" ? scanGate.allowedSymbols : [],
    });
    const tradableCandidateSymbols = config.tradingProfile === "aggressive-perps"
      ? candidateSymbols.filter((symbol) => activeAggressiveAllowedSymbols.includes(symbol))
      : candidateSymbols;
    const symbolSelection = selectActiveSymbol({
      candidateSymbols: tradableCandidateSymbols,
      fallbackSymbol: candidateSymbols[0] ?? config.symbol,
      openPositionSymbol,
      rotationTick: ticks,
      symbolMetrics: Object.fromEntries(symbolMetrics),
    });
    const activeSymbol = symbolSelection.symbol;
    const instrument = await getInstrument({
      cache: instrumentCache,
      category: config.category,
      client,
      symbol: activeSymbol,
    });
    const baseLeverage = clampLeverage(config.leverage, instrument);
    const ticker = await client.getTicker({
      category: config.category,
      symbol: activeSymbol,
    });
    const lastPrice = toNumber(ticker.lastPrice);
    const markPrice = toNumber(ticker.markPrice);
    const fundingRateBps = toNumber(ticker.fundingRate) * 10_000;
    const spreadBps = Math.abs(((lastPrice - markPrice) / markPrice) * 10_000);

    const prices = getPriceHistory({
      priceHistoryBySymbol,
      symbol: activeSymbol,
    });
    prices.push(lastPrice);
    if (prices.length > config.slowWindow) {
      prices.shift();
    }

    const action = buildSignal({
      prices,
      fastWindow: config.fastWindow,
      slowWindow: config.slowWindow,
      thresholdBps: config.thresholdBps,
    });
    const hourlyMoveBps = Math.abs(((lastPrice - toNumber(ticker.prevPrice1h)) / toNumber(ticker.prevPrice1h)) * 10_000);
    const minuteRangeBps = Math.max(config.takeProfitBps, config.stopLossBps);
    const netEdgeBps = minuteRangeBps - (config.stopLossBps / 2) - spreadBps;
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

    if (state.position && exitReason) {
      const closeAction: Exclude<StrategySignal, "flat"> =
        state.position.side === "long" ? "short" : "long";
      const closeQty = state.position.quantity.toFixed(
        countDecimals(instrument.lotSizeFilter.qtyStep),
      );

      if (!config.paperTrading) {
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
      } else {
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
      }

      const closeExecution = lastExecution;
      state = updatePaperState({
        action: closeAction,
        leverage: activeLeverage,
        notionalUsd: state.position.notionalUsd,
        price: closeExecution.fillPrice,
        previous: state,
        now: Date.now(),
        stopLossBps: config.stopLossBps,
        takeProfitBps: config.takeProfitBps,
        reduceOnly: true,
      });
      openPositionSymbol = null;
    }

    const notionalUsd = computeNotionalUsd(config.orderUsd, activeLeverage);
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
    const observedAt = new Date().toISOString();

    symbolMetrics.set(activeSymbol, {
      hourlyMoveBps,
      netEdgeBps,
      spreadBps,
      fundingRateBps,
      observedAt,
    });
    symbolStatuses.set(activeSymbol, {
      action,
      aggressiveRisk: aggressiveRisk.allowed ? "allowed" : aggressiveRisk.reason,
      fundingRateBps,
      lastPrice,
      netEdgeBps,
      observedAt,
      risk: risk.allowed ? "allowed" : risk.reason,
      spreadBps,
    });

    if (action !== "flat" && !state.position && risk.allowed && aggressiveRisk.allowed) {
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
        action,
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
          action,
          leverage: activeLeverage,
          notionalUsd,
          price: entryExecution.fillPrice,
          previous: state,
          now: Date.now(),
          stopLossBps: config.stopLossBps,
          takeProfitBps: config.takeProfitBps,
        });
        openPositionSymbol = activeSymbol;
      }
    }

    const runtimeArtifactPath = await persistRuntimeArtifact({
      activeSymbol,
      candidateSymbols: tradableCandidateSymbols.length > 0 ? tradableCandidateSymbols : candidateSymbols,
      rankedSymbols: symbolSelection.rankedSymbols,
      openPositionSymbol,
      perSymbol: Object.fromEntries((tradableCandidateSymbols.length > 0 ? tradableCandidateSymbols : candidateSymbols).map((symbol) => {
        const pricesForSymbol = priceHistoryBySymbol.get(symbol) ?? [];
        const status = symbolStatuses.get(symbol);
        return [symbol, {
          action: status?.action ?? "unobserved",
          aggressiveRisk: status?.aggressiveRisk ?? "unobserved",
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
    });

    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      symbol: activeSymbol,
      activeSymbolReason: symbolSelection.reason,
      candidateSymbols: tradableCandidateSymbols.length > 0 ? tradableCandidateSymbols : candidateSymbols,
      rankedSymbols: symbolSelection.rankedSymbols,
      lastPrice,
      markPrice,
      ticks: prices.length,
      action,
      leverage: activeLeverage,
      baseLeverage,
      leverageDecision: leverageDecision.reason,
      exceptionalLeverage: leverageDecision.exceptional,
      entryExecutionMode: config.entryExecutionMode,
      lastExecution,
      tradingProfile: config.tradingProfile,
      scanGate: scanGate.reason,
      scanGateGeneratedAt: scanGate.generatedAt,
      aggressiveAllowedSymbols: activeAggressiveAllowedSymbols,
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
}
