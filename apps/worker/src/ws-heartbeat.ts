/**
 * WS heartbeat — small Redis-backed snapshot of the ws-feeder's health.
 *
 * The feeder writes a row every ~5s with the latest `getStats()` + connection
 * state. The `/health` endpoint reads it via `readWsHeartbeat` and treats a
 * missing or stale heartbeat (> 30s old) as ws=down.
 *
 * Storage: HASH `<prefix>:ws:heartbeat` with TTL 60s.
 */

import type IORedis from "ioredis";

export interface WsHeartbeat {
  /** ms epoch of the most recent WS message seen by the feeder. */
  lastMessageAt: number;
  /** Monotonic reconnect counter from the WS client. */
  reconnects: number;
  /** True iff the WS client is currently connected. */
  isConnected: boolean;
  /** ms epoch of when this row was written. */
  writtenAt: number;
}

const DEFAULT_PREFIX = "ws";
const HEARTBEAT_TTL_SEC = 60;

function heartbeatKey(prefix: string): string {
  return `${prefix}:ws:heartbeat`;
}

export async function writeWsHeartbeat(
  redis: IORedis,
  hb: WsHeartbeat,
  opts: { keyPrefix?: string } = {},
): Promise<void> {
  const key = heartbeatKey(opts.keyPrefix ?? DEFAULT_PREFIX);
  await redis.hset(key, {
    lastMessageAt: String(hb.lastMessageAt),
    reconnects: String(hb.reconnects),
    isConnected: hb.isConnected ? "1" : "0",
    writtenAt: String(hb.writtenAt),
  });
  await redis.expire(key, HEARTBEAT_TTL_SEC);
}

export async function readWsHeartbeat(
  redis: IORedis,
  opts: { keyPrefix?: string } = {},
): Promise<WsHeartbeat | null> {
  const key = heartbeatKey(opts.keyPrefix ?? DEFAULT_PREFIX);
  const raw = await redis.hgetall(key);
  if (!raw || Object.keys(raw).length === 0) return null;
  const lastMessageAt = Number(raw.lastMessageAt);
  const reconnects = Number(raw.reconnects);
  const writtenAt = Number(raw.writtenAt);
  if (!Number.isFinite(lastMessageAt) || !Number.isFinite(reconnects) || !Number.isFinite(writtenAt)) {
    return null;
  }
  return {
    lastMessageAt,
    reconnects,
    isConnected: raw.isConnected === "1",
    writtenAt,
  };
}
