import { describe, expect, test } from "bun:test";
import type IORedis from "ioredis";
import { readWsHeartbeat, writeWsHeartbeat, type WsHeartbeat } from "./ws-heartbeat";
import { runHealthChecks, type WsHealthProbe } from "./health";

interface HashEntry {
  fields: Map<string, string>;
  expiresAtSec: number | null;
}

function makeFakeRedis(now: () => number = () => Date.now()): IORedis {
  const hashes = new Map<string, HashEntry>();

  function ensure(key: string): HashEntry {
    let e = hashes.get(key);
    if (!e) {
      e = { fields: new Map(), expiresAtSec: null };
      hashes.set(key, e);
    }
    if (e.expiresAtSec !== null && now() / 1000 >= e.expiresAtSec) {
      hashes.delete(key);
      const fresh: HashEntry = { fields: new Map(), expiresAtSec: null };
      hashes.set(key, fresh);
      return fresh;
    }
    return e;
  }

  const fake: Record<string, unknown> = {
    async hset(key: string, obj: Record<string, string>) {
      const e = ensure(key);
      for (const [k, v] of Object.entries(obj)) e.fields.set(k, v);
      return Object.keys(obj).length;
    },
    async hgetall(key: string) {
      const e = hashes.get(key);
      if (!e) return {};
      if (e.expiresAtSec !== null && now() / 1000 >= e.expiresAtSec) {
        hashes.delete(key);
        return {};
      }
      return Object.fromEntries(e.fields.entries());
    },
    async expire(key: string, sec: number) {
      const e = hashes.get(key);
      if (!e) return 0;
      e.expiresAtSec = now() / 1000 + sec;
      return 1;
    },
    async ping() { return "PONG"; },
  };
  return fake as unknown as IORedis;
}

describe("ws-heartbeat", () => {
  test("write + read roundtrip preserves fields", async () => {
    const redis = makeFakeRedis(() => 1_700_000_000_000);
    const hb: WsHeartbeat = {
      lastMessageAt: 1_700_000_000_000 - 1_000,
      reconnects: 2,
      isConnected: true,
      writtenAt: 1_700_000_000_000,
    };
    await writeWsHeartbeat(redis, hb);
    const read = await readWsHeartbeat(redis);
    expect(read).not.toBeNull();
    expect(read!.lastMessageAt).toBe(hb.lastMessageAt);
    expect(read!.reconnects).toBe(2);
    expect(read!.isConnected).toBe(true);
    expect(read!.writtenAt).toBe(hb.writtenAt);
  });

  test("returns null when no heartbeat has been written", async () => {
    const redis = makeFakeRedis();
    const read = await readWsHeartbeat(redis);
    expect(read).toBeNull();
  });

  test("integrates with runHealthChecks (fresh heartbeat → ws.ok=true)", async () => {
    const now = 1_700_000_000_000;
    const redis = makeFakeRedis(() => now);
    await writeWsHeartbeat(redis, {
      lastMessageAt: now - 5_000,
      reconnects: 0,
      isConnected: true,
      writtenAt: now,
    });
    const hb = await readWsHeartbeat(redis);
    expect(hb).not.toBeNull();
    const wsProbe: WsHealthProbe = {
      isConnected: () => hb!.isConnected,
      lastMessageAt: () => hb!.lastMessageAt,
      reconnectsLastHour: () => hb!.reconnects,
    };
    const result = await runHealthChecks({
      redis: redis as unknown as { ping(): Promise<string> },
      ws: wsProbe,
      now: () => now,
    });
    expect(result.checks.ws?.ok).toBe(true);
  });

  test("stale heartbeat (>30s) treated as ws.ok=false via missing-probe substitute", async () => {
    const now = 1_700_000_000_000;
    const redis = makeFakeRedis(() => now);
    // Write a heartbeat 31 seconds in the past — board.ts treats this as
    // stale and substitutes a forced-down probe.
    await writeWsHeartbeat(redis, {
      lastMessageAt: now - 35_000,
      reconnects: 0,
      isConnected: true,
      writtenAt: now - 31_000,
    });
    const hb = await readWsHeartbeat(redis);
    expect(hb).not.toBeNull();
    const stale = now - hb!.writtenAt > 30_000;
    expect(stale).toBe(true);
    const forcedDownProbe: WsHealthProbe = {
      isConnected: () => false,
      lastMessageAt: () => null,
      reconnectsLastHour: () => 0,
    };
    const result = await runHealthChecks({
      redis: redis as unknown as { ping(): Promise<string> },
      ws: forcedDownProbe,
      now: () => now,
    });
    expect(result.checks.ws?.ok).toBe(false);
  });
});
