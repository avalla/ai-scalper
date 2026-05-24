/**
 * Bybit V5 WebSocket client (public stream — linear/spot/inverse).
 *
 * Scope: ticker subscriptions only (Phase 1). Maintains a per-symbol cache
 * with snapshot+delta merging, heartbeat ping/pong, exponential reconnect
 * with automatic re-subscribe.
 *
 * Production uses Bun's built-in `WebSocket`. Tests inject a fake transport
 * via `WsTransport` (DI) to avoid network I/O.
 */
import type { MarketTicker } from "./index";

export type WsCategory = "linear" | "spot" | "inverse";

export interface BybitWsOptions {
  baseUrl?: string;
  category?: WsCategory;
  pingIntervalMs?: number;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  /**
   * Inject a custom WebSocket constructor — used by tests to substitute a
   * fake transport. Defaults to `globalThis.WebSocket` (Bun built-in).
   */
  transport?: WsTransportFactory;
  /**
   * Replace the timer scheduler. Tests use a fake scheduler that exposes
   * `tick(ms)`. Defaults to setTimeout/clearTimeout/setInterval.
   */
  scheduler?: WsScheduler;
  /**
   * Optional logger. Defaults to a no-op (production wires the pino logger).
   */
  logger?: WsLogger;
}

export interface WsLogger {
  info(obj: Record<string, unknown>): void;
  warn(obj: Record<string, unknown>): void;
  error(obj: Record<string, unknown>): void;
}

export interface WsScheduler {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  now(): number;
}

/**
 * Minimal WebSocket surface used by this client. Compatible with the
 * browser-style WebSocket exposed by Bun.
 */
