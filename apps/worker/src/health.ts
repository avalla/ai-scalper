/**
 * Health check + alerting for the worker stack. Each check returns
 * {ok, reason?, latencyMs?}; the aggregate is `ok=true` iff every check is
 * ok=true. Designed so the `/health` endpoint can return 200/503 and a
 * background loop can fire `ALERT_WEBHOOK_URL` after N consecutive failures.
 *
 * All checks are best-effort and individually tolerant — a single network
 * blip won't crash the loop. The Anthropic + kline checks are gated by
 * presence of their deps (omit the related option to skip).
 */
import { existsSync, statSync } from "node:fs";

export interface HealthCheckResult {
  ok: boolean;
  reason?: string;
  latencyMs?: number;
}

export interface HealthCheck {
  ok: boolean;
  checks: Record<string, HealthCheckResult>;
  ts: string;
}

export interface HealthDeps {
  /** ioredis-like client; we only use ping(). */
  redis: { ping(): Promise<string> } | null;
  /** Bybit client; we only use a cheap GET /v5/market/time. */
  bybitTimeFetcher?: () => Promise<unknown>;
  /** Queue length snapshot. Limits: waiting<=100 per queue, failed<=50 per queue. */
  queueLengths?: () => Promise<Record<string, { waiting?: number; failed?: number }>>;
  /** Timestamp of last successful Anthropic call (ms epoch). null = disabled. */
  lastAnthropicCallAt?: () => number | null;
  /** Maximum allowed silence on Anthropic calls. Default 30 min. */
  maxAnthropicSilenceMs?: number;
  /** Path to scan-latest.json. Skipped if undefined. */
  scanLatestPath?: string;
  /** Max kline file age. Default 5 min. */
  maxKlineStaleMs?: number;
  /**
   * Optional WS client probe. When provided, health adds a `ws` check that
   * verifies: (a) the client is connected, (b) lastMessageAt is recent
   * (<= maxWsSilenceMs), (c) reconnects in the last hour are <= cap.
   * Pass null to skip.
   */
  ws?: WsHealthProbe | null;
  maxWsSilenceMs?: number;
  maxReconnectsPerHour?: number;
  /** Override for clock — useful in tests. */
  now?: () => number;
}

/**
 * Minimal probe surface — a subset of BybitWsClient.getStats() + isConnected().
 * The worker passes a small adapter that also tracks rolling reconnect counts.
 */
export interface WsHealthProbe {
  isConnected(): boolean;
  /** ms epoch of most recent WS message, or null if none yet. */
  lastMessageAt(): number | null;
  /** Number of reconnects in the trailing 1h window. */
  reconnectsLastHour(): number;
}

const DEFAULT_MAX_ANTHROPIC_SILENCE_MS = 30 * 60 * 1000;
const DEFAULT_MAX_KLINE_STALE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_WS_SILENCE_MS = 60_000;
const DEFAULT_MAX_RECONNECTS_PER_HOUR = 5;
const MAX_WAITING_PER_QUEUE = 100;
const MAX_FAILED_PER_QUEUE = 50;

