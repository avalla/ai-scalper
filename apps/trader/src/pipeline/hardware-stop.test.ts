import { describe, expect, test } from "bun:test";
import { applyHardwareStops, computeStopPrice } from "./hardware-stop";

describe("computeStopPrice", () => {
  test("long position rounds DOWN to tick (further from entry = protective)", () => {
    // entry=70000, 500bps → raw=66500, tick=0.5 → 66500.0
    expect(computeStopPrice(70000, "long", 500, "0.5")).toBe("66500.0");
  });

  test("short position rounds UP to tick (further from entry = protective)", () => {
    // entry=70000, 500bps → raw=73500, tick=0.5 → 73500.0
    expect(computeStopPrice(70000, "short", 500, "0.5")).toBe("73500.0");
  });

  test("respects non-trivial tick (long, snaps DOWN to tick)", () => {
    // entry=67000, 500bps → raw=63650, tick=10 → 63650 / 10 = 6365, floor=6365, *10 = 63650
    expect(computeStopPrice(67000, "long", 500, "10")).toBe("63650");
    // entry=67033, 500bps → raw=63681.35, tick=10 → 6368.135 → floor 6368 → 63680
    expect(computeStopPrice(67033, "long", 500, "10")).toBe("63680");
  });

  test("respects non-trivial tick (short, snaps UP to tick)", () => {
    // entry=67033, 500bps → raw=70384.65, tick=10 → 7038.465 → ceil 7039 → 70390
    expect(computeStopPrice(67033, "short", 500, "10")).toBe("70390");
  });

  test("preserves tick decimals in output string", () => {
    expect(computeStopPrice(70000, "long", 100, "0.01")).toBe("69300.00");
    expect(computeStopPrice(70000, "long", 100, "0.5")).toBe("69300.0");
  });

  test("rejects width <= 0", () => {
    expect(() => computeStopPrice(70000, "long", 0, "0.5")).toThrow(/widthBps must be > 0/);
    expect(() => computeStopPrice(70000, "long", -10, "0.5")).toThrow(/widthBps must be > 0/);
  });

  test("rejects invalid entry / tick", () => {
    expect(() => computeStopPrice(0, "long", 500, "0.5")).toThrow(/invalid entry/);
    expect(() => computeStopPrice(NaN, "long", 500, "0.5")).toThrow(/invalid entry/);
    expect(() => computeStopPrice(70000, "long", 500, "0")).toThrow(/invalid tickSize/);
    expect(() => computeStopPrice(70000, "long", 500, "abc")).toThrow(/invalid tickSize/);
  });
});

describe("applyHardwareStops", () => {
  const mkClient = (impl: (req: any) => Promise<any> | any) => ({
    async setTradingStop(req: any) { return impl(req); },
  } as any);

  test("widthBps=0 returns 0/0 without calling the client", async () => {
    let calls = 0;
    const client = mkClient(() => { calls += 1; return { retCode: 0 }; });
    const r = await applyHardwareStops({
      client, widthBps: 0,
      legs: [{ symbol: "BTCUSDT", side: "long", entryPrice: 70000, tickSize: "0.5", category: "linear" }],
    });
    expect(r).toEqual({ appliedCount: 0, failedCount: 0 });
    expect(calls).toBe(0);
  });

  test("applies stop for each leg with correct stopLoss + logs applied", async () => {
    const captured: any[] = [];
    const events: any[] = [];
    const client = mkClient((req) => { captured.push(req); return { retCode: 0 }; });
    const r = await applyHardwareStops({
      client, widthBps: 500, log: (p) => events.push(p),
      legs: [
        { symbol: "BTCUSDT", side: "long", entryPrice: 70000, tickSize: "0.5", category: "linear" },
        { symbol: "BTCUSDT-26JUN26", side: "short", entryPrice: 70100, tickSize: "0.5", category: "linear" },
      ],
    });
    expect(r).toEqual({ appliedCount: 2, failedCount: 0 });
    expect(captured).toEqual([
      { category: "linear", symbol: "BTCUSDT", stopLoss: "66500.0" },
      { category: "linear", symbol: "BTCUSDT-26JUN26", stopLoss: "73605.0" },
    ]);
    expect(events.filter((e) => e.event === "hardware-stop-applied")).toHaveLength(2);
  });

  test("retCode != 0 is recorded as failure but does not throw", async () => {
    const events: any[] = [];
    const client = mkClient(() => ({ retCode: 110043, retMsg: "leverage not modified" }));
    const r = await applyHardwareStops({
      client, widthBps: 500, log: (p) => events.push(p),
      legs: [{ symbol: "BTCUSDT", side: "long", entryPrice: 70000, tickSize: "0.5", category: "linear" }],
    });
    expect(r).toEqual({ appliedCount: 0, failedCount: 1 });
    expect(events.find((e) => e.event === "hardware-stop-rejected")).toBeDefined();
  });

  test("treats retCode 34040 (already set) as success", async () => {
    const client = mkClient(() => ({ retCode: 34040, retMsg: "trading-stop unchanged" }));
    const r = await applyHardwareStops({
      client, widthBps: 500, log: () => {},
      legs: [{ symbol: "BTCUSDT", side: "long", entryPrice: 70000, tickSize: "0.5", category: "linear" }],
    });
    expect(r).toEqual({ appliedCount: 1, failedCount: 0 });
  });

  test("transient API exception is swallowed (best-effort)", async () => {
    const events: any[] = [];
    const client = mkClient(() => { throw new Error("rate limit"); });
    const r = await applyHardwareStops({
      client, widthBps: 500, log: (p) => events.push(p),
      legs: [{ symbol: "BTCUSDT", side: "long", entryPrice: 70000, tickSize: "0.5", category: "linear" }],
    });
    expect(r).toEqual({ appliedCount: 0, failedCount: 1 });
    expect(events.find((e) => e.event === "hardware-stop-call-failed")).toBeDefined();
  });

  test("one leg fails, the other succeeds — both attempted", async () => {
    let call = 0;
    const client = mkClient(() => {
      call += 1;
      if (call === 1) throw new Error("only first fails");
      return { retCode: 0 };
    });
    const r = await applyHardwareStops({
      client, widthBps: 500, log: () => {},
      legs: [
        { symbol: "BTCUSDT", side: "long", entryPrice: 70000, tickSize: "0.5", category: "linear" },
        { symbol: "BTCUSDT-26JUN26", side: "short", entryPrice: 70100, tickSize: "0.5", category: "linear" },
      ],
    });
    expect(r).toEqual({ appliedCount: 1, failedCount: 1 });
    expect(call).toBe(2);
  });
});
