import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MarketKline } from "@ai-scalper/bybit-client";
import { fetchHistoricalKlines } from "./historical-data";

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ai-scalper-bt-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const fakeKlines: MarketKline[] = [{
  startTime: "1", openPrice: "1", highPrice: "1", lowPrice: "1",
  closePrice: "1", volume: "1", turnover: "1",
}];

describe("fetchHistoricalKlines", () => {
  test("fetches from API on cache miss and writes a cache file", async () => {
    const { dir, cleanup } = tmpDir();
    try {
      let calls = 0;
      const out = await fetchHistoricalKlines(
        { symbol: "BTCUSDT", interval: "15", start: 1, end: 2 },
        {
          cacheDir: dir,
          fetchKlinesFromApi: async () => { calls += 1; return fakeKlines; },
        },
      );
      expect(out).toEqual(fakeKlines);
      expect(calls).toBe(1);
      // Cache file exists
      const cachePath = join(dir, "BTCUSDT__15__1__2.json");
      expect(existsSync(cachePath)).toBe(true);
      expect(JSON.parse(readFileSync(cachePath, "utf8"))).toEqual(fakeKlines);
    } finally { cleanup(); }
  });

  test("uses the cache on the second call (does NOT hit the API)", async () => {
    const { dir, cleanup } = tmpDir();
    try {
      let calls = 0;
      const params = { symbol: "BTCUSDT", interval: "15", start: 1, end: 2 };
      await fetchHistoricalKlines(params, {
        cacheDir: dir,
        fetchKlinesFromApi: async () => { calls += 1; return fakeKlines; },
      });
      const second = await fetchHistoricalKlines(params, {
        cacheDir: dir,
        fetchKlinesFromApi: async () => { calls += 1; return [] as MarketKline[]; },
      });
      expect(second).toEqual(fakeKlines);
      expect(calls).toBe(1); // only the first call hit the API
    } finally { cleanup(); }
  });

  test("differing key parameters create separate cache entries", async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const fetcher = async () => fakeKlines;
      await fetchHistoricalKlines({ symbol: "BTCUSDT", interval: "15", start: 1, end: 2 }, {
        cacheDir: dir, fetchKlinesFromApi: fetcher,
      });
      await fetchHistoricalKlines({ symbol: "BTCUSDT", interval: "60", start: 1, end: 2 }, {
        cacheDir: dir, fetchKlinesFromApi: fetcher,
      });
      expect(existsSync(join(dir, "BTCUSDT__15__1__2.json"))).toBe(true);
      expect(existsSync(join(dir, "BTCUSDT__60__1__2.json"))).toBe(true);
    } finally { cleanup(); }
  });

  test("corrupt cache file falls back to API refetch", async () => {
    const { dir, cleanup } = tmpDir();
    try {
      // Pre-write a corrupt cache file at the expected key
      const params = { symbol: "BTCUSDT", interval: "15", start: 1, end: 2 };
      const path = join(dir, "BTCUSDT__15__1__2.json");
      const { writeFileSync, mkdirSync } = await import("node:fs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, "not-json");

      let calls = 0;
      const out = await fetchHistoricalKlines(params, {
        cacheDir: dir,
        fetchKlinesFromApi: async () => { calls += 1; return fakeKlines; },
      });
      expect(calls).toBe(1);
      expect(out).toEqual(fakeKlines);
    } finally { cleanup(); }
  });
});
