/**
 * PositionSource — unified abstraction for reading the latest position
 * snapshot for a symbol. Mirrors `TickerSource`: consumers depend on the
 * interface and the underlying transport (REST vs WS-private-cache) is
 * swappable via configuration.
 *
 * Two implementations:
 *   - `createRestPositionSource(client)` — pure REST passthrough; preserves
 *     the original `client.getPosition(...)` behaviour.
 *   - `createWsPrivatePositionSource({ws, fallback, defaultMaxAgeMs})` — reads
 *     the in-memory cache maintained by the WS private client. Falls back to
 *     REST when the cached entry is missing or older than `maxAgeMs`
 *     (default 5 s). The WS client owns cache writes; this source does not.
 */
import type { PositionInfo, createBybitClient } from "./index";
import type { BybitWsPrivateClient } from "./ws-private";

export type BybitClient = ReturnType<typeof createBybitClient>;

export interface PositionSource {
  getPosition(symbol: string, opts?: { category?: string; maxAgeMs?: number }): Promise<PositionInfo | null>;
  peek(symbol: string): PositionInfo | null;
}

const DEFAULT_CATEGORY = "linear";
const DEFAULT_MAX_AGE_MS = 5_000;

export function createRestPositionSource(
  client: BybitClient,
  opts: { defaultCategory?: string } = {},
): PositionSource {
  const defaultCategory = opts.defaultCategory ?? DEFAULT_CATEGORY;
  const lastSeen = new Map<string, PositionInfo>();
  return {
    async getPosition(symbol, callOpts) {
      const pos = await client.getPosition({
        category: callOpts?.category ?? defaultCategory,
        symbol,
      });
      if (pos) lastSeen.set(symbol.toUpperCase(), pos);
      return pos;
    },
    peek(symbol) {
      return lastSeen.get(symbol.toUpperCase()) ?? null;
    },
  };
}

export interface WsPrivatePositionSourceDeps {
  ws: Pick<BybitWsPrivateClient, "getPosition" | "stats">;
  fallback: BybitClient;
  defaultMaxAgeMs?: number;
  defaultCategory?: string;
  logger?: { warn: (o: Record<string, unknown>) => void };
  now?: () => number;
}

export function createWsPrivatePositionSource(
  deps: WsPrivatePositionSourceDeps,
): PositionSource {
  const defaultMaxAgeMs = deps.defaultMaxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const defaultCategory = deps.defaultCategory ?? DEFAULT_CATEGORY;
  const now = deps.now ?? (() => Date.now());
  const lastSeen = new Map<string, PositionInfo>();
  const lastWarnAt = new Map<string, number>();

  function warnOncePerMinute(key: string, payload: Record<string, unknown>): void {
    if (!deps.logger) return;
    const t = now();
    const last = lastWarnAt.get(key);
    if (last !== undefined && t - last < 60_000) return;
    lastWarnAt.set(key, t);
    deps.logger.warn(payload);
  }

  return {
    async getPosition(symbol, callOpts) {
      const cached = deps.ws.getPosition(symbol);
      const lastMsgAt = deps.ws.stats().lastMessageAt;
      const maxAgeMs = callOpts?.maxAgeMs ?? defaultMaxAgeMs;
      if (cached && lastMsgAt !== null && now() - lastMsgAt < maxAgeMs) {
        lastSeen.set(symbol.toUpperCase(), cached);
        return cached;
      }
      warnOncePerMinute(`ws-private-cache-miss:${symbol}`, {
        event: cached ? "ws-private-stale-fallback-rest" : "ws-private-miss-fallback-rest",
        symbol, ageMs: lastMsgAt !== null ? now() - lastMsgAt : null,
      });
      const pos = await deps.fallback.getPosition({
        category: callOpts?.category ?? defaultCategory,
        symbol,
      });
      if (pos) lastSeen.set(symbol.toUpperCase(), pos);
      return pos;
    },
    peek(symbol) { return lastSeen.get(symbol.toUpperCase()) ?? null; },
  };
}
