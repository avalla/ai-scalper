import { describe, expect, it } from "bun:test";
import type IORedis from "ioredis";
import { createRedisLiquidationsReader } from "./liquidations-cache-reader";

interface FakeZsetEntry {
  members: { score: number; member: string }[];
  expiresAt: number | null;
}

/**
 * Minimal IORedis stub supporting just `zadd` + `zrangebyscore`. Mirrors the
 * fake used by `apps/worker/src/liquidations-cache.test.ts` so the reader
 * sees the same wire format the feeder writes.
 */
function makeFakeRedis(): IORedis {
  const data = new Map<string, FakeZsetEntry>();
  function ensure(key: string): FakeZsetEntry {
    let e = data.get(key);
    if (!e) {
      e = { members: [], expiresAt: null };
      data.set(key, e);
    }
    return e;
  }
  const fake: Record<string, unknown> = {
    async zadd(key: string, score: number, member: string) {
      ensure(key).members.push({ score, member });
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
  };
  return fake as unknown as IORedis;
}

function writeEntry(
  redis: IORedis,
  symbol: string,
  entry: { ts: number; side: "Buy" | "Sell"; sizeUsd: number; rand?: string },
  prefix = "ws",
): Promise<unknown> {
  const member = JSON.stringify({
    ts: entry.ts,
    side: entry.side,
    sizeUsd: entry.sizeUsd,
    _r: entry.rand ?? "abc123",
  });
  return (redis as unknown as { zadd: (k: string, s: number, m: string) => Promise<number> })
    .zadd(`${prefix}:liquidations:${symbol.toUpperCase()}`, entry.ts, member);
}

describe("createRedisLiquidationsReader", () => {
  it("returns entries since cutoff sorted by ts ascending", async () => {
    const redis = makeFakeRedis();
    await writeEntry(redis, "BTCUSDT", { ts: 5_000, side: "Sell", sizeUsd: 20_000, rand: "z" });
    await writeEntry(redis, "BTCUSDT", { ts: 3_000, side: "Sell", sizeUsd: 10_000, rand: "a" });
    await writeEntry(redis, "BTCUSDT", { ts: 7_000, side: "Buy", sizeUsd: 30_000, rand: "m" });

    const reader = createRedisLiquidationsReader(redis);
    const got = await reader.getRecent("BTCUSDT", 0);

    expect(got.length).toBe(3);
    expect(got.map((e) => e.ts)).toEqual([3_000, 5_000, 7_000]);
    expect(got[0]).toEqual({ ts: 3_000, side: "Sell", sizeUsd: 10_000 });
    expect(got[2]).toEqual({ ts: 7_000, side: "Buy", sizeUsd: 30_000 });
  });

  it("excludes entries before sinceMs cutoff", async () => {
    const redis = makeFakeRedis();
    await writeEntry(redis, "ETHUSDT", { ts: 1_000, side: "Sell", sizeUsd: 1, rand: "a" });
    await writeEntry(redis, "ETHUSDT", { ts: 4_999, side: "Sell", sizeUsd: 2, rand: "b" });
    await writeEntry(redis, "ETHUSDT", { ts: 5_000, side: "Sell", sizeUsd: 3, rand: "c" });
    await writeEntry(redis, "ETHUSDT", { ts: 9_000, side: "Sell", sizeUsd: 4, rand: "d" });

    const reader = createRedisLiquidationsReader(redis);
    const got = await reader.getRecent("ETHUSDT", 5_000);

    expect(got.map((e) => e.ts)).toEqual([5_000, 9_000]);
  });

  it("returns empty array for unknown symbol", async () => {
    const reader = createRedisLiquidationsReader(makeFakeRedis());
    expect(await reader.getRecent("XRPUSDT", 0)).toEqual([]);
  });

  it("parses member format (drops _r suffix) and uppercases symbol in key lookup", async () => {
    const redis = makeFakeRedis();
    // Write at uppercased key (matches feeder behaviour)
    await writeEntry(redis, "SOLUSDT", { ts: 1234, side: "Buy", sizeUsd: 99_999, rand: "xyz" });

    const reader = createRedisLiquidationsReader(redis);
    // Look up via lowercase — reader must uppercase internally.
    const got = await reader.getRecent("solusdt", 0);

    expect(got).toEqual([{ ts: 1234, side: "Buy", sizeUsd: 99_999 }]);
    // _r should NOT appear in the parsed entry.
    expect((got[0] as unknown as Record<string, unknown>)._r).toBeUndefined();
  });

  it("skips malformed members rather than throwing", async () => {
    const redis = makeFakeRedis();
    // One valid + one corrupt member.
    await writeEntry(redis, "BTCUSDT", { ts: 100, side: "Sell", sizeUsd: 1_000, rand: "v" });
    await (redis as unknown as { zadd: (k: string, s: number, m: string) => Promise<number> })
      .zadd("ws:liquidations:BTCUSDT", 200, "{not valid json");
    await (redis as unknown as { zadd: (k: string, s: number, m: string) => Promise<number> })
      .zadd("ws:liquidations:BTCUSDT", 300, JSON.stringify({ ts: "wrong-type", side: "Sell", sizeUsd: 1 }));

    const reader = createRedisLiquidationsReader(redis);
    const got = await reader.getRecent("BTCUSDT", 0);
    expect(got.length).toBe(1);
    expect(got[0]?.ts).toBe(100);
  });

  it("honours custom keyPrefix", async () => {
    const redis = makeFakeRedis();
    await writeEntry(redis, "BTCUSDT", { ts: 10, side: "Sell", sizeUsd: 1, rand: "a" }, "custom");

    const reader = createRedisLiquidationsReader(redis, { keyPrefix: "custom" });
    const got = await reader.getRecent("BTCUSDT", 0);
    expect(got.length).toBe(1);

    // The default-prefix reader should see nothing under "ws:..."
    const defaultReader = createRedisLiquidationsReader(redis);
    expect(await defaultReader.getRecent("BTCUSDT", 0)).toEqual([]);
  });
});