export interface WsTransport {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  onopen: ((this: WsTransport, ev: unknown) => void) | null;
  onmessage: ((this: WsTransport, ev: { data: string | ArrayBuffer | Buffer }) => void) | null;
  onclose: ((this: WsTransport, ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((this: WsTransport, ev: unknown) => void) | null;
}

export type WsTransportFactory = (url: string) => WsTransport;

export interface BybitWsStats {
  messagesReceived: number;
  reconnects: number;
  lastMessageAt: number | null;
}

export interface BybitWsClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribeTicker(symbol: string): Promise<void>;
  unsubscribeTicker(symbol: string): Promise<void>;
  getCachedTicker(symbol: string): MarketTicker | null;
  onTicker(handler: (ticker: MarketTicker) => void): () => void;
  getSubscriptions(): string[];
  isConnected(): boolean;
  getStats(): BybitWsStats;
}

const DEFAULT_BASE_URL = "wss://stream.bybit.com/v5/public";
const DEFAULT_CATEGORY: WsCategory = "linear";
const DEFAULT_PING_MS = 20_000;
const DEFAULT_RECONNECT_INITIAL_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

const noopLogger: WsLogger = {
  info() {},
  warn() {},
  error() {},
};

const defaultScheduler: WsScheduler = {
  setTimeout: (h, ms) => globalThis.setTimeout(h, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (h, ms) => globalThis.setInterval(h, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  now: () => Date.now(),
};

function defaultTransportFactory(url: string): WsTransport {
  const WS = (globalThis as { WebSocket?: new (u: string) => WsTransport }).WebSocket;
  if (!WS) {
    throw new Error("globalThis.WebSocket is not available — Bun/browser runtime required");
  }
  return new WS(url);
}

function buildWsUrl(baseUrl: string, category: WsCategory): string {
  // baseUrl may already include the full path; if it does, use as-is.
  if (/\/v5\/public(\/(linear|spot|inverse))?$/.test(baseUrl)) {
    return baseUrl.endsWith(category) ? baseUrl : `${baseUrl.replace(/\/(linear|spot|inverse)$/, "")}/${category}`;
  }
  return `${baseUrl.replace(/\/$/, "")}/${category}`;
}

type WsTickerMessage = {
  topic?: string;
  type?: "snapshot" | "delta";
  data?: Partial<MarketTicker> & { symbol?: string };
  ts?: number;
  op?: string;
  success?: boolean;
  ret_msg?: string;
};

/** WebSocket.readyState constants (per spec). Mirrored to avoid runtime deps. */
const WS_OPEN = 1;

export function createBybitWsClient(options: BybitWsOptions = {}): BybitWsClient {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const category = options.category ?? DEFAULT_CATEGORY;
  const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_MS;
  const reconnectInitialDelayMs = options.reconnectInitialDelayMs ?? DEFAULT_RECONNECT_INITIAL_MS;
  const reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_MS;
  const transportFactory = options.transport ?? defaultTransportFactory;
  const scheduler = options.scheduler ?? defaultScheduler;
  const logger = options.logger ?? noopLogger;

  const url = buildWsUrl(baseUrl, category);
  const cache = new Map<string, MarketTicker>();
  const subscriptions = new Set<string>();
  const handlers = new Set<(t: MarketTicker) => void>();
  const stats: BybitWsStats = {
    messagesReceived: 0,
    reconnects: 0,
    lastMessageAt: null,
  };

  let socket: WsTransport | null = null;
  let started = false;
  let stopped = false;
  let pingTimer: unknown = null;
  let pongWatchdog: unknown = null;
  let reconnectTimer: unknown = null;
  let reconnectAttempt = 0;
  let lastPongAt: number | null = null;
  let connectResolver: (() => void) | null = null;

  function clearPingTimers(): void {
    if (pingTimer) {
      scheduler.clearInterval(pingTimer);
      pingTimer = null;
    }
    if (pongWatchdog) {
      scheduler.clearInterval(pongWatchdog);
      pongWatchdog = null;
    }
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer) {
      scheduler.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    clearReconnectTimer();
    const delay = Math.min(
      reconnectInitialDelayMs * 2 ** reconnectAttempt,
      reconnectMaxDelayMs,
    );
    reconnectAttempt += 1;
    logger.warn({ event: "bybit-ws-reconnect-scheduled", delayMs: delay, attempt: reconnectAttempt });
    reconnectTimer = scheduler.setTimeout(() => {
      reconnectTimer = null;
      stats.reconnects += 1;
      connect();
    }, delay);
  }

  function startPingLoop(): void {
    clearPingTimers();
    lastPongAt = scheduler.now();
    pingTimer = scheduler.setInterval(() => {
      try {
        socket?.send(JSON.stringify({ op: "ping" }));
      } catch (err) {
        logger.warn({ event: "bybit-ws-ping-send-failed", err: String(err) });
      }
    }, pingIntervalMs);
    // Watchdog: if no pong within 2× ping interval, force reconnect.
    pongWatchdog = scheduler.setInterval(() => {
      const last = lastPongAt ?? 0;
      if (scheduler.now() - last > pingIntervalMs * 2) {
        logger.warn({ event: "bybit-ws-pong-timeout", lastPongAt: last });
        forceReconnect();
      }
    }, pingIntervalMs);
  }

  function forceReconnect(): void {
    clearPingTimers();
    try {
      socket?.close(4000, "pong-timeout");
    } catch {
      /* ignore */
    }
    socket = null;
    scheduleReconnect();
  }

  function applySnapshot(symbol: string, data: Partial<MarketTicker>): void {
    cache.set(symbol, { ...emptyTicker(symbol), ...data, symbol });
  }

  function applyDelta(symbol: string, data: Partial<MarketTicker>): void {
    const prev = cache.get(symbol);
    if (!prev) {
      // Defensive: treat as snapshot.
      applySnapshot(symbol, data);
      return;
    }
    cache.set(symbol, { ...prev, ...data, symbol });
  }

  function emit(symbol: string): void {
    const ticker = cache.get(symbol);
    if (!ticker) return;
    for (const handler of handlers) {
      try {
        handler(ticker);
      } catch (err) {
        logger.error({ event: "bybit-ws-handler-error", err: String(err) });
      }
    }
  }

  function handleMessage(raw: string | ArrayBuffer | Buffer): void {
    let text: string;
    if (typeof raw === "string") {
      text = raw;
    } else if (raw instanceof ArrayBuffer) {
      text = new TextDecoder().decode(raw);
    } else {
      text = Buffer.from(raw).toString("utf8");
    }

    stats.messagesReceived += 1;
    stats.lastMessageAt = scheduler.now();

    let msg: WsTickerMessage;
    try {
      msg = JSON.parse(text) as WsTickerMessage;
    } catch (err) {
      logger.warn({ event: "bybit-ws-json-parse-failed", err: String(err) });
      return;
    }

    if (msg.op === "pong" || (msg.op === "ping" && msg.success === true)) {
      lastPongAt = scheduler.now();
      return;
    }
    if (msg.op === "subscribe" || msg.op === "unsubscribe") {
      if (msg.success === false) {
        logger.warn({ event: "bybit-ws-op-failed", op: msg.op, msg: msg.ret_msg });
      }
      return;
    }

    if (!msg.topic || !msg.topic.startsWith("tickers.") || !msg.data) {
      return;
    }
    const symbol = msg.data.symbol ?? msg.topic.slice("tickers.".length);
    if (!symbol) return;

    if (msg.type === "snapshot") {
      applySnapshot(symbol, msg.data);
    } else {
      applyDelta(symbol, msg.data);
    }
    emit(symbol);
  }

  function sendSubscribe(symbols: string[]): void {
    if (symbols.length === 0) return;
    if (!socket || socket.readyState !== WS_OPEN) return;
    socket.send(JSON.stringify({
      op: "subscribe",
      args: symbols.map((s) => `tickers.${s}`),
    }));
  }

  function sendUnsubscribe(symbols: string[]): void {
    if (symbols.length === 0) return;
    if (!socket || socket.readyState !== WS_OPEN) return;
    socket.send(JSON.stringify({
      op: "unsubscribe",
      args: symbols.map((s) => `tickers.${s}`),
    }));
  }

  function connect(): void {
    if (stopped) return;
    try {
      socket = transportFactory(url);
    } catch (err) {
      logger.error({ event: "bybit-ws-create-failed", err: String(err) });
      scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      logger.info({ event: "bybit-ws-open", url });
      reconnectAttempt = 0;
      startPingLoop();
      // Re-subscribe to all known topics on (re)connect.
      const all = Array.from(subscriptions);
      if (all.length > 0) sendSubscribe(all);
      if (connectResolver) {
        connectResolver();
        connectResolver = null;
      }
    };

    socket.onmessage = (ev) => {
      handleMessage(ev.data);
    };

    socket.onclose = (ev) => {
      logger.warn({ event: "bybit-ws-close", code: ev?.code, reason: ev?.reason });
      clearPingTimers();
      socket = null;
      if (!stopped) scheduleReconnect();
    };

    socket.onerror = (ev) => {
      logger.error({ event: "bybit-ws-error", err: String((ev as { message?: unknown })?.message ?? "unknown") });
      // onclose will follow and trigger reconnect.
    };
  }

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    stopped = false;
    await new Promise<void>((resolve) => {
      connectResolver = resolve;
      connect();
      // If the transport synchronously sets readyState OPEN (shouldn't normally),
      // the resolver above still fires via onopen. We also resolve immediately
      // after a microtask to avoid blocking forever in unit tests that never
      // invoke open synchronously — start() resolves once the transport exists.
      // The actual readiness is captured by `isConnected()`.
      queueMicrotask(() => {
        if (connectResolver) {
          const r = connectResolver;
          connectResolver = null;
          r();
        }
      });
    });
  }

  async function stop(): Promise<void> {
    stopped = true;
    started = false;
    clearPingTimers();
    clearReconnectTimer();
    try {
      socket?.close(1000, "client-stop");
    } catch {
      /* ignore */
    }
    socket = null;
  }

  async function subscribeTicker(symbol: string): Promise<void> {
    const sym = symbol.toUpperCase();
    if (subscriptions.has(sym)) return;
    subscriptions.add(sym);
    sendSubscribe([sym]);
  }

  async function unsubscribeTicker(symbol: string): Promise<void> {
    const sym = symbol.toUpperCase();
    if (!subscriptions.has(sym)) return;
    subscriptions.delete(sym);
    cache.delete(sym);
    sendUnsubscribe([sym]);
  }

  return {
    start,
    stop,
    subscribeTicker,
    unsubscribeTicker,
    getCachedTicker(symbol) {
      return cache.get(symbol.toUpperCase()) ?? null;
    },
    onTicker(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    getSubscriptions() {
      return Array.from(subscriptions);
    },
    isConnected() {
      return socket !== null && socket.readyState === WS_OPEN;
    },
    getStats() {
      return { ...stats };
    },
  };
}

function emptyTicker(symbol: string): MarketTicker {
  return {
    symbol,
    lastPrice: "",
    markPrice: "",
    indexPrice: "",
    prevPrice1h: "",
    prevPrice24h: "",
    price24hPcnt: "",
    turnover24h: "",
    volume24h: "",
    openInterestValue: "",
    fundingRate: "",
    nextFundingTime: "",
    bid1Price: "",
    ask1Price: "",
    bid1Size: "",
    ask1Size: "",
  };
}
