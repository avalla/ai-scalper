import { describe, expect, test } from "bun:test";
import { ensureCrossMargin } from "./cross-margin";

interface MockOpts {
  switch?: (req: any) => Promise<{ alreadySet: boolean }> | { alreadySet: boolean };
  setLeverage?: (req: any) => Promise<{ alreadySet: boolean }> | { alreadySet: boolean };
}
const mkClient = (opts: MockOpts) => ({
  async switchPositionMarginMode(req: any) { return opts.switch ? opts.switch(req) : { alreadySet: false }; },
  async setLeverage(req: any) { return opts.setLeverage ? opts.setLeverage(req) : { alreadySet: false }; },
} as any);

describe("ensureCrossMargin", () => {
  test("calls switchPositionMarginMode with tradeMode=0 (cross) and leverage strings", async () => {
    let captured: any;
    const client = mkClient({ switch: (req) => { captured = req; return { alreadySet: false }; } });
    const r = await ensureCrossMargin({ client, category: "linear", symbol: "BTCUSDT", leverage: 10, log: () => {} });
    expect(r.ok).toBe(true);
    expect(captured).toEqual({
      category: "linear", symbol: "BTCUSDT", tradeMode: 0,
      buyLeverage: "10", sellLeverage: "10",
    });
  });

  test("UTA path: switch returns alreadySet=true, setLeverage still applied", async () => {
    let leverageCaptured: any;
    const events: any[] = [];
    const client = mkClient({
      switch: () => ({ alreadySet: true }), // UTA: client maps "unified account is forbidden" → alreadySet
      setLeverage: (req) => { leverageCaptured = req; return { alreadySet: false }; },
    });
    const r = await ensureCrossMargin({ client, category: "linear", symbol: "BTCUSDT", leverage: 10, log: (p) => events.push(p) });
    expect(r.ok).toBe(true);
    expect(leverageCaptured).toEqual({
      category: "linear", symbol: "BTCUSDT",
      buyLeverage: "10", sellLeverage: "10",
    });
    expect(events.find((e) => e.event === "leverage-applied")).toBeDefined();
    // cross-margin-applied should NOT log because mode was already set globally on UTA.
    expect(events.find((e) => e.event === "cross-margin-applied")).toBeUndefined();
  });

  test("alreadySet propagated when both switch + leverage are unchanged", async () => {
    const client = mkClient({
      switch: () => ({ alreadySet: true }),
      setLeverage: () => ({ alreadySet: true }),
    });
    const r = await ensureCrossMargin({ client, category: "linear", symbol: "BTCUSDT", leverage: 5, log: () => {} });
    expect(r.ok).toBe(true);
    expect(r.alreadySet).toBe(true);
  });

  test("returns ok:false if switch throws (e.g. invalid symbol)", async () => {
    const client = mkClient({ switch: () => { throw new Error("rate limit"); } });
    const r = await ensureCrossMargin({ client, category: "linear", symbol: "BTCUSDT", leverage: 10, log: () => {} });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("rate limit");
  });

  test("returns ok:false if setLeverage throws (UTA-only failure path)", async () => {
    const events: any[] = [];
    const client = mkClient({
      switch: () => ({ alreadySet: true }),
      setLeverage: () => { throw new Error("api down"); },
    });
    const r = await ensureCrossMargin({ client, category: "linear", symbol: "BTCUSDT", leverage: 10, log: (p) => events.push(p) });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("api down");
    expect(events.find((e) => e.event === "leverage-set-failed")).toBeDefined();
  });

  test("logs 'cross-margin-applied' on Classic-account path (switch actually changed)", async () => {
    const events: any[] = [];
    const client = mkClient({
      switch: () => ({ alreadySet: false }),
      setLeverage: () => ({ alreadySet: true }),
    });
    await ensureCrossMargin({ client, category: "linear", symbol: "BTCUSDT", leverage: 10, log: (p) => events.push(p) });
    const applied = events.find((e) => e.event === "cross-margin-applied");
    expect(applied).toBeDefined();
    expect(applied.symbol).toBe("BTCUSDT");
    expect(applied.leverage).toBe(10);
  });

  test("does NOT log 'cross-margin-applied' on UTA (quiet success)", async () => {
    const events: any[] = [];
    const client = mkClient({
      switch: () => ({ alreadySet: true }),
      setLeverage: () => ({ alreadySet: true }),
    });
    await ensureCrossMargin({ client, category: "linear", symbol: "BTCUSDT", leverage: 10, log: (p) => events.push(p) });
    expect(events.find((e) => e.event === "cross-margin-applied")).toBeUndefined();
    expect(events.find((e) => e.event === "leverage-applied")).toBeUndefined();
  });

  test("logs 'cross-margin-failed' on switch error", async () => {
    const events: any[] = [];
    const client = mkClient({ switch: () => { throw new Error("api down"); } });
    await ensureCrossMargin({ client, category: "linear", symbol: "BTCUSDT", leverage: 10, log: (p) => events.push(p) });
    const failed = events.find((e) => e.event === "cross-margin-failed");
    expect(failed).toBeDefined();
    expect(failed.err).toBe("api down");
  });
});
