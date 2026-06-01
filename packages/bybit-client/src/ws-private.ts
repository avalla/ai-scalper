/**
 * Bybit V5 PRIVATE WebSocket client. Maintains a single connection to
 * `wss://stream.bybit.com/v5/private`, authenticates via HMAC-SHA256, and
 * subscribes to `position` updates (executions / orders can be added later
 * by extending `subscribeChannels`).
 *
 * Scope-down vs. the public client:
 *   - Single category (linear, by default) — Bybit unifies private streams
 *     under one endpoint regardless of contract type, but the cache is keyed
 *     by symbol only (collision-free since v5 positions are per-symbol).
 *   - No orderbook / trade / ticker cache (those belong to the public client).
 *   - Reconnect re-authenticates AND re-subscribes; reuses the same DI surface
 *     (transport / scheduler / logger) so tests can run against a fake.
 *
 * The HMAC signature is computed as
 *   HMAC-SHA256(apiSecret, `GET/realtime${expiresAtMs}`)
 * encoded as lowercase hex. This is the V5 contract documented at
 * https://bybit-exchange.github.io/docs/v5/ws/connect#how-to-send-the-auth-message
 */

import type { PositionInfo } from "./index";
import type { WsLogger, WsScheduler, WsTransport, WsTransportFactory } from "./ws";

const DEFAULT_BASE_URL = "wss://stream.bybit.com/v5/private";
const DEFAULT_PING_MS = 20_000;
const DEFAULT_RECONNECT_INITIAL_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const AUTH_EXPIRES_OFFSET_MS = 10_000;

export interface BybitWsPrivateOptions {
  baseUrl?: string;
  apiKey: string;
  apiSecret: string;
  pingIntervalMs?: number;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  transport?: WsTransportFactory;
  scheduler?: WsScheduler;
  logger?: WsLogger;
  /**
   * Channels to subscribe to after a successful auth. Defaults to
   * `["position"]`. Extend with `"execution"` / `"order"` once the
   * downstream caches are wired.
   */
  channels?: ReadonlyArray<"position" | "execution" | "order">;
}

export interface BybitWsPrivateStats {
  messagesReceived: number;
  reconnects: number;
  authSuccesses: number;
  authFailures: number;
  lastMessageAt: number | null;
}

export interface BybitWsPrivateClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  getPosition(symbol: string): PositionInfo | null;
  onPositionUpdate(fn: (p: PositionInfo) => void): () => void;
  stats(): BybitWsPrivateStats;
}

/**
 * Build the Bybit auth signature. Exported for unit tests.
 *
 * `crypto.subtle` is available in Bun / modern Node; we keep the function
 * async so the test can `await` it without polyfilling sync HMAC.
 */
