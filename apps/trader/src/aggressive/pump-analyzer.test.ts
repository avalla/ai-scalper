import { describe, expect, test } from "bun:test";
import {
  analyzePump,
  buildPrompt,
  createMockProvider,
  parseLLMResponse,
  type AnalysisKline,
  type PumpAnalysisContext,
} from "./pump-analyzer";
import type { PumpAnomaly } from "./pump-scanner";

const anomaly: PumpAnomaly = {
  symbol: "BTCUSDT",
  detectedAt: 1_700_000_000_000,
  priceChangeBps: 280,
  direction: "pump",
  volumeMultiple: 3.2,
  windowVolumeUsd: 450_000,
  spreadBps: 1.4,
  windowStartPrice: 73_000,
  windowEndPrice: 75_044,
};

const klines: AnalysisKline[] = Array.from({ length: 5 }, (_, i) => ({
  ts: 1_700_000_000_000 + i * 60_000,
  open: 73_000 + i * 400, high: 73_100 + i * 400, low: 72_950 + i * 400, close: 73_080 + i * 400,
  volumeUsd: 90_000 + i * 5000,
}));

const ctx: PumpAnalysisContext = {
  anomaly,
  book: { bid1Price: 75_040, ask1Price: 75_050, bidDepthUsd: 200_000, askDepthUsd: 180_000 },
  recentKlines: klines,
  derivatives: { fundingRateBps: 4.2, openInterestUsd: 1_500_000_000 },
};

// ─── buildPrompt ─────────────────────────────────────────────────────────

describe("buildPrompt", () => {
  test("includes symbol, anomaly metrics, book and klines", () => {
    const p = buildPrompt(ctx);
    expect(p).toContain("BTCUSDT");
    expect(p).toContain("priceChangeBps:      280");
    expect(p).toContain("volumeMultiple:      3.20x baseline");
    expect(p).toContain("bid1:       75040");
    expect(p).toContain("ask1:       75050");
    expect(p).toContain("fundingRateBps:     4.2");
    expect(p).toContain("DECISION FRAMEWORK");
    expect(p).toContain("SKIP IF");
    // All 5 klines rendered (one ISO timestamp per line in the OHLCV block)
    const lineCount = (p.match(/2023-11-14T/g) || []).length;
    expect(lineCount).toBeGreaterThanOrEqual(5);
  });

  test("handles missing derivatives (n/a placeholder)", () => {
    const p = buildPrompt({ ...ctx, derivatives: undefined });
    expect(p).toContain("fundingRateBps:     n/a");
    expect(p).toContain("openInterestUsd:    n/a");
  });
});

// ─── parseLLMResponse ─────────────────────────────────────────────────────

describe("parseLLMResponse", () => {
  test("parses a clean enter response", () => {
    const raw = JSON.stringify({
      kind: "enter", side: "long", confidence: 0.7, stopBps: 200, tpBps: 350, rationale: "continuation on strong volume",
    });
    const r = parseLLMResponse(raw);
    expect(r.kind).toBe("enter");
    if (r.kind === "enter") {
      expect(r.side).toBe("long");
      expect(r.confidence).toBe(0.7);
      expect(r.stopBps).toBe(200);
      expect(r.tpBps).toBe(350);
      expect(r.rationale).toContain("continuation");
    }
  });

  test("parses a skip response", () => {
    const r = parseLLMResponse(JSON.stringify({ kind: "skip", rationale: "looks like wick" }));
    expect(r.kind).toBe("skip");
    if (r.kind === "skip") expect(r.rationale).toBe("looks like wick");
  });

  test("tolerates markdown code fences", () => {
    const raw = "```json\n" + JSON.stringify({ kind: "enter", side: "short", confidence: 0.6, stopBps: 150, tpBps: 250, rationale: "exhaustion" }) + "\n```";
    const r = parseLLMResponse(raw);
    expect(r.kind).toBe("enter");
    if (r.kind === "enter") expect(r.side).toBe("short");
  });

  test("tolerates leading/trailing prose around JSON", () => {
    const raw = "Sure, here is my analysis:\n" + JSON.stringify({ kind: "skip", rationale: "stale" }) + "\n\nLet me know if you want more.";
    expect(parseLLMResponse(raw).kind).toBe("skip");
  });

  test("malformed JSON → skip with parser reason", () => {
    const r = parseLLMResponse("{not valid json at all");
    expect(r.kind).toBe("skip");
    if (r.kind === "skip") expect(r.rationale).toContain("parser:");
  });

  test("missing required field (no stopBps) → skip", () => {
    const r = parseLLMResponse(JSON.stringify({ kind: "enter", side: "long", confidence: 0.5, tpBps: 200, rationale: "no stop" }));
    expect(r.kind).toBe("skip");
  });

  test("invalid side → skip", () => {
    const r = parseLLMResponse(JSON.stringify({ kind: "enter", side: "buy", confidence: 0.5, stopBps: 100, tpBps: 200, rationale: "wrong side enum" }));
    expect(r.kind).toBe("skip");
    if (r.kind === "skip") expect(r.rationale).toContain("invalid-side");
  });

  test("invalid confidence (> 1) → skip", () => {
    const r = parseLLMResponse(JSON.stringify({ kind: "enter", side: "long", confidence: 2.5, stopBps: 100, tpBps: 200, rationale: "out of range" }));
    expect(r.kind).toBe("skip");
    if (r.kind === "skip") expect(r.rationale).toContain("invalid-confidence");
  });

  test("non-positive stopBps → skip", () => {
    const r = parseLLMResponse(JSON.stringify({ kind: "enter", side: "long", confidence: 0.7, stopBps: 0, tpBps: 200, rationale: "zero stop" }));
    expect(r.kind).toBe("skip");
  });

  test("unknown kind → skip", () => {
    const r = parseLLMResponse(JSON.stringify({ kind: "hold", rationale: "wat" }));
    expect(r.kind).toBe("skip");
    if (r.kind === "skip") expect(r.rationale).toContain("invalid-kind");
  });

  test("empty input → skip", () => {
    expect(parseLLMResponse("").kind).toBe("skip");
  });
});

// ─── analyzePump (end-to-end with mock provider) ──────────────────────────

describe("analyzePump", () => {
  test("happy path: provider returns enter → analyzer returns enter", async () => {
    const provider = createMockProvider(JSON.stringify({
      kind: "enter", side: "long", confidence: 0.75, stopBps: 200, tpBps: 350, rationale: "momentum continues",
    }));
    const r = await analyzePump(ctx, provider);
    expect(r.kind).toBe("enter");
    if (r.kind === "enter") {
      expect(r.side).toBe("long");
      expect(r.confidence).toBe(0.75);
    }
  });

  test("provider throws → skip with provider-error reason", async () => {
    const provider = createMockProvider(() => { throw new Error("rate limited"); });
    const r = await analyzePump(ctx, provider);
    expect(r.kind).toBe("skip");
    if (r.kind === "skip") expect(r.rationale).toContain("provider-error");
  });

  test("provider returns junk → skip via parser", async () => {
    const provider = createMockProvider("the model decided not to respond");
    const r = await analyzePump(ctx, provider);
    expect(r.kind).toBe("skip");
  });

  test("provider receives the rendered prompt (sanity)", async () => {
    let received = "";
    const provider = createMockProvider((p) => { received = p; return JSON.stringify({ kind: "skip", rationale: "test" }); });
    await analyzePump(ctx, provider);
    expect(received).toContain("BTCUSDT");
    expect(received).toContain("Schema:");
  });
});