async function timed<T>(fn: () => Promise<T>): Promise<{
  ok: boolean; latencyMs: number; reason?: string; value?: T;
}> {
  const start = Date.now();
  try {
    const value = await fn();
    return { ok: true, latencyMs: Date.now() - start, value };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runHealthChecks(deps: HealthDeps): Promise<HealthCheck> {
  const now = deps.now ?? (() => Date.now());
  const checks: Record<string, HealthCheckResult> = {};

  // Redis
  if (deps.redis) {
    const r = await timed(() => deps.redis!.ping());
    checks.redis = r.ok && r.value === "PONG"
      ? { ok: true, latencyMs: r.latencyMs }
      : { ok: false, reason: r.reason ?? `unexpected reply: ${String(r.value)}`, latencyMs: r.latencyMs };
  } else {
    checks.redis = { ok: false, reason: "no redis client configured" };
  }

  // Bybit
  if (deps.bybitTimeFetcher) {
    const r = await timed(() => deps.bybitTimeFetcher!());
    checks.bybit = r.ok
      ? { ok: true, latencyMs: r.latencyMs }
      : { ok: false, reason: r.reason ?? "unknown", latencyMs: r.latencyMs };
  }

  // BullMQ queue lengths
  if (deps.queueLengths) {
    const r = await timed(() => deps.queueLengths!());
    if (!r.ok) {
      checks.bullmq = { ok: false, reason: r.reason ?? "queue probe failed", latencyMs: r.latencyMs };
    } else {
      const overflows: string[] = [];
      for (const [name, counts] of Object.entries(r.value ?? {})) {
        if ((counts.waiting ?? 0) > MAX_WAITING_PER_QUEUE) {
          overflows.push(`${name}.waiting=${counts.waiting}>${MAX_WAITING_PER_QUEUE}`);
        }
        if ((counts.failed ?? 0) > MAX_FAILED_PER_QUEUE) {
          overflows.push(`${name}.failed=${counts.failed}>${MAX_FAILED_PER_QUEUE}`);
        }
      }
      checks.bullmq = overflows.length === 0
        ? { ok: true, latencyMs: r.latencyMs }
        : { ok: false, reason: overflows.join(", "), latencyMs: r.latencyMs };
    }
  }

  // Anthropic silence
  if (deps.lastAnthropicCallAt) {
    const last = deps.lastAnthropicCallAt();
    if (last !== null) {
      const ageMs = now() - last;
      const cap = deps.maxAnthropicSilenceMs ?? DEFAULT_MAX_ANTHROPIC_SILENCE_MS;
      checks.anthropic = ageMs <= cap
        ? { ok: true }
        : { ok: false, reason: `silent for ${Math.round(ageMs / 1000)}s (cap ${Math.round(cap / 1000)}s)` };
    }
  }

  // WebSocket health (connection + freshness + reconnect rate).
  if (deps.ws) {
    const ws = deps.ws;
    const silenceCap = deps.maxWsSilenceMs ?? DEFAULT_MAX_WS_SILENCE_MS;
    const reconnectCap = deps.maxReconnectsPerHour ?? DEFAULT_MAX_RECONNECTS_PER_HOUR;
    const reasons: string[] = [];
    if (!ws.isConnected()) reasons.push("not-connected");
    const last = ws.lastMessageAt();
    if (last === null) {
      reasons.push("no-messages-received");
    } else {
      const ageMs = now() - last;
      if (ageMs > silenceCap) {
        reasons.push(`silent for ${Math.round(ageMs / 1000)}s (cap ${Math.round(silenceCap / 1000)}s)`);
      }
    }
    const recon = ws.reconnectsLastHour();
    if (recon > reconnectCap) {
      reasons.push(`reconnects ${recon}/h > cap ${reconnectCap}`);
    }
    checks.ws = reasons.length === 0
      ? { ok: true }
      : { ok: false, reason: reasons.join(", ") };
  }

  // Kline staleness
  if (deps.scanLatestPath) {
    const cap = deps.maxKlineStaleMs ?? DEFAULT_MAX_KLINE_STALE_MS;
    if (!existsSync(deps.scanLatestPath)) {
      checks.kline = { ok: false, reason: `scan-latest.json missing at ${deps.scanLatestPath}` };
    } else {
      try {
        const st = statSync(deps.scanLatestPath);
        const ageMs = now() - st.mtimeMs;
        checks.kline = ageMs <= cap
          ? { ok: true }
          : { ok: false, reason: `stale by ${Math.round(ageMs / 1000)}s (cap ${Math.round(cap / 1000)}s)` };
      } catch (err) {
        checks.kline = { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    }
  }

  const ok = Object.values(checks).every((c) => c.ok);
  return {
    ok,
    checks,
    ts: new Date(now()).toISOString(),
  };
}

/**
 * Alerter loop: runs `runHealthChecks` every `intervalMs`, posts to
 * `webhookUrl` after `consecutiveFailureThreshold` consecutive failures.
 *
 * Returns a stop fn. Idempotent — calling stop twice is fine.
 *
 * Stateful: tracks consecutive failure count so a single-blip failure doesn't
 * spam alerts.
 */
export function createHealthAlerter(opts: {
  deps: HealthDeps;
  webhookUrl?: string;
  intervalMs?: number;
  consecutiveFailureThreshold?: number;
  fetcher?: (url: string, init: { method: string; body: string; headers: Record<string, string> }) => Promise<unknown>;
  logger?: (line: Record<string, unknown>) => void;
}): {
  tick(): Promise<HealthCheck>;
  start(): void;
  stop(): void;
  consecutiveFailures(): number;
} {
  const intervalMs = opts.intervalMs ?? 60_000;
  const threshold = opts.consecutiveFailureThreshold ?? 2;
  const fetcher = opts.fetcher
    ?? ((url, init) => fetch(url, init as unknown as RequestInit));
  const log = opts.logger ?? ((line) => console.log(JSON.stringify(line)));

  let consecutive = 0;
  let lastAlertedAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function tick(): Promise<HealthCheck> {
    const result = await runHealthChecks(opts.deps);
    if (result.ok) {
      consecutive = 0;
    } else {
      consecutive += 1;
      if (consecutive >= threshold && opts.webhookUrl) {
        // Re-alert at most once per interval to avoid spam.
        if (Date.now() - lastAlertedAt >= intervalMs) {
          lastAlertedAt = Date.now();
          try {
            await fetcher(opts.webhookUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                event: "health-alert",
                consecutiveFailures: consecutive,
                check: result,
              }),
            });
            log({ event: "health-alert-posted", consecutive });
          } catch (err) {
            log({ event: "health-alert-failed", err: err instanceof Error ? err.message : String(err) });
          }
        }
      }
    }
    return result;
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, intervalMs);
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
    consecutiveFailures() { return consecutive; },
  };
}
