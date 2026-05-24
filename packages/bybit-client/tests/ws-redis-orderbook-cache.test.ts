import { describe, expect, it } from "bun:test";
import type IORedis from "ioredis";
import { createRedisOrderbookCache } from "../src/ws-redis-orderbook-cache";
import type { OrderbookSnapshot } from "../src/ws";

interface FakeEntry { fields: Record<string, string>; expiresAt: number | null; }

function makeFakeRedis(now: () => number = () => Date.now()): IORedis {
  const data = new Map<string, FakeEntry>();
  const listeners: ((channel: string, payload: string) => void)[] = [];
  const subs = new Set<string>();

  function evict(key: string): FakeEntry | null {
    const e = data.get(key);
    if (!e) return null;
    if (e.expiresAt !== null && now() >= e.expiresAt) { data.delete(key); return null; }
    return e;
  }

  const fake: Record<string, unknown> = {
    async hset(key: string, obj: Record<string, string>) {
      const e = data.get(key) ?? { fields: {}, expiresAt: null };
      Object.assign(e.fields, obj); data.set(key, e); return Object.keys(obj).length;
    },
    async hgetall(key: string) { const e = evict(key); return e ? { ...e.fields } : {}; },
    async hget(key: string, field: string) { const e = evict(key); return e?.fields[field] ?? null; },
    async pexpire(key: string, ms: number) {
      const e = data.get(key); if (!e) return 0; e.expiresAt = now() + ms; return 1;
    },
    async publish(ch: string, p: string) {
      if (!subs.has(ch)) return 0;
      for (const l of listeners) l(ch, p);
      return listeners.length;
    },
    multi() {
      const ops: (() => Promise<unknown>)[] = [];
      const chain: Record<string, unknown> = {
        hset(k: string, o: Record<string, string>) { ops.push(() => (fake.hset as (k: string, o: Record<string, string>) => Promise<unknown>)(k, o)); return chain; },
        pexpire(k: string, ms: number) { ops.push(() => (fake.pexpire as (k: string, ms: number) => Promise<unknown>)(k, ms)); return chain; },
        publish(c: string, m: string) { ops.push(() => (fake.publish as (c: string, m: string) => Promise<unknown>)(c, m)); return chain; },
        async exec() { const out: unknown[] = []; for (const o of ops) out.push([null, await o()]); return out; },
      };
      return chain;
    },
    async subscribe(ch: string) { subs.add(ch); return 1; },
    async unsubscribe(ch: string) { subs.delete(ch); return 0; },
    async quit() { return "OK"; },
    on(ev: string, fn: (ch: string, p: string) => void) {
      if (ev === "message") listeners.push(fn);
      return fake;
    },
    duplicate() { return fake as unknown as IORedis; },
  };
  return fake as unknown as IORedis;
}

function sampleBook(symbol = "BTCUSDT"): OrderbookSnapshot {
  return {
    symbol,
    bids: [["100", "1"], ["99", "2"]],
    asks: [["101", "1"], ["102", "2"]],
    updateId: 1,
    seq: 1,
    updatedAt: Date.now(),
  };
}

describe("SharedOrderbookCache", () => {
  it("publish + getOrderbook roundtrip preserves bids/asks", async () => {
    const redis = makeFakeRedis();
    const cache = createRedisOrderbookCache(redis);
    await cache.publishOrderbook(sampleBook());
    const got = await cache.getOrderbook("BTCUSDT");
    expect(got).not.toBeNull();
    expect(got!.bids).toEqual([["100", "1"], ["99", "2"]]);
    expect(got!.asks).toEqual([["101", "1"], ["102", "2"]]);
    expect(got!.updateId).toBe(1);
  });

  it("getOrderbook returns null for unknown symbol", async () => {
    const cache = createRedisOrderbookCache(makeFakeRedis());
    expect(await cache.getOrderbook("ETHUSDT")).toBeNull();
  });

  it("getAge returns elapsed time since publish", async () => {
    let t = 0;
    const redis = makeFakeRedis(() => t);
    const cache = createRedisOrderbookCache(redis);
    await cache.publishOrderbook(sampleBook());
    t = 500;
    const age = await cache.getAge("BTCUSDT");
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(0);
  });

  it("subscribe handler receives pub/sub messages", async () => {
    const redis = makeFakeRedis();
    const cache = createRedisOrderbookCache(redis);
    const received: OrderbookSnapshot[] = [];
    cache.subscribe((b) => received.push(b));
    // give ensureSubscriber a tick to subscribe
    await new Promise((r) => setTimeout(r, 0));
    await cache.publishOrderbook(sampleBook("ETHUSDT"));
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0]!.symbol).toBe("ETHUSDT");
    await cache.close();
  });
});