export async function buildAuthSignature(
  apiSecret: string,
  expiresAtMs: number,
): Promise<string> {
  const payload = `GET/realtime${expiresAtMs}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(payload),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const noopLogger: WsLogger = {
  info() {}, warn() {}, error() {},
};

const defaultScheduler: WsScheduler = {
  setTimeout: (h, ms) => setTimeout(h, ms),
  clearTimeout: (h) => clearTimeout(h as any),
  setInterval: (h, ms) => setInterval(h, ms),
  clearInterval: (h) => clearInterval(h as any),
  now: () => Date.now(),
};

function defaultTransport(url: string): WsTransport {
  return new WebSocket(url) as unknown as WsTransport;
}

const WS_OPEN = 1;

export function createBybitWsPrivateClient(
  options: BybitWsPrivateOptions,
): BybitWsPrivateClient {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_MS;
  const reconnectInitialDelayMs = options.reconnectInitialDelayMs ?? DEFAULT_RECONNECT_INITIAL_MS;
  const reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_MS;
  const transportFactory = options.transport ?? defaultTransport;
  const scheduler = options.scheduler ?? defaultScheduler;
  const logger = options.logger ?? noopLogger;
  const channels = options.channels ?? (["position"] as const);

  if (!options.apiKey || !options.apiSecret) {
    throw new Error("BybitWsPrivate: apiKey and apiSecret are required");
  }

  const positions = new Map<string, PositionInfo>();
  const positionHandlers = new Set<(p: PositionInfo) => void>();
  const stats: BybitWsPrivateStats = {
    messagesReceived: 0, reconnects: 0,
    authSuccesses: 0, authFailures: 0,
    lastMessageAt: null,
  };

  let socket: WsTransport | null = null;
  let started = false;
  let stopped = false;
  let pingTimer: unknown = null;
  let reconnectTimer: unknown = null;
  let reconnectAttempt = 0;

  function clearTimers(): void {
    if (pingTimer) { scheduler.clearInterval(pingTimer); pingTimer = null; }
    if (reconnectTimer) { scheduler.clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    if (reconnectTimer) return;
    const delay = Math.min(
      reconnectInitialDelayMs * 2 ** reconnectAttempt,
      reconnectMaxDelayMs,
    );
    reconnectAttempt += 1;
    logger.warn({ event: "bybit-ws-private-reconnect-scheduled", delayMs: delay, attempt: reconnectAttempt });
    reconnectTimer = scheduler.setTimeout(() => {
      reconnectTimer = null;
      stats.reconnects += 1;
      connect();
    }, delay);
  }

  function startPingLoop(): void {
    if (pingTimer) scheduler.clearInterval(pingTimer);
    pingTimer = scheduler.setInterval(() => {
      try { socket?.send(JSON.stringify({ op: "ping" })); }
      catch (err) { logger.warn({ event: "bybit-ws-private-ping-failed", err: String(err) }); }
    }, pingIntervalMs);
  }

  async function sendAuth(): Promise<void> {
    const expiresAt = scheduler.now() + AUTH_EXPIRES_OFFSET_MS;
    const sig = await buildAuthSignature(options.apiSecret, expiresAt);
    const msg = { op: "auth", args: [options.apiKey, expiresAt, sig] };
    socket?.send(JSON.stringify(msg));
  }

  function subscribeChannels(): void {
    socket?.send(JSON.stringify({ op: "subscribe", args: [...channels] }));
  }

  function applyPositionPayload(items: unknown): void {
    if (!Array.isArray(items)) return;
    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const p = raw as Partial<PositionInfo>;
      if (!p.symbol) continue;
      const merged: PositionInfo = {
        symbol: String(p.symbol),
        side: String(p.side ?? ""),
        size: String(p.size ?? "0"),
        avgPrice: String(p.avgPrice ?? "0"),
        stopLoss: String(p.stopLoss ?? ""),
        takeProfit: String(p.takeProfit ?? ""),
      };
      positions.set(merged.symbol, merged);
      for (const fn of positionHandlers) {
        try { fn(merged); } catch (err) { logger.warn({ event: "bybit-ws-private-handler-error", err: String(err) }); }
      }
    }
  }

  function handleMessage(raw: string | ArrayBuffer | Buffer): void {
    let text: string;
    if (typeof raw === "string") text = raw;
    else if (raw instanceof ArrayBuffer) text = new TextDecoder().decode(raw);
    else text = (raw as Buffer).toString("utf8");

    stats.messagesReceived += 1;
    stats.lastMessageAt = scheduler.now();

    let msg: any;
    try { msg = JSON.parse(text); }
    catch { logger.warn({ event: "bybit-ws-private-parse-failed" }); return; }

    if (msg.op === "auth") {
      if (msg.success === true || msg.retCode === 0) {
        stats.authSuccesses += 1;
        logger.info({ event: "bybit-ws-private-auth-ok" });
        subscribeChannels();
      } else {
        stats.authFailures += 1;
        logger.error({ event: "bybit-ws-private-auth-failed", msg });
      }
      return;
    }
    if (msg.op === "subscribe") {
      logger.info({ event: "bybit-ws-private-subscribed", channels });
      return;
    }
    if (msg.op === "pong" || msg.ret_msg === "pong") return;

    if (typeof msg.topic === "string" && msg.topic.startsWith("position")) {
      applyPositionPayload(msg.data);
    }
  }

  function connect(): void {
    if (stopped) return;
    try { socket = transportFactory(baseUrl); }
    catch (err) { logger.error({ event: "bybit-ws-private-transport-init-failed", err: String(err) }); scheduleReconnect(); return; }

    socket.onopen = () => {
      logger.info({ event: "bybit-ws-private-open" });
      reconnectAttempt = 0;
      void sendAuth();
      startPingLoop();
    };
    socket.onmessage = (ev) => handleMessage(ev.data);
    socket.onerror = (err) => logger.warn({ event: "bybit-ws-private-error", err: String(err) });
    socket.onclose = (ev) => {
      logger.warn({ event: "bybit-ws-private-close", code: (ev as any)?.code, reason: (ev as any)?.reason });
      clearTimers();
      if (!stopped) scheduleReconnect();
    };
  }

  return {
    async start() {
      if (started) return;
      started = true;
      stopped = false;
      connect();
    },
    async stop() {
      stopped = true;
      clearTimers();
      try { socket?.close(1000, "client-stop"); } catch { /* ignore */ }
      socket = null;
    },
    getPosition(symbol) { return positions.get(symbol) ?? null; },
    onPositionUpdate(fn) {
      positionHandlers.add(fn);
      return () => { positionHandlers.delete(fn); };
    },
    stats() { return { ...stats }; },
  };
}

export const __INTERNAL_WS_PRIVATE = { DEFAULT_BASE_URL, AUTH_EXPIRES_OFFSET_MS, WS_OPEN };
