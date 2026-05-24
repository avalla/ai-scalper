import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import pino from "pino";
import { createTestLogger } from "./logger";

function captureSink(): { stream: pino.DestinationStream; lines: () => string[] } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream: sink as unknown as pino.DestinationStream, lines: () => chunks.join("").split(/\n/).filter(Boolean) };
}

describe("logger", () => {
  test("respects level filter (warn drops info)", () => {
    const { stream, lines } = captureSink();
    const log = createTestLogger({ level: "warn", destination: stream });
    log.info({ event: "i" }, "info-msg");
    log.warn({ event: "w" }, "warn-msg");
    const parsed = lines().map((l) => JSON.parse(l));
    expect(parsed.length).toBe(1);
    expect(parsed[0].event).toBe("w");
  });

  test("logEvent-like usage emits {event, ...data} shape", () => {
    const { stream, lines } = captureSink();
    const log = createTestLogger({ level: "info", destination: stream });
    log.info({ event: "trade-opened", symbol: "BTCUSDT", qty: 0.01 });
    const parsed = JSON.parse(lines()[0]);
    expect(parsed.event).toBe("trade-opened");
    expect(parsed.symbol).toBe("BTCUSDT");
    expect(parsed.qty).toBe(0.01);
    expect(parsed.app).toBe("ai-scalper-trader");
  });

  test("emits ISO timestamps", () => {
    const { stream, lines } = captureSink();
    const log = createTestLogger({ level: "info", destination: stream });
    log.info({ event: "ts-check" });
    const parsed = JSON.parse(lines()[0]);
    // pino.stdTimeFunctions.isoTime produces '"time":"<ISO>"'
    expect(typeof parsed.time).toBe("string");
    expect(parsed.time).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
