import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHealthAlerter, runHealthChecks } from "./health";

function tmpFile(name: string, content = "{}"): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ai-scalper-health-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("runHealthChecks", () => {
  test("all checks pass → ok=true", async () => {
    const { path, cleanup } = tmpFile("scan-latest.json");
    try {
      const now = Date.now();
      const result = await runHealthChecks({
        redis: { async ping() { return "PONG"; } },
        bybitTimeFetcher: async () => ({}),
        queueLengths: async () => ({ q1: { waiting: 10, failed: 0 } }),
        lastAnthropicCallAt: () => now - 5_000,
        scanLatestPath: path,
        now: () => now,
      });
      expect(result.ok).toBe(true);
      expect(result.checks.redis.ok).toBe(true);
      expect(result.checks.bybit.ok).toBe(true);
      expect(result.checks.bullmq.ok).toBe(true);
      expect(result.checks.anthropic.ok).toBe(true);
      expect(result.checks.kline.ok).toBe(true);
    } finally { cleanup(); }
  });

  test("Redis down → ok=false with reason", async () => {
    const result = await runHealthChecks({
      redis: { async ping() { throw new Error("ECONNREFUSED"); } },
    });
    expect(result.ok).toBe(false);
    expect(result.checks.redis.ok).toBe(false);
    expect(result.checks.redis.reason).toContain("ECONNREFUSED");
  });

  test("Anthropic silent for >30min → ok=false", async () => {
    const now = Date.now();
    const result = await runHealthChecks({
      redis: { async ping() { return "PONG"; } },
      lastAnthropicCallAt: () => now - 31 * 60 * 1000,
      now: () => now,
    });
    expect(result.ok).toBe(false);
    expect(result.checks.anthropic.ok).toBe(false);
    expect(result.checks.anthropic.reason).toContain("silent");
  });

  test("Anthropic check skipped when lastAnthropicCallAt returns null", async () => {
    const result = await runHealthChecks({
      redis: { async ping() { return "PONG"; } },
      lastAnthropicCallAt: () => null,
    });
    expect(result.ok).toBe(true);
    expect(result.checks.anthropic).toBeUndefined();
  });

  test("Kline file missing → ok=false", async () => {
    const result = await runHealthChecks({
      redis: { async ping() { return "PONG"; } },
      scanLatestPath: "/nonexistent/scan-latest.json",
    });
    expect(result.ok).toBe(false);
    expect(result.checks.kline.ok).toBe(false);
    expect(result.checks.kline.reason).toContain("missing");
  });

  test("Kline file stale → ok=false", async () => {
    const { path, cleanup } = tmpFile("scan-latest.json");
    try {
      // Force mtime 10 min ago
      const tenMinAgo = (Date.now() - 10 * 60 * 1000) / 1000;
      utimesSync(path, tenMinAgo, tenMinAgo);
      const result = await runHealthChecks({
        redis: { async ping() { return "PONG"; } },
        scanLatestPath: path,
      });
      expect(result.ok).toBe(false);
      expect(result.checks.kline.ok).toBe(false);
      expect(result.checks.kline.reason).toContain("stale");
    } finally { cleanup(); }
  });

  test("BullMQ overflow waiting > 100 → ok=false", async () => {
    const result = await runHealthChecks({
      redis: { async ping() { return "PONG"; } },
      queueLengths: async () => ({ market: { waiting: 150, failed: 0 } }),
    });
    expect(result.ok).toBe(false);
    expect(result.checks.bullmq.reason).toContain("waiting=150");
  });
});

describe("createHealthAlerter", () => {
  test("fires webhook only after consecutive failures hits threshold (default 2)", async () => {
    let isUp = false;
    const calls: string[] = [];
    const alerter = createHealthAlerter({
      deps: { redis: { async ping() { if (isUp) return "PONG"; throw new Error("down"); } } },
      webhookUrl: "https://example.invalid/webhook",
      fetcher: async (url, init) => { calls.push(init.body); return new Response("ok"); },
      logger: () => {},
      intervalMs: 0,
    });

    // First failure → no webhook fired yet
    await alerter.tick();
    expect(alerter.consecutiveFailures()).toBe(1);
    expect(calls.length).toBe(0);

    // Second consecutive failure → webhook fires
    await alerter.tick();
    expect(alerter.consecutiveFailures()).toBe(2);
    expect(calls.length).toBe(1);
    const body = JSON.parse(calls[0]!);
    expect(body.event).toBe("health-alert");
    expect(body.consecutiveFailures).toBe(2);

    // Recovery resets the counter
    isUp = true;
    await alerter.tick();
    expect(alerter.consecutiveFailures()).toBe(0);
  });

  test("does NOT alert after a single failure", async () => {
    let fail = true;
    const calls: string[] = [];
    const alerter = createHealthAlerter({
      deps: { redis: { async ping() { if (fail) throw new Error("x"); return "PONG"; } } },
      webhookUrl: "https://example.invalid/webhook",
      fetcher: async (_, init) => { calls.push(init.body); return new Response(""); },
      logger: () => {},
      intervalMs: 0,
    });
    await alerter.tick();
    expect(calls.length).toBe(0);
    fail = false;
    await alerter.tick();
    expect(calls.length).toBe(0);
  });

  test("tick returns a HealthCheck object", async () => {
    const alerter = createHealthAlerter({
      deps: { redis: { async ping() { return "PONG"; } } },
      logger: () => {},
    });
    const res = await alerter.tick();
    expect(res.ok).toBe(true);
    expect(typeof res.ts).toBe("string");
  });

  // Silence unused-import warnings in some setups
  test("mkdirSync import is referenced", () => { expect(typeof mkdirSync).toBe("function"); });
});
