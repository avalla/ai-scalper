import { describe, expect, test } from "bun:test";
import { ensureCrossMargin } from "./cross-margin";

const mkClient = (impl: (req: any) => Promise<{ alreadySet: boolean }> | { alreadySet: boolean }) => ({
  async switchPositionMarginMode(req: any) { return impl(req); },
} as any);

describe("ensureCrossMargin", () => {
  test("calls switchPositionMarginMode with tradeMode=0 (cross) and leverage strings", async () => {
    let captured: any;
    const client = mkClient((req) => { captured = req; return { alreadySet: false }; });
    const r = await ensureCrossMargin({ client, category: "linear", symbol: "BTCUSDT", leverage: 10, log: () => {} });
    expect(r.ok).toBe(true);
    expect(captured).toEqual({
      category: "linear", symbol: "BTCUSDT", tradeMode: 0,
      buyLeverage: "10", sellLeverage: "10",
    });
  });

  test("alreadySet propagated when Bybit returns 110026", async () => {
    const client = mkClient(() => ({ alreadySet: true }));
    const r = await ensureCrossMargin({ client, category: "linear", symbol: "BTCUSDT", leverage: 5, log: () => {} });
    expect(r.ok).toBe(true);
    expect(r.alreadySet).toBe(true);
  });

  test("does NOT throw on transient API errors (operator may want isolated)", async () => {
    const client = mkClient(() => { throw new Error("rate limit"); });
    const r = await ensureCrossMargin({ client, category: "linear", symbol: "BTCUSDT", leverage: 10, log: () => {} });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("rate limit");
  });

  test("logs 'applied' event when actually changed (not alreadySet)", async () => {
    const events: any[] = [];
    const client = mkClient(() => ({ alreadySet: false }));
    await ensureCrossMargin({ client, category: "linear", symbol: "BTCUSDT", leverage: 10, log: (p) => events.push(p) });
    const applied = events.find((e) => e.event === "cross-margin-applied");
    expect(applied).toBeDefined();
    expect(applied.symbol).toBe("BTCUSDT");
    expect(applied.leverage).toBe(10);
  });

  test("does NOT log 'applied' when alreadySet (quiet success path)", async () => {
    const events: any[] = [];
    const client = mkClient(() => ({ alreadySet: true }));
    await ensureCrossMargin({ client, category: "linear", symbol: "BTCUSDT", leverage: 10, log: (p) => events.push(p) });
    expect(events.find((e) => e.event === "cross-margin-applied")).toBeUndefined();
  });

  test("logs 'failed' on error with error message", async () => {
    const events: any[] = [];
    const client = mkClient(() => { throw new Error("api down"); });
    await ensureCrossMargin({ client, category: "linear", symbol: "BTCUSDT", leverage: 10, log: (p) => events.push(p) });
    const failed = events.find((e) => e.event === "cross-margin-failed");
    expect(failed).toBeDefined();
    expect(failed.err).toBe("api down");
  });
});
