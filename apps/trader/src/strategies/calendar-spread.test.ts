import { describe, expect, test } from "bun:test";
import {
  calendarDecide,
  computeCalendarSpreadBps,
  type CalendarPosition,
} from "./calendar-spread";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

const baseCfg = {
  entryThresholdBps: 30,
  exitThresholdBps: 5,
  preSettlementCloseHours: 24,
};

// 60 days out — well past any settlement boundary so opens are allowed.
const FAR_DELIVERY = NOW + 60 * 24 * HOUR;

describe("computeCalendarSpreadBps", () => {
  test("returns 0 when perpPrice is 0", () => {
    expect(computeCalendarSpreadBps(0, 100)).toBe(0);
  });

  test("positive spread when dated > perp (contango)", () => {
    // perp 100, dated 101 → (1/100)*10000 = 100 bps
    expect(computeCalendarSpreadBps(100, 101)).toBeCloseTo(100, 6);
  });

  test("negative spread when dated < perp (backwardation)", () => {
    expect(computeCalendarSpreadBps(100, 99.5)).toBeCloseTo(-50, 6);
  });
});

describe("calendarDecide", () => {
  test("hold:spread-too-small when no position and spread below threshold", () => {
    const decision = calendarDecide({
      perpPrice: 100,
      datedPrice: 100.15, // 15 bps < 30
      datedDeliveryAt: FAR_DELIVERY,
      now: NOW,
      position: null,
      config: baseCfg,
    });
    expect(decision.kind).toBe("hold");
    if (decision.kind === "hold") expect(decision.reason).toBe("spread-too-small");
  });

  test("hold:too-close-to-settlement refuses to open even when spread is wide", () => {
    // Wide spread but delivery in 12h, less than preSettlementCloseHours + 1.
    const decision = calendarDecide({
      perpPrice: 100,
      datedPrice: 101, // 100 bps — wide
      datedDeliveryAt: NOW + 12 * HOUR,
      now: NOW,
      position: null,
      config: baseCfg,
    });
    expect(decision.kind).toBe("hold");
    if (decision.kind === "hold") expect(decision.reason).toBe("too-close-to-settlement");
  });

  test("enter contango: positive spread → perp=long, dated=short", () => {
    const decision = calendarDecide({
      perpPrice: 100,
      datedPrice: 100.5, // 50 bps > 30
      datedDeliveryAt: FAR_DELIVERY,
      now: NOW,
      position: null,
      config: baseCfg,
    });
    expect(decision.kind).toBe("enter");
    if (decision.kind === "enter") {
      expect(decision.perpSide).toBe("long");
      expect(decision.datedSide).toBe("short");
      expect(decision.spreadBps).toBeCloseTo(50, 6);
    }
  });

  test("enter backwardation: negative spread → perp=short, dated=long", () => {
    const decision = calendarDecide({
      perpPrice: 100,
      datedPrice: 99.5, // -50 bps
      datedDeliveryAt: FAR_DELIVERY,
      now: NOW,
      position: null,
      config: baseCfg,
    });
    expect(decision.kind).toBe("enter");
    if (decision.kind === "enter") {
      expect(decision.perpSide).toBe("short");
      expect(decision.datedSide).toBe("long");
    }
  });

  test("exit:spread-converged when |spread| within exit threshold", () => {
    const pos: CalendarPosition = {
      perpSide: "long",
      datedSide: "short",
      perpEntryPrice: 100,
      datedEntryPrice: 100.5,
      qty: 0.01,
      entrySpreadBps: 50,
      entryAt: NOW - 5 * HOUR,
      datedDeliveryAt: FAR_DELIVERY,
    };
    const decision = calendarDecide({
      perpPrice: 100,
      datedPrice: 100.03, // 3 bps <= 5
      datedDeliveryAt: FAR_DELIVERY,
      now: NOW,
      position: pos,
      config: baseCfg,
    });
    expect(decision.kind).toBe("exit");
    if (decision.kind === "exit") expect(decision.reason).toBe("spread-converged");
  });

  test("exit:pre-settlement when in position and within close window", () => {
    const datedDeliveryAt = NOW + 12 * HOUR; // 12h < preSettlementCloseHours (24)
    const pos: CalendarPosition = {
      perpSide: "long",
      datedSide: "short",
      perpEntryPrice: 100,
      datedEntryPrice: 100.5,
      qty: 0.01,
      entrySpreadBps: 50,
      entryAt: NOW - 30 * 24 * HOUR,
      datedDeliveryAt,
    };
    const decision = calendarDecide({
      perpPrice: 100,
      datedPrice: 100.4, // still 40 bps — would normally hold
      datedDeliveryAt,
      now: NOW,
      position: pos,
      config: baseCfg,
    });
    expect(decision.kind).toBe("exit");
    if (decision.kind === "exit") expect(decision.reason).toBe("pre-settlement");
  });

  test("hold:waiting-convergence when in position and spread still wide", () => {
    const pos: CalendarPosition = {
      perpSide: "long",
      datedSide: "short",
      perpEntryPrice: 100,
      datedEntryPrice: 100.5,
      qty: 0.01,
      entrySpreadBps: 50,
      entryAt: NOW - 5 * HOUR,
      datedDeliveryAt: FAR_DELIVERY,
    };
    const decision = calendarDecide({
      perpPrice: 100,
      datedPrice: 100.3, // 30 bps > exit 5
      datedDeliveryAt: FAR_DELIVERY,
      now: NOW,
      position: pos,
      config: baseCfg,
    });
    expect(decision.kind).toBe("hold");
    if (decision.kind === "hold") expect(decision.reason).toBe("waiting-convergence");
  });

  test("edge: spread exactly at entry threshold does NOT enter (strict >)", () => {
    // Matches basis-arb semantics — equality at the boundary holds.
    const decision = calendarDecide({
      perpPrice: 100,
      datedPrice: 100.3, // exactly 30 bps == entryThresholdBps
      datedDeliveryAt: FAR_DELIVERY,
      now: NOW,
      position: null,
      config: baseCfg,
    });
    expect(decision.kind).toBe("hold");
    if (decision.kind === "hold") expect(decision.reason).toBe("spread-too-small");
  });

  test("pre-settlement takes precedence over spread-converged", () => {
    const datedDeliveryAt = NOW + 12 * HOUR;
    const pos: CalendarPosition = {
      perpSide: "long",
      datedSide: "short",
      perpEntryPrice: 100,
      datedEntryPrice: 100.5,
      qty: 0.01,
      entrySpreadBps: 50,
      entryAt: NOW - 30 * 24 * HOUR,
      datedDeliveryAt,
    };
    const decision = calendarDecide({
      perpPrice: 100,
      datedPrice: 100, // 0 bps would also trigger spread-converged
      datedDeliveryAt,
      now: NOW,
      position: pos,
      config: baseCfg,
    });
    expect(decision.kind).toBe("exit");
    if (decision.kind === "exit") expect(decision.reason).toBe("pre-settlement");
  });
});
