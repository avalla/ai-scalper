/**
 * Event Feeder CLI — long-lived subprocess. Polls Bybit announcements +
 * funding extremes every N minutes, writes new events to a Redis sorted set
 * (`ai-scalper:events:recent`) scored by observedAt timestamp.
 *
 * Downstream consumers (advisor, risk officer, future strategy gates) can
 * ZRANGEBYSCORE the key for recent events.
 */

import IORedis from "ioredis";
import { readTraderConfig } from "../config";
import {
  classifyBybitAnnouncement, detectFundingExtremes, dedupEvents,
  type MarketEvent,
} from "./event-feeder";

const EVENTS_KEY = "ai-scalper:events:recent";
const EVENTS_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const DEDUP_RETENTION_SIZE = 5000;

async function fetchBybitAnnouncements(baseUrl: string): Promise<MarketEvent[]> {
  try {
    const url = `${baseUrl}/v5/announcements/index?locale=en-US&limit=20`;
    const r = await fetch(url);
    const j = await r.json() as { retCode?: number; result?: { list?: unknown[] } };
    if (j.retCode !== 0) return [];
    const observedAt = new Date().toISOString();
    return ((j.result?.list ?? []) as Array<Record<string, unknown>>)
      .map((a) => classifyBybitAnnouncement(a as never, observedAt))
      .filter((e): e is MarketEvent => e !== null);
  } catch {
    return [];
  }
}

async function fetchFundingExtremes(baseUrl: string, thresholdBps: number, topN: number): Promise<MarketEvent[]> {
  try {
    const r = await fetch(`${baseUrl}/v5/market/tickers?category=linear`);
    const j = await r.json() as { retCode?: number; result?: { list?: Array<{ symbol: string; fundingRate: string; turnover24h?: string }> } };
    if (j.retCode !== 0) return [];
    return detectFundingExtremes(j.result?.list ?? [], new Date().toISOString(), { thresholdBps, topN });
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const cfg = readTraderConfig(process.env);
  if (!cfg.eventFeederEnabled) {
    console.log(JSON.stringify({ event: "event-feeder-disabled", reason: "eventFeeder.enabled=false" }));
    return;
  }
  const baseUrl = process.env.BYBIT_BASE_URL || "https://api.bybit.com";
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.warn(JSON.stringify({ event: "event-feeder-disabled", reason: "no REDIS_URL" }));
    return;
  }
  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const intervalMs = Math.max(cfg.eventFeederIntervalMinutes * 60_000, 60_000);
  const seenIds = new Set<string>();

  console.log(JSON.stringify({
    event: "event-feeder-loop-started",
    intervalMinutes: cfg.eventFeederIntervalMinutes,
    fundingThresholdBps: cfg.eventFeederFundingThresholdBps,
    fundingTopN: cfg.eventFeederFundingTopN,
  }));

  while (true) {
    try {
      const [annEvents, fundingEvents] = await Promise.all([
        fetchBybitAnnouncements(baseUrl),
        fetchFundingExtremes(baseUrl, cfg.eventFeederFundingThresholdBps, cfg.eventFeederFundingTopN),
      ]);
      const allEvents = [...annEvents, ...fundingEvents];
      const fresh = dedupEvents(allEvents, seenIds);

      // Trim dedup set to avoid unbounded growth.
      if (seenIds.size > DEDUP_RETENTION_SIZE) {
        const arr = Array.from(seenIds);
        seenIds.clear();
        arr.slice(-Math.floor(DEDUP_RETENTION_SIZE / 2)).forEach((id) => seenIds.add(id));
      }

      if (fresh.length > 0) {
        const pipeline = redis.pipeline();
        for (const e of fresh) {
          const score = Date.parse(e.observedAt);
          pipeline.zadd(EVENTS_KEY, score, JSON.stringify(e));
        }
        // Prune events older than retention window.
        pipeline.zremrangebyscore(EVENTS_KEY, "-inf", Date.now() - EVENTS_MAX_AGE_MS);
        await pipeline.exec();

        for (const e of fresh) {
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            event: "event-feeder-new-event",
            source: e.source, signal: e.signal, sentiment: e.sentiment,
            symbols: e.symbols, title: e.title,
          }));
        }
      } else {
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          event: "event-feeder-poll", fresh: 0,
          totalScanned: allEvents.length,
        }));
      }
    } catch (err) {
      console.warn(JSON.stringify({
        ts: new Date().toISOString(),
        event: "event-feeder-tick-failed",
        error: err instanceof Error ? err.message : String(err),
      }));
    }
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ event: "event-feeder-fatal", error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
