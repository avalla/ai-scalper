import { describe, expect, test } from "bun:test";
import type { TraderConfig } from "../config";
import type { StrategyEvaluateJobData, TradingAgentJobData } from "@ai-scalper/queueing";
import type { StrategySharedState } from "../strategies/shared/bullmq-shared-state";
import { processStrategyEvaluateTick } from "./strategy-evaluate-processor";
import { processTradingAgentExecute } from "./trading-agent-processor";
import { PILOT_ADAPTERS, PILOT_EVALUATORS } from "./pilots";

const NOW = 1_700_000_000_000;
const NEXT_FUNDING = NOW + 3 * 60_000; // 3 min ahead → inside 5-min entry window

function makeConfig(overrides: Partial<TraderConfig> = {}): TraderConfig {
  return {
    ...({
      symbol: "BTCUSDT", pollMs: 5_000, paperTrading: true,
      leverage: 5, orderUsd: 100,
      fundingArbMinAbsRateBps: 5, fundingArbEntryWindowMinutesBefore: 5,
      fundingArbExitDelayMinutesAfter: 2, fundingArbMaxLeverage: 5, fundingArbMaxNotionalUsd: 100,
      basisArbEntryThresholdBps: 8, basisArbExitThresholdBps: 2,
      basisArbMaxNotionalUsd: 100, basisArbMaxHoldMinutes: 240,
      basisArbLeverage: 1, basisArbSpreadDivergenceStopBps: 0,
      calendarLeverage: 1, calendarSpreadDivergenceStopBps: 0,
      longerTfKlineInterval: "15", longerTfKlineRefreshSec: 60,
      longerTfFastWindow: 3, longerTfSlowWindow: 5, longerTfThresholdBps: 0,
      longerTfStopLossBps: 50, longerTfTakeProfitBps: 150,
      calendarPerpSymbol: "BTCUSDT", calendarDatedSymbol: "BTC-26SEP25",
      calendarDatedDeliveryAt: NOW + 30 * 24 * 3_600_000,
      calendarEntryThresholdBps: 30, calendarExitThresholdBps: 5,
      calendarPreSettlementCloseHours: 24, calendarMaxNotionalUsdPerLeg: 200, calendarPollSec: 60,
    } as unknown as TraderConfig),
    ...overrides,
  };
}

function makeShared(opts: { hasActive?: boolean } = {}): StrategySharedState {
  return {
    async hasActivePosition() { return opts.hasActive ?? false; },
    async getActivePositionCount() { return opts.hasActive ? 1 : 0; },
    async setLastCutLossAt() {}, async getLastCutLossAt() { return 0; },
    async getCooldownRemainingMs() { return 0; },
    async setLastTradeAt() {}, async getLastTradeAt() { return 0; },
  } as any;
}

function makeClient(opts: { fundingRate?: string; perpPrice?: string; spotPrice?: string } = {}): any {
  return {
    async getTicker(p: any) {
      const linear = (p?.category ?? "linear") === "linear";
      const last = linear ? (opts.perpPrice ?? "50100") : (opts.spotPrice ?? "50000");
      // Provide bid1/ask1 around lastPrice for the maker-execution helper.
      const lastN = Number(last);
      return {
        lastPrice: last,
        bid1Price: String(lastN - 0.5),
        ask1Price: String(lastN + 0.5),
        fundingRate: opts.fundingRate ?? "0.001", // 10 bps
        nextFundingTime: String(NEXT_FUNDING),
      };
    },
    async getInstrumentInfo() { return { lotSizeFilter: { qtyStep: "0.001", minOrderQty: "0.001" } }; },
    async getKlines() {
      // ascending closes 100..115 (oldest-first) → long MA crossover; Bybit is newest-first
      const closes = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115];
      return { list: closes.slice().reverse().map((c) => ["0", "0", String(c + 1), String(c - 1), String(c), "0"]) };
    },
    async createOrder() {}, async setLeverage() {},
  };
}

