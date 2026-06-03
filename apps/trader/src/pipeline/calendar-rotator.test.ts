import { describe, expect, test } from "bun:test";
import { pickNextQuarterly, createCalendarRotator } from "./calendar-rotator";
import type { InstrumentInfo } from "@ai-scalper/bybit-client";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_780_000_000_000; // arbitrary base time

const mk = (over: Partial<InstrumentInfo>): InstrumentInfo => ({
  symbol: over.symbol ?? "BTCUSDT-26JUN26",
  contractType: over.contractType ?? "LinearFutures",
  baseCoin: over.baseCoin ?? "BTC",
  quoteCoin: over.quoteCoin ?? "USDT",
  status: over.status ?? "Trading",
  deliveryTime: over.deliveryTime ?? String(NOW + 30 * DAY),
  leverageFilter: { minLeverage: "1", maxLeverage: "100", leverageStep: "0.01" },
  lotSizeFilter: { minNotionalValue: "5", maxOrderQty: "1000", maxMktOrderQty: "100", minOrderQty: "0.001", qtyStep: "0.001" },
  priceFilter: { minPrice: "0.5", maxPrice: "1000000", tickSize: "0.5" },
  ...over,
});

describe("pickNextQuarterly", () => {
  test("returns nearest valid LinearFutures", () => {
    const r = pickNextQuarterly([
      mk({ symbol: "FAR", deliveryTime: String(NOW + 120 * DAY) }),
      mk({ symbol: "NEAR", deliveryTime: String(NOW + 30 * DAY) }),
      mk({ symbol: "MED", deliveryTime: String(NOW + 60 * DAY) }),
    ], NOW, { baseCoin: "BTC" });
    expect(r?.symbol).toBe("NEAR");
  });

  test("skips perpetuals", () => {
    const r = pickNextQuarterly([
      mk({ symbol: "BTCUSDT", contractType: "LinearPerpetual", deliveryTime: "0" }),
      mk({ symbol: "BTCUSDT-26SEP26", deliveryTime: String(NOW + 90 * DAY) }),
    ], NOW, { baseCoin: "BTC" });
    expect(r?.symbol).toBe("BTCUSDT-26SEP26");
  });

  test("skips contracts within minHoursAhead window", () => {
    const r = pickNextQuarterly([
      mk({ symbol: "TOOCLOSE", deliveryTime: String(NOW + 20 * HOUR) }), // <25h
      mk({ symbol: "OK", deliveryTime: String(NOW + 40 * DAY) }),
    ], NOW, { baseCoin: "BTC", minHoursAhead: 25 });
    expect(r?.symbol).toBe("OK");
  });

  test("filters wrong baseCoin", () => {
    const r = pickNextQuarterly([
      mk({ symbol: "ETHUSDT-26JUN26", baseCoin: "ETH" }),
    ], NOW, { baseCoin: "BTC" });
    expect(r).toBeNull();
  });

  test("filters non-Trading status", () => {
    const r = pickNextQuarterly([
      mk({ symbol: "DELISTED", status: "Closed" }),
    ], NOW, { baseCoin: "BTC" });
    expect(r).toBeNull();
  });

  test("returns null on empty list", () => {
    expect(pickNextQuarterly([], NOW, { baseCoin: "BTC" })).toBeNull();
  });
});

describe("createCalendarRotator", () => {
  const mkClient = (list: InstrumentInfo[] | (() => InstrumentInfo[]) | (() => Promise<never>)) => ({
    async listInstruments() {
      const r = typeof list === "function" ? await (list as any)() : list;
      return r;
    },
  } as any);

  test("returns cached pick + refresh emits change event", async () => {
    let listA: InstrumentInfo[] = [mk({ symbol: "BTCUSDT-26JUN26", deliveryTime: String(NOW + 20 * DAY) })];
    const events: any[] = [];
    let t = NOW;
    const rot = createCalendarRotator(mkClient(() => listA), {
      baseCoin: "BTC", refreshMs: 10 * 1000,
      log: (p) => events.push(p), now: () => t,
    });
    const r1 = await rot.getCurrent();
    expect(r1?.symbol).toBe("BTCUSDT-26JUN26");
    expect(events.find((e) => e.event === "calendar-rotator-pick-changed")).toBeDefined();

    // Switch list, advance past refreshMs.
    listA = [mk({ symbol: "BTCUSDT-26SEP26", deliveryTime: String(NOW + 110 * DAY) })];
    t = NOW + 60_000;
    const r2 = await rot.getCurrent();
    expect(r2?.symbol).toBe("BTCUSDT-26SEP26");
    const changes = events.filter((e) => e.event === "calendar-rotator-pick-changed");
    expect(changes.length).toBe(2);
    expect(changes[1].previous).toBe("BTCUSDT-26JUN26");
  });

  test("refresh failure keeps prior cached value (no throw)", async () => {
    let mode: "ok" | "fail" = "ok";
    const events: any[] = [];
    let t = NOW;
    const rot = createCalendarRotator(mkClient(() => {
      if (mode === "fail") throw new Error("api down");
      return [mk({ symbol: "BTCUSDT-26JUN26", deliveryTime: String(NOW + 20 * DAY) })];
    }), { baseCoin: "BTC", refreshMs: 1000, log: (p) => events.push(p), now: () => t });

    const first = await rot.getCurrent();
    expect(first?.symbol).toBe("BTCUSDT-26JUN26");

    mode = "fail";
    t = NOW + 5_000; // force refresh
    const second = await rot.getCurrent();
    expect(second?.symbol).toBe("BTCUSDT-26JUN26"); // sticky cached
    expect(events.find((e) => e.event === "calendar-rotator-refresh-failed")).toBeDefined();
  });

  test("concurrent getCurrent calls share single inflight request", async () => {
    let calls = 0;
    let t = NOW;
    const rot = createCalendarRotator({
      async listInstruments() {
        calls += 1;
        await new Promise((r) => setTimeout(r, 5));
        return [mk({ symbol: "BTCUSDT-26JUN26", deliveryTime: String(NOW + 20 * DAY) })];
      },
    } as any, { baseCoin: "BTC", refreshMs: 10_000, log: () => {}, now: () => t });

    const [a, b, c] = await Promise.all([rot.getCurrent(), rot.getCurrent(), rot.getCurrent()]);
    expect(a?.symbol).toBe("BTCUSDT-26JUN26");
    expect(b?.symbol).toBe("BTCUSDT-26JUN26");
    expect(c?.symbol).toBe("BTCUSDT-26JUN26");
    expect(calls).toBe(1);
  });
});
