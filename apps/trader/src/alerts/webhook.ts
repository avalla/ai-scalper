/**
 * Webhook alerter — best-effort POST to a Discord-compatible or generic
 * webhook. Throttles duplicate messages within a configurable window.
 */

export interface WebhookAlerter {
  send(message: string, context?: Record<string, unknown>): Promise<void>;
}

const DEFAULT_THROTTLE_MS = 60_000;
const KEY_LENGTH = 40;

function resolveThrottleMs(): number {
  const raw = process.env.ALERT_THROTTLE_MS;
  if (!raw) return DEFAULT_THROTTLE_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_THROTTLE_MS;
}

export function createWebhookAlerter(url: string | undefined | null): WebhookAlerter {
  if (!url || url.trim() === "") {
    return {
      async send(): Promise<void> {
        // no-op
      },
    };
  }

  const target = url.trim();
  const throttleMs = resolveThrottleMs();
  const lastSentByKey = new Map<string, number>();

  return {
    async send(message: string, context?: Record<string, unknown>): Promise<void> {
      const now = Date.now();
      const key = message.slice(0, KEY_LENGTH);
      const lastTs = lastSentByKey.get(key);
      if (lastTs !== undefined && now - lastTs < throttleMs) {
        return; // drop duplicate silently
      }
      lastSentByKey.set(key, now);

      const payload = {
        content: message,
        text: message,
        context: context ?? null,
        ts: new Date(now).toISOString(),
      };

      try {
        await fetch(target, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: "alert-webhook-error",
            error: msg,
          }),
        );
      }
    },
  };
}