function makeTickerSource(client: any): any {
  return { getTicker: (s: string, o: any) => client.getTicker({ ...o, symbol: s }), peek() { return null; } };
}

const evalDeps = (overrides: any = {}) => {
  const client = overrides.client ?? makeClient();
  const enqueued: TradingAgentJobData[] = [];
  return {
    enqueued,
    deps: {
      config: makeConfig(overrides.config),
      client,
      tickerSource: makeTickerSource(client),
      registry: PILOT_EVALUATORS as any,
      intentQueue: { async add(_n: string, d: TradingAgentJobData) { enqueued.push(d); return null; } },
      log: () => {}, now: () => NOW,
      ...overrides.deps,
    },
  };
};

describe("processStrategyEvaluateTick", () => {
  test("funding-arb evaluate emits a short intent and enqueues a trading-agent job", async () => {
    const { enqueued, deps } = evalDeps();
    const job: StrategyEvaluateJobData = { strategy: "funding-arb", triggeredAt: "x", configFile: "x" };
    const r = await processStrategyEvaluateTick(job, deps);
    expect(r.status).toBe("evaluated");
    if (r.status === "evaluated") expect(r.intentCount).toBe(1);
    expect(enqueued).toHaveLength(1);
    const intent = enqueued[0]!.intent;
    expect(intent.strategy).toBe("funding-arb");
    expect(intent.legs[0]!.side).toBe("short"); // positive funding → short
    expect(intent.legs).toHaveLength(1);
    expect(intent.managePayload.fundingTimeTarget).toBe(NEXT_FUNDING);
  });

  test("basis-arb evaluate emits a two-leg intent when basis exceeds threshold", async () => {
    const { enqueued, deps } = evalDeps();
    const job: StrategyEvaluateJobData = { strategy: "basis-arb", triggeredAt: "x", configFile: "x" };
    const r = await processStrategyEvaluateTick(job, deps);
    expect(r.status).toBe("evaluated");
    expect(enqueued).toHaveLength(1);
    const intent = enqueued[0]!.intent;
    expect(intent.legs).toHaveLength(2);
    expect(intent.legs.find((l) => l.category === "linear")!.side).toBe("short"); // +basis → short perp
    expect(intent.legs.find((l) => l.category === "spot")!.side).toBe("long");
  });

  test("calendar-spread leverage scales qty linearly (5x leverage → 5x qty, same margin)", async () => {
    const calClient: any = {
      async getTicker(p: any) { return { lastPrice: p.symbol === "BTCUSDT" ? "50000" : "50300" }; },
      async getInstrumentInfo() { return { lotSizeFilter: { qtyStep: "0.0001", minOrderQty: "0.0001" } }; },
      async createOrder() {}, async setLeverage() {},
    };
    const { enqueued: e1, deps: d1 } = evalDeps({ client: calClient, config: { calendarLeverage: 1 } });
    await processStrategyEvaluateTick({ strategy: "calendar-spread", triggeredAt: "x", configFile: "x" }, d1);
    const { enqueued: e5, deps: d5 } = evalDeps({ client: calClient, config: { calendarLeverage: 5 } });
    await processStrategyEvaluateTick({ strategy: "calendar-spread", triggeredAt: "x", configFile: "x" }, d5);
    expect(e1).toHaveLength(1); expect(e5).toHaveLength(1);
    const qty1 = e1[0]!.intent.legs[0]!.qty;
    const qty5 = e5[0]!.intent.legs[0]!.qty;
    expect(qty5 / qty1).toBeCloseTo(5, 1);
    expect(e5[0]!.intent.leverage).toBe(5);
  });

  test("basis-arb rejects an implausible basis (data-integrity guard)", async () => {
    // perp 99067, spot 74310 → ~3331 bps basis (the corrupt tick seen in paper run)
    const badClient = makeClient({ perpPrice: "99067.9", spotPrice: "74310" });
    const { enqueued, deps } = evalDeps({ client: badClient });
    const r = await processStrategyEvaluateTick({ strategy: "basis-arb", triggeredAt: "x", configFile: "x" }, deps);
    expect(r.status).toBe("evaluated");
    if (r.status === "evaluated") expect(r.intentCount).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  test("intent jobs are enqueued with removeOnComplete/Fail so re-entry isn't blocked", async () => {
    const opts: any[] = [];
    const deps = evalDeps().deps;
    deps.intentQueue = { async add(_n: string, _d: any, o: any) { opts.push(o); return null; } } as any;
    await processStrategyEvaluateTick({ strategy: "funding-arb", triggeredAt: "x", configFile: "x" }, deps);
    expect(opts).toHaveLength(1);
    expect(opts[0].jobId).toBe("intent:funding-arb:BTCUSDT");
    expect(opts[0].removeOnComplete).toBe(true);
    expect(opts[0].removeOnFail).toBe(true);
  });

  test("emits nothing when funding rate is below threshold", async () => {
    const { enqueued, deps } = evalDeps({ client: makeClient({ fundingRate: "0.0001" }) }); // 1 bps < 5
    const r = await processStrategyEvaluateTick({ strategy: "funding-arb", triggeredAt: "x", configFile: "x" }, deps);
    expect(r.status).toBe("evaluated");
    if (r.status === "evaluated") expect(r.intentCount).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  test("longer-tf evaluate emits a long single-leg intent on an ascending MA crossover", async () => {
    const { enqueued, deps } = evalDeps();
    const r = await processStrategyEvaluateTick({ strategy: "longer-tf", triggeredAt: "x", configFile: "x" }, deps);
    expect(r.status).toBe("evaluated");
    expect(enqueued).toHaveLength(1);
    const intent = enqueued[0]!.intent;
    expect(intent.strategy).toBe("longer-tf");
    expect(intent.legs).toHaveLength(1);
    expect(intent.legs[0]!.side).toBe("long");
    expect(intent.managePayload.stopLossPrice as number).toBeLessThan(intent.legs[0]!.refPrice);
    expect(intent.managePayload.takeProfitPrice as number).toBeGreaterThan(intent.legs[0]!.refPrice);
  });

  test("unknown strategy is skipped", async () => {
    const { deps } = evalDeps();
    const r = await processStrategyEvaluateTick({ strategy: "nope", triggeredAt: "x", configFile: "x" }, deps);
    expect(r.status).toBe("skipped");
    if (r.status === "skipped") expect(r.reason).toBe("no-evaluator");
  });
});

const agentDeps = (overrides: any = {}) => {
  const client = overrides.client ?? makeClient();
  const strategies = ["funding-arb", "basis-arb", "longer-tf", "bollinger-adx", "calendar-spread", "pairs-trading"];
  const manageCalls: Record<string, any[]> = Object.fromEntries(strategies.map((s) => [s, []]));
  const mkQueue = (k: string) => ({ async add(n: string, d: any, o: any) { manageCalls[k]!.push({ n, d, o }); return null; } });
  return {
    manageCalls,
    deps: {
      config: makeConfig(overrides.config),
      client,
      tickerSource: makeTickerSource(client),
      alerter: { async send() {} } as any,
      sharedState: makeShared(overrides.shared),
      registry: PILOT_ADAPTERS as any,
      manageQueues: Object.fromEntries(strategies.map((s) => [s, mkQueue(s)])),
      log: () => {}, now: () => NOW,
      ...overrides.deps,
    },
  };
};

function fundingIntent(): TradingAgentJobData {
  return {
    enqueuedAt: "x",
    intent: {
      strategy: "funding-arb", symbol: "BTCUSDT",
      legs: [{ symbol: "BTCUSDT", side: "short", category: "linear", qty: 0.002, qtyStr: "0.002", refPrice: 50100 }],
      notionalUsd: 100, leverage: 5, reason: "test", evaluatedAt: "x",
      managePayload: { qtyStep: "0.001", minOrderQty: "0.001", fundingRateAtEntryBps: 10, fundingTimeTarget: NEXT_FUNDING },
    },
  };
}

describe("processTradingAgentExecute", () => {
  test("funding-arb adapter opens and enqueues the funding-arb manage job", async () => {
    const { manageCalls, deps } = agentDeps();
    const r = await processTradingAgentExecute(fundingIntent(), deps);
    expect(r.status).toBe("opened");
    expect(manageCalls["funding-arb"]).toHaveLength(1);
    expect(manageCalls["funding-arb"]![0].n).toBe("funding-arb-manage-tick");
    expect(manageCalls["funding-arb"]![0].d.fundingTimeTarget).toBe(NEXT_FUNDING);
  });

  test("basis-arb adapter places PostOnly Limit at best bid when pipelineExecutionMode=maker-with-timeout (live)", async () => {
    const calls: any[] = [];
    const liveClient = {
      ...makeClient(),
      async createOrder(req: any) {
        calls.push(req);
        if (req.orderType === "Limit") return { orderId: "L1", orderLinkId: "" };
        return { orderId: "M1", orderLinkId: "" };
      },
      async getRealtimeOrder() { return { orderId: "L1", orderStatus: "Filled", avgPrice: "73000", cumExecQty: "0.002", price: "73000", qty: "0.002", leavesQty: "0", orderLinkId: "" } as any; },
      async cancelOrder() { return { orderId: "L1", orderLinkId: "" }; },
    } as any;
    const { manageCalls, deps } = agentDeps({
      config: { paperTrading: false, pipelineExecutionMode: "maker-with-timeout" },
      client: liveClient,
    });
    // basis-arb intent: perp short, spot long
    const intent: TradingAgentJobData = {
      enqueuedAt: "x",
      intent: {
        strategy: "basis-arb", symbol: "BTCUSDT",
        legs: [
          { symbol: "BTCUSDT", side: "short", category: "linear", qty: 0.002, qtyStr: "0.002", refPrice: 73000 },
          { symbol: "BTCUSDT", side: "long",  category: "spot",   qty: 0.002, qtyStr: "0.002", refPrice: 73000 },
        ],
        notionalUsd: 146, leverage: 1, reason: "test", evaluatedAt: "x",
        managePayload: { qtyStep: "0.001", minOrderQty: "0.001", entryBasisBps: 20, fundingRateAtEntryBps: 0 },
      },
    };
    const r = await processTradingAgentExecute(intent, deps);
    expect(r.status).toBe("opened");
    // Both legs went out as Limit + PostOnly (not Market)
    const limitCalls = calls.filter((c: any) => c.orderType === "Limit");
    expect(limitCalls).toHaveLength(2);
    expect(limitCalls.every((c: any) => c.timeInForce === "PostOnly")).toBe(true);
    expect(manageCalls["basis-arb"]).toHaveLength(1);
  });

  test("one-position invariant: agent skips when a position already exists", async () => {
    const { manageCalls, deps } = agentDeps({ shared: { hasActive: true } });
    const r = await processTradingAgentExecute(fundingIntent(), deps);
    expect(r.status).toBe("skipped");
    if (r.status === "skipped") expect(r.reason).toBe("active-position-exists");
    expect(manageCalls["funding-arb"]).toHaveLength(0);
  });

  test("perp open failure (live) returns skipped and enqueues nothing", async () => {
    const failClient = makeClient();
    failClient.createOrder = async () => { throw new Error("rejected"); };
    const { manageCalls, deps } = agentDeps({ config: { paperTrading: false }, client: failClient });
    const r = await processTradingAgentExecute(fundingIntent(), deps);
    expect(r.status).toBe("skipped");
    expect(manageCalls["funding-arb"]).toHaveLength(0);
  });

  test("end-to-end: evaluate intent flows into the agent and opens", async () => {
    // Stage 2
    const { enqueued, deps: eDeps } = evalDeps();
    await processStrategyEvaluateTick({ strategy: "basis-arb", triggeredAt: "x", configFile: "x" }, eDeps);
    expect(enqueued).toHaveLength(1);
    // Stage 3
    const { manageCalls, deps: aDeps } = agentDeps();
    const r = await processTradingAgentExecute(enqueued[0]!, aDeps);
    expect(r.status).toBe("opened");
    expect(manageCalls["basis-arb"]).toHaveLength(1);
    expect(manageCalls["basis-arb"]![0].n).toBe("basis-arb-manage-tick");
  });

  test("end-to-end: longer-tf evaluate → agent opens + enqueues longer-tf manage job", async () => {
    const { enqueued, deps: eDeps } = evalDeps();
    await processStrategyEvaluateTick({ strategy: "longer-tf", triggeredAt: "x", configFile: "x" }, eDeps);
    expect(enqueued).toHaveLength(1);
    const { manageCalls, deps: aDeps } = agentDeps();
    const r = await processTradingAgentExecute(enqueued[0]!, aDeps);
    expect(r.status).toBe("opened");
    expect(manageCalls["longer-tf"]).toHaveLength(1);
    expect(manageCalls["longer-tf"]![0].n).toBe("longer-tf-manage-tick");
    expect(manageCalls["longer-tf"]![0].d.side).toBe("long");
  });

  test("end-to-end: calendar-spread evaluate (dated rich) → agent opens two-leg", async () => {
    const calClient: any = {
      async getTicker(p: any) { return { lastPrice: p.symbol === "BTCUSDT" ? "50000" : "50300" }; },
      async getInstrumentInfo() { return { lotSizeFilter: { qtyStep: "0.001", minOrderQty: "0.001" } }; },
      async createOrder() {}, async setLeverage() {},
    };
    const { enqueued, deps: eDeps } = evalDeps({ client: calClient });
    await processStrategyEvaluateTick({ strategy: "calendar-spread", triggeredAt: "x", configFile: "x" }, eDeps);
    expect(enqueued).toHaveLength(1);
    const intent = enqueued[0]!.intent;
    expect(intent.legs).toHaveLength(2);
    expect(intent.legs[0]!.side).toBe("long");  // perp long
    expect(intent.legs[1]!.side).toBe("short"); // dated short
    const { manageCalls, deps: aDeps } = agentDeps();
    const r = await processTradingAgentExecute(enqueued[0]!, aDeps);
    expect(r.status).toBe("opened");
    expect(manageCalls["calendar-spread"]).toHaveLength(1);
    expect(manageCalls["calendar-spread"]![0].n).toBe("calendar-spread-manage-tick");
  });

  test("pairs-trading adapter opens both legs and enqueues the pairs manage job", async () => {
    const intent: TradingAgentJobData = {
      enqueuedAt: "x",
      intent: {
        strategy: "pairs-trading", symbol: "BTCUSDT",
        legs: [
          { symbol: "BTCUSDT", side: "long", category: "linear", qty: 0.002, qtyStr: "0.002", refPrice: 50000 },
          { symbol: "ETHUSDT", side: "short", category: "linear", qty: 0.03, qtyStr: "0.03", refPrice: 3000 },
        ],
        notionalUsd: 100, leverage: 1, reason: "z-entry", evaluatedAt: "x",
        managePayload: { hedgeRatio: 1.5, entryZ: 2.1 },
      },
    };
    const { manageCalls, deps } = agentDeps();
    const r = await processTradingAgentExecute(intent, deps);
    expect(r.status).toBe("opened");
    expect(manageCalls["pairs-trading"]).toHaveLength(1);
    const d = manageCalls["pairs-trading"]![0].d;
    expect(d.n ?? manageCalls["pairs-trading"]![0].n).toBeDefined();
    expect(manageCalls["pairs-trading"]![0].n).toBe("pairs-trading-manage-tick");
    expect(d.leg1Symbol).toBe("BTCUSDT");
    expect(d.leg2Symbol).toBe("ETHUSDT");
    expect(d.hedgeRatio).toBe(1.5);
  });
});
