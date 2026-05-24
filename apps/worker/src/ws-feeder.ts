/**
 * Long-running Bybit V5 WebSocket feeder.
 *
 * Maintains one WS connection (linear perps by default), subscribes to a
 * configured symbol set, and publishes every snapshot/delta update to the
 * Redis-backed caches:
 *   - tickers   → SharedTickerCache
 *   - orderbook → SharedOrderbookCache (Phase 2)
 *   - liquidations (publicTrade with BT=true) → LiquidationsCache (Phase 2)
 *
 * Other processes (scanner, trader strategies, future tick handlers) read
 * live data from those caches.
 *
 * Cost: ~1-5KB/sec, one persistent connection.
 */
import {
  createBybitWsClient,
  type BybitWsClient,
} from "@ai-scalper/bybit-client/ws";
import {
  createRedisTickerCache,
  type SharedTickerCache,
} from "@ai-scalper/bybit-client/ws-redis-cache";
import {
  createRedisOrderbookCache,
  type SharedOrderbookCache,
} from "@ai-scalper/bybit-client/ws-redis-orderbook-cache";
import type IORedis from "ioredis";
import {
  createRedisLiquidationsCache,
  type LiquidationsCache,
} from "./liquidations-cache";

export interface WsFeederOptions {
  symbols: string[];                 // ticker symbols (back-compat)
  orderbookSymbols?: string[];       // defaults to `symbols`
  orderbookDepth?: 1 | 50;           // default 50
  liquidationSymbols?: string[];     // defaults to `symbols`
  redis: IORedis;
  baseUrl?: string;
  category?: "linear" | "spot" | "inverse";
  keyPrefix?: string;
  ttlMs?: number;
  /** Rolling window kept in the liquidations ZSET. Default 5 min. */
  liquidationWindowMs?: number;
  pingIntervalMs?: number;
  /** Optional custom logger; defaults to console.log JSON line. */
  log?: (row: Record<string, unknown>) => void;
}

export interface WsFeederHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly client: BybitWsClient;
  /** Back-compat alias for tickerCache. */
  readonly cache: SharedTickerCache;
  readonly tickerCache: SharedTickerCache;
  readonly orderbookCache: SharedOrderbookCache;
  readonly liquidationsCache: LiquidationsCache;
}

const DEFAULT_LIQ_WINDOW_MS = 5 * 60 * 1000;

const defaultLog = (row: Record<string, unknown>) => {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n");
};

export function createWsFeeder(opts: WsFeederOptions): WsFeederHandle {
  const log = opts.log ?? defaultLog;
  const orderbookDepth: 1 | 50 = opts.orderbookDepth ?? 50;
  const orderbookSymbols = opts.orderbookSymbols ?? opts.symbols;
  const liquidationSymbols = opts.liquidationSymbols ?? opts.symbols;
  const liquidationWindowMs = opts.liquidationWindowMs ?? DEFAULT_LIQ_WINDOW_MS;

  const tickerCache = createRedisTickerCache(opts.redis, {
    keyPrefix: opts.keyPrefix,
    ttlMs: opts.ttlMs,
  });
  const orderbookCache = createRedisOrderbookCache(opts.redis, {
    keyPrefix: opts.keyPrefix,
    ttlMs: opts.ttlMs,
  });
  const liquidationsCache = createRedisLiquidationsCache(opts.redis, {
    keyPrefix: opts.keyPrefix,
    ttlMs: liquidationWindowMs * 2, // keep ZSET around for >= 2x window
  });

  const client = createBybitWsClient({
    baseUrl: opts.baseUrl,
    category: opts.category,
    pingIntervalMs: opts.pingIntervalMs,
  });

  // Pipe every ticker update into Redis. Errors are logged but never throw —
  // we never want a publish failure to kill the feeder process.
  client.onTicker((ticker) => {
    void tickerCache.publishTicker(ticker).catch((err) => {
      log({ event: "ws-feeder-publish-failed", feed: "ticker", symbol: ticker.symbol, err: String(err) });
    });
  });

  client.onOrderbook((book) => {
    void orderbookCache.publishOrderbook(book).catch((err) => {
      log({ event: "ws-feeder-publish-failed", feed: "orderbook", symbol: book.symbol, err: String(err) });
    });
  });

  // Trim cadence: ~every 60s per symbol, sufficient to keep ZSET bounded.
  const lastTrimAt = new Map<string, number>();
  const TRIM_EVERY_MS = 60_000;

  client.onPublicTrade((trade) => {
    // Filter: only liquidation prints (Bybit V5 `BT=true`).
    if (!trade.isLiquidation) return;
    const sizeUsd = Number(trade.price) * Number(trade.size);
    if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) return;
    const entry = { ts: trade.ts, side: trade.side, sizeUsd };
    void liquidationsCache.push(trade.symbol, entry).catch((err) => {
      log({ event: "ws-feeder-publish-failed", feed: "liquidation", symbol: trade.symbol, err: String(err) });
    });

    // Opportunistic trim of stale entries (>window) once per minute per symbol.
    const now = Date.now();
    const last = lastTrimAt.get(trade.symbol) ?? 0;
    if (now - last >= TRIM_EVERY_MS) {
      lastTrimAt.set(trade.symbol, now);
      void liquidationsCache.trim(trade.symbol, now - liquidationWindowMs).catch((err) => {
        log({ event: "ws-feeder-trim-failed", symbol: trade.symbol, err: String(err) });
      });
    }
  });

  return {
    client,
    cache: tickerCache,
    tickerCache,
    orderbookCache,
    liquidationsCache,
    async start() {
      log({
        event: "ws-feeder-starting",
        tickerSymbols: opts.symbols,
        orderbookSymbols,
        orderbookDepth,
        liquidationSymbols,
        category: opts.category ?? "linear",
      });
      await client.start();
      for (const symbol of opts.symbols) {
        await client.subscribeTicker(symbol);
      }
      for (const symbol of orderbookSymbols) {
        await client.subscribeOrderbook(symbol, orderbookDepth);
      }
      for (const symbol of liquidationSymbols) {
        await client.subscribePublicTrade(symbol);
      }
      log({ event: "ws-feeder-ready", subscriptions: client.getSubscriptions() });
    },
    async stop() {
      log({ event: "ws-feeder-stopping" });
      await client.stop();
      await tickerCache.close();
      await orderbookCache.close();
      await liquidationsCache.close();
      log({ event: "ws-feeder-stopped", stats: client.getStats() });
    },
  };
}
