import { describe, expect, test } from "bun:test";
import { placeOrderWithMakerPreference, type MakerExecutionDeps } from "./maker-execution";

function makeTicker(opts: { bid?: string; ask?: string; fail?: boolean } = {}) {
  return {
    async getTicker() {
      if (opts.fail) throw new Error("ticker-net");
      return { bid1Price: opts.bid ?? "73000", ask1Price: opts.ask ?? "73001", lastPrice: "73000.5" } as any;
    },
    peek() { return null; },
  } as any;
}

// Records calls; lets the test script the responses.
function makeClient(opts: {
  postOnlyFails?: boolean;
  marketFails?: boolean;
  orderStates?: string[]; // sequence returned by successive getRealtimeOrder calls
  filledAvgPrice?: string;
}) {
  const calls: any[] = [];
  let postOnlyId = "";
  let pollIdx = 0;
  const states = opts.orderStates ?? ["New", "New", "Filled"];
  return {
    calls,
    async createOrder(req: any) {
      calls.push({ kind: "createOrder", ...req });
      if (req.orderType === "Limit") {
        if (opts.postOnlyFails) throw new Error("post-only would cross");
        postOnlyId = "limit-1"; return { orderId: postOnlyId, orderLinkId: "" };
      }
      if (opts.marketFails) throw new Error("market rejected");
      return { orderId: "market-1", orderLinkId: "" };
    },
    async getRealtimeOrder() {
      const s = states[Math.min(pollIdx, states.length - 1)]!;
      pollIdx += 1;
      return { orderId: postOnlyId, orderStatus: s, avgPrice: opts.filledAvgPrice ?? "73000", cumExecQty: "0.002", price: "73000", qty: "0.002", leavesQty: "0", orderLinkId: "" };
    },
    async cancelOrder(req: any) { calls.push({ kind: "cancel", ...req }); return { orderId: req.orderId, orderLinkId: "" }; },
  } as any;
}

function makeDeps(client: any, ticker: any): MakerExecutionDeps {
  return { client, tickerSource: ticker, sleep: async () => {}, now: () => 0, log: () => {} };
}

const baseReq = { category: "linear" as const, symbol: "BTCUSDT", side: "Buy" as const, qty: "0.002" };

describe("placeOrderWithMakerPreference", () => {
  test("fills as maker when limit goes to Filled within timeout", async () => {
    const client = makeClient({ orderStates: ["New", "Filled"], filledAvgPrice: "73000" });
    const r = await placeOrderWithMakerPreference(baseReq, makeDeps(client, makeTicker()), { timeoutMs: 30_000, pollIntervalMs: 1_000 });
    expect(r.status).toBe("filled-maker");
    if (r.status === "filled-maker") {
      expect(r.fillPrice).toBe(73000);
      expect(client.calls[0].orderType).toBe("Limit");
      expect(client.calls[0].timeInForce).toBe("PostOnly");
      expect(client.calls[0].price).toBe("73000.00"); // Buy joins bid
    }
  });

  test("Sell uses ask price (joins the offer)", async () => {
    const client = makeClient({ orderStates: ["Filled"], filledAvgPrice: "73001" });
    const r = await placeOrderWithMakerPreference({ ...baseReq, side: "Sell" }, makeDeps(client, makeTicker({ bid: "73000", ask: "73001" })), { timeoutMs: 30_000, pollIntervalMs: 1_000 });
    expect(r.status).toBe("filled-maker");
    expect(client.calls[0].price).toBe("73001.00");
  });

  test("times out → cancels limit and falls back to Market", async () => {
    let nowMs = 0;
    const client = makeClient({ orderStates: ["New", "New", "New", "New", "New"] });
    const deps: MakerExecutionDeps = {
      client, tickerSource: makeTicker(),
      sleep: async (ms) => { nowMs += ms; }, now: () => nowMs, log: () => {},
    };
    const r = await placeOrderWithMakerPreference(baseReq, deps, { timeoutMs: 5_000, pollIntervalMs: 2_000 });
    expect(r.status).toBe("filled-taker-fallback");
    if (r.status === "filled-taker-fallback") expect(r.reason).toBe("timeout");
    const kinds = client.calls.map((c: any) => c.kind + ":" + (c.orderType ?? ""));
    expect(kinds).toContain("createOrder:Limit");
    expect(kinds.some((k: string) => k.startsWith("cancel:"))).toBe(true);
    expect(kinds).toContain("createOrder:Market");
  });

  test("post-only rejected by exchange → falls back to Market", async () => {
    const client = makeClient({ postOnlyFails: true });
    const r = await placeOrderWithMakerPreference(baseReq, makeDeps(client, makeTicker()), { timeoutMs: 5_000 });
    expect(r.status).toBe("filled-taker-fallback");
    if (r.status === "filled-taker-fallback") expect(r.reason).toBe("post-only-rejected");
  });

  test("ticker unavailable + fallbackToTaker=false → skipped-failed", async () => {
    const r = await placeOrderWithMakerPreference(baseReq, makeDeps(makeClient({}), makeTicker({ fail: true })), { fallbackToTaker: false });
    expect(r.status).toBe("skipped-failed");
  });

  test("order status Cancelled mid-poll → falls back to Market", async () => {
    const client = makeClient({ orderStates: ["New", "Cancelled"] });
    const r = await placeOrderWithMakerPreference(baseReq, makeDeps(client, makeTicker()), { timeoutMs: 30_000, pollIntervalMs: 1_000 });
    expect(r.status).toBe("filled-taker-fallback");
    if (r.status === "filled-taker-fallback") expect(r.reason).toBe("post-only-rejected");
  });
});
