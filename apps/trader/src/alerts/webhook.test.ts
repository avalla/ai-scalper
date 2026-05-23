import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createWebhookAlerter } from "./webhook";

const originalFetch = globalThis.fetch;
const originalThrottle = process.env.ALERT_THROTTLE_MS;

describe("createWebhookAlerter", () => {
  let calls: Array<{ url: string; body: unknown }> = [];

  beforeEach(() => {
    calls = [];
    // @ts-expect-error overriding for test
    globalThis.fetch = async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      return new Response("{}", { status: 200 });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalThrottle === undefined) {
      delete process.env.ALERT_THROTTLE_MS;
    } else {
      process.env.ALERT_THROTTLE_MS = originalThrottle;
    }
  });

  it("no-ops when URL is empty (no fetch attempted)", async () => {
    const alerter = createWebhookAlerter("");
    await alerter.send("hello");
    await alerter.send("world", { foo: 1 });
    expect(calls.length).toBe(0);

    const alerter2 = createWebhookAlerter(undefined);
    await alerter2.send("x");
    expect(calls.length).toBe(0);
  });

  it("throttles duplicate messages within the window", async () => {
    process.env.ALERT_THROTTLE_MS = "60000";
    const alerter = createWebhookAlerter("https://example.com/hook");

    await alerter.send("position drift: side-mismatch on BTCUSDT");
    await alerter.send("position drift: side-mismatch on BTCUSDT");
    await alerter.send("position drift: side-mismatch on BTCUSDT");

    expect(calls.length).toBe(1);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.content).toContain("position drift");
    expect(body.text).toContain("position drift");
  });

  it("sends distinct messages without throttling", async () => {
    process.env.ALERT_THROTTLE_MS = "60000";
    const alerter = createWebhookAlerter("https://example.com/hook");

    await alerter.send("alpha message body here");
    await alerter.send("beta message body here");
    expect(calls.length).toBe(2);
  });
});
