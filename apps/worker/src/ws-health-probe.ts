/**
 * Adapter from BybitWsClient stats → WsHealthProbe (for `runHealthChecks`).
 *
 * The bybit ws client tracks `reconnects` as a monotonic counter and
 * `lastMessageAt` as a ms epoch. The health endpoint wants reconnects in
 * the trailing 1h — so we sample the counter periodically and derive the
 * 1h delta locally.
 *
 * The probe is allocated once at worker start and queried each tick by
 * runHealthChecks.
 */
import type { BybitWsClient } from "@ai-scalper/bybit-client/ws";
import type { WsHealthProbe } from "./health";

interface ReconnectSample { at: number; total: number; }

export interface WsHealthProbeOptions {
  client: BybitWsClient;
  /** Rolling window in ms. Default 1h. */
  windowMs?: number;
  now?: () => number;
}

const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

export function createWsHealthProbe(opts: WsHealthProbeOptions): WsHealthProbe {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const now = opts.now ?? (() => Date.now());
  const samples: ReconnectSample[] = [];

  function record(): void {
    const t = now();
    const stats = opts.client.getStats();
    samples.push({ at: t, total: stats.reconnects });
    // Drop samples older than window+1 sample.
    const cutoff = t - windowMs;
    while (samples.length > 1 && samples[1]!.at < cutoff) samples.shift();
  }

  return {
    isConnected() { return opts.client.isConnected(); },
    lastMessageAt() { return opts.client.getStats().lastMessageAt; },
    reconnectsLastHour() {
      record();
      if (samples.length === 0) return 0;
      const t = now();
      const cutoff = t - windowMs;
      // Find oldest sample within window.
      const baseline = samples.find((s) => s.at >= cutoff) ?? samples[0]!;
      const latest = samples[samples.length - 1]!;
      return Math.max(0, latest.total - baseline.total);
    },
  };
}
