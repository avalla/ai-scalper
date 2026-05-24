import { describe, expect, it } from "bun:test";
import type { BybitWsClient, BybitWsStats } from "@ai-scalper/bybit-client/ws";
import { createWsHealthProbe } from "./ws-health-probe";

function makeFakeClient(stats: BybitWsStats, connected = true): BybitWsClient {
  return {
    isConnected: () => connected,
    getStats: () => stats,
  } as unknown as BybitWsClient;
}

describe("createWsHealthProbe", () => {
  it("forwards isConnected and lastMessageAt from the client", () => {
    const stats = { messagesReceived: 10, reconnects: 0, lastMessageAt: 12345 };
    const probe = createWsHealthProbe({ client: makeFakeClient(stats) });
    expect(probe.isConnected()).toBe(true);
    expect(probe.lastMessageAt()).toBe(12345);
  });

  it("reconnectsLastHour returns 0 when counter never changes", () => {
    let t = 0;
    const stats = { messagesReceived: 0, reconnects: 3, lastMessageAt: null };
    const probe = createWsHealthProbe({
      client: makeFakeClient(stats),
      now: () => t,
    });
    expect(probe.reconnectsLastHour()).toBe(0);
    t = 1000;
    expect(probe.reconnectsLastHour()).toBe(0);
    t = 60 * 60 * 1000;
    expect(probe.reconnectsLastHour()).toBe(0);
  });

  it("reconnectsLastHour reflects delta within the 1h window", () => {
    let t = 0;
    const stats = { messagesReceived: 0, reconnects: 0, lastMessageAt: null };
    const probe = createWsHealthProbe({
      client: {
        isConnected: () => true,
        getStats: () => stats,
      } as unknown as BybitWsClient,
      now: () => t,
    });
    // baseline at t=0, reconnects=0
    probe.reconnectsLastHour();
    // 10 min later, one reconnect
    t = 10 * 60 * 1000;
    stats.reconnects = 1;
    expect(probe.reconnectsLastHour()).toBe(1);
    // 50 min after baseline: 4 more reconnects
    t = 50 * 60 * 1000;
    stats.reconnects = 5;
    expect(probe.reconnectsLastHour()).toBe(5);
  });

  it("reconnectsLastHour drops samples outside the rolling window", () => {
    let t = 0;
    const stats = { messagesReceived: 0, reconnects: 0, lastMessageAt: null };
    const probe = createWsHealthProbe({
      client: {
        isConnected: () => true,
        getStats: () => stats,
      } as unknown as BybitWsClient,
      now: () => t,
      windowMs: 60 * 60 * 1000,
    });
    // baseline
    probe.reconnectsLastHour();
    // 30 min: 5 reconnects
    t = 30 * 60 * 1000;
    stats.reconnects = 5;
    expect(probe.reconnectsLastHour()).toBe(5);
    // 2h later: window slid past first sample; baseline=5, current=5 → 0 in window
    t = 2 * 60 * 60 * 1000;
    expect(probe.reconnectsLastHour()).toBe(0);
  });
});
