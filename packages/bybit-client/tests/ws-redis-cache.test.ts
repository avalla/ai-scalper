import { describe, expect, it } from "bun:test";
import type IORedis from "ioredis";
import { createRedisTickerCache } from "../src/ws-redis-cache";
import type { MarketTicker } from "../src/index";

// -- Minimal in-memory fake Redis client implementing only the surface used
//    by the cache: hset(obj), hgetall, hget, pexpire, publish, multi/exec,
//    subscribe, unsubscribe, quit, on, duplicate.

interface FakeEntry { fields: Record<string, string>; expiresAt: number | null; }

function makeFakeRedis(now: () => number = () => Date.now()): IORedis {
  const data = new Map<string, FakeEntry>();
  const messageListeners: ((channel: string, payload: string) => void)[] = [];
  const subscriptions = new Set<string>();

  function evictIfExpired(key: string): FakeEntry | null {
    const entry = data.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && now() >= entry.expiresAt) {
      data.delete(key);
      return null;
    }
    return entry;
  }

  const fake: Record<string, unknown> = {
    async hset(key: string, obj: Record<string, string>) {
      const existing = data.get(key) ?? { fields: {}, expiresAt: null };
      Object.assign(existing.fields, obj);
      data.set(key, existing);
      return Object.keys(obj).length;
    },
    async hgetall(key: string): Promise<Record<string, string>> {
      const entry = evictIfExpired(key);
      return entry ? { ...entry.fields } : {};
    },
    async hget(key: string, field: string): Promise<string | null> {
      const entry = evictIfExpired(key);
      return entry?.fields[field] ?? null;
    },
    async pexpire(key: string, ms: number) {
      const entry = data.get(key);
      if (!entry) return 0;
      entry.expiresAt = now() + ms;
      return 1;
    },
    async publish(channel: string, payload: string) {
      let count = 0;
      if (subscriptions.has(channel)) {
        for (const l of messageListeners) {
          l(channel, payload);
          count += 1;
        }
      }
      return count;
    },
    multi() {
      const ops: (() => Promise<unknown>)[] = [];
      const chain: Record<string, unknown> = {
        hset: (k: string, o: Record<string, string>) => {
          ops.push(() => (fake.hset as (k: string, o: Record<string, string>) => Promise<number>)(k, o));
          return chain;
        },
        pexpire: (k: string, m: number) => {
          ops.push(() => (fake.pexpire as (k: string, m: number) => Promise<number>)(k, m));
          return chain;
        },
        publish: (c: string, p: string) => {
          ops.push(() => (fake.publish as (c: string, p: string) => Promise<number>)(c, p));
          return chain;
        },
        exec: async () => {
          for (const op of ops) await op();
          return [];
        },
      };
      return chain;
    },
    async subscribe(channel: string) {
      subscriptions.add(channel);
      return 1;
    },
    async unsubscribe(channel: string) {
      subscriptions.delete(channel);
      return 0;
    },
    async quit() { return "OK"; },
    on(event: string, listener: (channel: string, payload: string) => void) {
      if (event === "message") messageListeners.push(listener);
      return fake;
    },
    duplicate() {
      // Share state so subscriber sees publishes from the main connection.
      return fake as unknown as IORedis;
    },
  };
  return fake as unknown as IORedis;
}

const sampleTicker: MarketTicker = {
  symbol: "BTCUSDT",
  lastPrice: "100.0",
  markPrice: "100.0",
  indexPrice: "100.0",
  prevPrice1h: "99.5",
  prevPrice24h: "98.0",
  price24hPcnt: "0.02",
  turnover24h: "1000000",
  volume24h: "100",
  openInterestValue: "5000000",
  fundingRate: "0.0001",
  nextFundingTime: "1700000000000",
  bid1Price: "99.99",
  ask1Price: "100.01",
  bid1Size: "10",
  ask1Size: "10",
};

describe("redis ticker cache", () => {
  it("publishTicker + getTicker round-trip", async () => {
    const cache = createRedisTickerCache(makeFakeRedis(), { keyPrefix: "test" });
    await cache.publishTicker(sampleTicker);
    const got = await cache.getTicker("BTCUSDT");
    expect(got).not.toBeNull();
    expect(got!.lastPrice).toBe("100.0");
    expect(got!.symbol).toBe("BTCUSDT");
    expect(got!.bid1Price).toBe("99.99");
    await cache.close();
  });

  it("getAge returns null for missing symbol and a small positive value after publish", async () => {
    const cache = createRedisTickerCache(makeFakeRedis(), { keyPrefix: "test" });
    expect(await cache.getAge("XRPUSDT")).toBeNull();
    await cache.publishTicker(sampleTicker);
    const age = await cache.getAge("BTCUSDT");
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(0);
    expect(age!).toBeLessThan(1000);
    await cache.close();
  });

  it("TTL expires entries — getTicker returns null after ttlMs elapses", async () => {
    let virtualNow = 1_000_000;
    const fake = makeFakeRedis(() => virtualNow);
    const cache = createRedisTickerCache(fake, { keyPrefix: "test", ttlMs: 100 });
    await cache.publishTicker(sampleTicker);
    virtualNow += 50;
    expect(await cache.getTicker("BTCUSDT")).not.toBeNull();
    virtualNow += 200;
    expect(await cache.getTicker("BTCUSDT")).toBeNull();
    await cache.close();
  });

  it("subscribe delivers published tickers to handlers", async () => {
    const cache = createRedisTickerCache(makeFakeRedis(), { keyPrefix: "test" });
    const received: MarketTicker[] = [];
    cache.subscribe((t) => { received.push(t); });
    // Allow the async subscribe() inside ensureSubscriber to complete.
    await new Promise((r) => setTimeout(r, 5));
    await cache.publishTicker(sampleTicker);
    await cache.publishTicker({ ...sampleTicker, lastPrice: "101.5" });
    expect(received.length).toBe(2);
    expect(received[1]!.lastPrice).toBe("101.5");
    await cache.close();
  });
});
