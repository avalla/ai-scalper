import { describe, expect, it } from "bun:test";
import type IORedis from "ioredis";
import { createRedisLiquidationsCache } from "./liquidations-cache";

interface FakeZsetEntry {
  members: { score: number; member: string }[];
  expiresAt: number | null;
}

export function makeFakeRedis(now: () => number = () => Date.now()): IORedis {
  const data = new Map<string, FakeZsetEntry>();
  const listeners: ((channel: string, payload: string) => void)[] = [];
  const subs = new Set<string>();

  function ensure(key: string): FakeZsetEntry {
    let e = data.get(key);
    if (!e) {
      e = { members: [], expiresAt: null };
      data.set(key, e);
    }
    if (e.expiresAt !== null && now() >= e.expiresAt) {
      e.members = [];
      e.expiresAt = null;
    }
    return e;
  }

  const fake: Record<string, unknown> = {
    async zadd(key: string, score: number, member: string) {
      const e = ensure(key);
      e.members.push({ score, member });
      return 1;
    },
    async zrangebyscore(key: string, min: number | string, max: number | string) {
      const e = ensure(key);
      const lo = min === "-inf" ? -Infinity : Number(min);
      const hi = max === "+inf" ? Infinity : Number(max);
      return e.members
        .filter((m) => m.score >= lo && m.score <= hi)
        .sort((a, b) => a.score - b.score)
        .map((m) => m.member);
    },
    async zremrangebyscore(key: string, min: number | string, max: number | string) {
      const e = ensure(key);
      const lo = min === "-inf" ? -Infinity : Number(min);
      const hi = max === "+inf" ? Infinity : Number(max);
      const before = e.members.length;
      e.members = e.members.filter((m) => !(m.score >= lo && m.score <= hi));
      return before - e.members.length;
    },
    async hset(key: string, obj: Record<string, string>) {
      const e = data.get(key) ?? { members: [], expiresAt: null };
      data.set(key, e);
      return Object.keys(obj).length;
    },
    async pexpire(key: string, ms: number) {
      const e = data.get(key);
      if (!e) return 0;
      e.expiresAt = now() + ms;
      return 1;
    },
    async publish(ch: string, p: string) {
      if (!subs.has(ch)) return 0;
      for (const l of listeners) l(ch, p);
      return listeners.length;
    },
    multi() {
      const ops: (() => Promise<unknown>)[] = [];
      const chain: Record<string, unknown> = {
        zadd(k: string, s: number, m: string) { ops.push(() => (fake.zadd as (...a: unknown[]) => Promise<unknown>)(k, s, m)); return chain; },
        hset(k: string, o: Record<string, string>) { ops.push(() => (fake.hset as (...a: unknown[]) => Promise<unknown>)(k, o)); return chain; },
        pexpire(k: string, ms: number) { ops.push(() => (fake.pexpire as (...a: unknown[]) => Promise<unknown>)(k, ms)); return chain; },
        publish(c: string, m: string) { ops.push(() => (fake.publish as (...a: unknown[]) => Promise<unknown>)(c, m)); return chain; },
        async exec() { const out: unknown[] = []; for (const o of ops) out.push([null, await o()]); return out; },
      };
      return chain;
    },
    async subscribe(ch: string) { subs.add(ch); return 1; },
    async unsubscribe(ch: string) { subs.delete(ch); return 0; },
    async quit() { return "OK"; },
    on(ev: string, fn: (ch: string, p: string) => void) {
      if (ev === "message") listeners.push(fn);
    },
    duplicate() { return fake as unknown as IORedis; },
  };
  return fake as unknown as IORedis;
}

describe("LiquidationsCache", () => {
  it("push + getRecent roundtrip preserves entries", async () => {
    const cache = createRedisLiquidationsCache(makeFakeRedis());
    await cache.push("BTCUSDT", { ts: 1000, side: "Sell", sizeUsd: 50_000 });
    await cache.push("BTCUSDT", { ts: 2000, side: "Buy", sizeUsd: 25_000 });
    const got = await cache.getRecent("BTCUSDT", 0);
    expect(got.length).toBe(2);
    const sells = got.filter((e) => e.side === "Sell");
    expect(sells[0]!.sizeUsd).toBe(50_000);
    expect(sells[0]!.ts).toBe(1000);
  });

  it("getRecent excludes entries before cutoff", async () => {
    const cache = createRedisLiquidationsCache(makeFakeRedis());
    await cache.push("ETHUSDT", { ts: 1000, side: "Sell", sizeUsd: 10_000 });
    await cache.push("ETHUSDT", { ts: 5000, side: "Sell", sizeUsd: 20_000 });
    await cache.push("ETHUSDT", { ts: 9000, side: "Sell", sizeUsd: 30_000 });
    const recent = await cache.getRecent("ETHUSDT", 5000);
    expect(recent.length).toBe(2);
    expect(recent.every((e) => e.ts >= 5000)).toBe(true);
  });

  it("trim removes entries strictly older than beforeMs", async () => {
    const cache = createRedisLiquidationsCache(makeFakeRedis());
    await cache.push("SOLUSDT", { ts: 100, side: "Buy", sizeUsd: 1_000 });
    await cache.push("SOLUSDT", { ts: 500, side: "Buy", sizeUsd: 2_000 });
    await cache.push("SOLUSDT", { ts: 1000, side: "Buy", sizeUsd: 3_000 });
    const removed = await cache.trim("SOLUSDT", 500);
    expect(removed).toBe(1); // only ts=100 < 500
    const remaining = await cache.getRecent("SOLUSDT", 0);
    expect(remaining.length).toBe(2);
    expect(remaining.find((e) => e.ts === 100)).toBeUndefined();
  });

  it("getRecent returns [] for unknown symbol", async () => {
    const cache = createRedisLiquidationsCache(makeFakeRedis());
    const got = await cache.getRecent("XRPUSDT", 0);
    expect(got).toEqual([]);
  });

  it("multiple prints in the same millisecond all survive (unique member suffix)", async () => {
    const cache = createRedisLiquidationsCache(makeFakeRedis());
    await cache.push("BTCUSDT", { ts: 1234, side: "Sell", sizeUsd: 1_000 });
    await cache.push("BTCUSDT", { ts: 1234, side: "Sell", sizeUsd: 2_000 });
    await cache.push("BTCUSDT", { ts: 1234, side: "Sell", sizeUsd: 3_000 });
    const got = await cache.getRecent("BTCUSDT", 0);
    expect(got.length).toBe(3);
    const total = got.reduce((acc, e) => acc + e.sizeUsd, 0);
    expect(total).toBe(6_000);
  });
});
