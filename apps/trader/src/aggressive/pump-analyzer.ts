/**
 * Pump LLM analyzer — turns a PumpAnomaly + market context into a trade
 * signal via a language model.
 *
 * Architecture:
 *   PumpAnomaly + context → buildPrompt → provider.analyze(prompt)
 *     → parseLLMResponse → PumpLLMSignal { enter | skip }
 *
 * The provider interface is intentionally minimal (string in → string out)
 * so we can swap Claude / GPT / local model without changing the analyzer.
 * Concrete providers (Anthropic SDK call) are wired at the runtime layer in
 * session 3 — this module stays testable with a mock provider.
 *
 * PURE-ish: no I/O except the provider call (which the caller injects).
 */

import type { PumpAnomaly } from "./pump-scanner";

// ─── Context the LLM receives ──────────────────────────────────────────────

/** A single OHLCV candle (e.g. 1-minute bar). */
export interface AnalysisKline {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
}

/** Top of book + recent depth in USD if available. */
export interface BookSnapshot {
  bid1Price: number;
  ask1Price: number;
  /** Total bid depth in USD within ±N% (caller-defined). */
  bidDepthUsd?: number;
  askDepthUsd?: number;
}

/** Funding rate + open interest if available (signals overheated leverage). */
export interface DerivativesContext {
  fundingRateBps?: number;
  openInterestUsd?: number;
}

export interface PumpAnalysisContext {
  anomaly: PumpAnomaly;
  book: BookSnapshot;
  /** Recent klines, ordered oldest → newest. 30-100 candles is reasonable. */
  recentKlines: readonly AnalysisKline[];
  derivatives?: DerivativesContext;
}

// ─── Output: signal from the LLM after analysis ────────────────────────────

export type PumpLLMSignal =
  | {
      kind: "enter";
      side: "long" | "short";
      /** 0..1. Caller can apply a min-confidence filter. */
      confidence: number;
      /** Hard stop distance in bps from refPrice (positive number). */
      stopBps: number;
      /** Take profit distance in bps from refPrice (positive number). */
      tpBps: number;
      rationale: string;
    }
  | { kind: "skip"; rationale: string };

// ─── Provider abstraction ─────────────────────────────────────────────────

export interface PumpAnalyzerProvider {
  /** Send a prompt to the LLM and return the raw text response. */
  analyze(prompt: string): Promise<string>;
}

/**
 * Make a mock provider that returns a fixed response. For tests. Real Claude/
 * OpenAI providers live in the runtime layer (session 3).
 */
export function createMockProvider(scriptedResponse: string | ((p: string) => string)): PumpAnalyzerProvider {
  return {
    async analyze(prompt) {
      return typeof scriptedResponse === "function" ? scriptedResponse(prompt) : scriptedResponse;
    },
  };
}

// ─── Prompt building ──────────────────────────────────────────────────────

/**
 * Compact JSON-style prompt designed for fast inference + strict JSON output.
 *
 * Design choices (lessons from operator's prior LLM workflow):
 *  - **Skip is a first-class default, not a fallback.** The frame is "decide
 *    whether to act", not "find a trade". This prevents the model from
 *    forcing setups on noise.
 *  - **Calibrated confidence required.** Forces the model to express
 *    uncertainty rather than always sounding decisive.
 *  - **Leverage NOT mentioned in the prompt.** Sizing/leverage are tier-engine
 *    decisions in code; mentioning "high-lev futures" anchors the model toward
 *    aggressive tight stops that get stopped out.
 *  - **All numeric data inline.** Without real values the model hallucinates
 *    plausible-looking but invented context. Everything it needs is below.
 *  - **Explicit skip criteria.** Lists the failure modes (wick traps,
 *    illiquid, mature, choppy, low conviction) so the model has anchors for
 *    rejection.
 *  - **Stops/TPs in absolute bps with realistic bounds.** Prevents
 *    "ultra-tight stop on a volatile asset" anti-pattern.
 */
export function buildPrompt(ctx: PumpAnalysisContext): string {
  const { anomaly, book, recentKlines, derivatives } = ctx;
  const klinesCompact = recentKlines.map((k) =>
    `${new Date(k.ts).toISOString()},${k.open.toFixed(2)},${k.high.toFixed(2)},${k.low.toFixed(2)},${k.close.toFixed(2)},${k.volumeUsd.toFixed(0)}`,
  ).join("\n");
  const mid = (book.bid1Price + book.ask1Price) / 2;
  const distanceFromMidBps = mid > 0 ? Math.abs(anomaly.windowEndPrice - mid) / mid * 10_000 : 0;
  return `You are a disciplined crypto futures analyst. An anomaly detector has flagged unusual price + volume activity. Decide whether the setup is worth entering OR whether it should be skipped. Default to skip if not clearly favourable.

Output a SINGLE JSON object only (no prose, no markdown fences). Schema:
{
  "kind": "enter" | "skip",
  "side": "long" | "short",                       // required iff kind=enter
  "confidence": <0..1>,                           // required iff kind=enter; calibrated
  "stopBps": <positive integer 80..400>,          // required iff kind=enter; distance from current
  "tpBps":   <positive integer 100..1000>,        // required iff kind=enter; distance from current
  "rationale": "<≤240 chars, factual, no fluff>"
}

DECISION FRAMEWORK
1. Read the anomaly + last bars. Is the move organic (gradual buildup, accelerating volume) or engineered (single wick + retrace, low broader-context confirmation)?
2. Decide CONTINUATION vs REVERSAL:
   - Continuation = enter SAME direction as anomaly (long on pump / short on dump). Use when volume is rising AND book imbalance supports it AND prior bars show same direction.
   - Reversal = enter OPPOSITE direction. Use when anomaly looks like capitulation/exhaustion (very large bar on extreme volume + funding/sentiment extreme) AND prior context shows the move is mature.
3. Confidence calibration:
   - 0.8+ = strong multi-signal alignment, clean structure
   - 0.6 = decent setup, single key signal
   - <0.5 = ambiguous → MUST kind=skip

SKIP IF (any one is true)
- Spread > 8 bps  (illiquid → slippage > edge)
- Anomaly volume < 2x the rolling baseline (too thin)
- Price already moved > 4% from windowStart (too mature, late to enter)
- Window contains a single dominant wick with retrace > 50% (looks like stop hunt)
- No clear directional bias in the last 5 bars (chop)
- Funding rate extreme (>30bps or <-30bps) AND direction matches funding (likely squeeze incoming, risky to chase)

STOPS / TPs
- stopBps in [80, 400]. Tighter (80-150) only when structure is very clean (recent high/low ~1% away).
- tpBps in [100, 1000]. Typical 1.5-2x the stop. Larger TP only for strong continuation, smaller for mean-reversion.
- The runtime applies leverage and notional separately based on equity tier — do NOT factor leverage into your stop choice.

ANOMALY (the trigger)
direction:           ${anomaly.direction}
priceChangeBps:      ${anomaly.priceChangeBps.toFixed(0)}
volumeMultiple:      ${anomaly.volumeMultiple.toFixed(2)}x baseline
windowVolumeUsd:     ${anomaly.windowVolumeUsd.toFixed(0)}
windowStartPrice:    ${anomaly.windowStartPrice}
windowEndPrice:      ${anomaly.windowEndPrice}
spreadBps:           ${anomaly.spreadBps.toFixed(2)}
distanceFromMidBps:  ${distanceFromMidBps.toFixed(2)}
symbol:              ${anomaly.symbol}
detectedAt:          ${new Date(anomaly.detectedAt).toISOString()}

BOOK
bid1:       ${book.bid1Price}
ask1:       ${book.ask1Price}
bidDepthUsd:${book.bidDepthUsd ?? "n/a"}
askDepthUsd:${book.askDepthUsd ?? "n/a"}

DERIVATIVES
fundingRateBps:     ${derivatives?.fundingRateBps ?? "n/a"}
openInterestUsd:    ${derivatives?.openInterestUsd ?? "n/a"}

RECENT BARS (oldest → newest; columns: iso_ts, open, high, low, close, volumeUsd)
${klinesCompact}

Reply with the JSON object only.`;
}

// ─── Response parsing ─────────────────────────────────────────────────────

/**
 * Parse the LLM raw text into a PumpLLMSignal. Tolerant of common LLM quirks:
 *   - leading/trailing prose around the JSON
 *   - markdown code fences (```json ... ```)
 *   - missing optional fields when kind=skip
 * On any unrecoverable malformation, returns a skip signal with rationale.
 */
export function parseLLMResponse(raw: string): PumpLLMSignal {
  const stripped = extractJsonBlock(raw);
  if (!stripped) return { kind: "skip", rationale: "parser:no-json-found" };
  let obj: any;
  try { obj = JSON.parse(stripped); }
  catch { return { kind: "skip", rationale: "parser:malformed-json" }; }
  if (!obj || typeof obj !== "object") return { kind: "skip", rationale: "parser:not-object" };

  const kind = obj.kind;
  if (kind === "skip") {
    return { kind: "skip", rationale: safeStr(obj.rationale) || "llm:skip" };
  }
  if (kind !== "enter") {
    return { kind: "skip", rationale: `parser:invalid-kind:${String(kind)}` };
  }

  const side = obj.side;
  if (side !== "long" && side !== "short") {
    return { kind: "skip", rationale: `parser:invalid-side:${String(side)}` };
  }
  const confidence = numField(obj.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { kind: "skip", rationale: `parser:invalid-confidence:${String(obj.confidence)}` };
  }
  const stopBps = numField(obj.stopBps);
  if (!Number.isFinite(stopBps) || stopBps <= 0) {
    return { kind: "skip", rationale: `parser:invalid-stopBps:${String(obj.stopBps)}` };
  }
  const tpBps = numField(obj.tpBps);
  if (!Number.isFinite(tpBps) || tpBps <= 0) {
    return { kind: "skip", rationale: `parser:invalid-tpBps:${String(obj.tpBps)}` };
  }
  return {
    kind: "enter", side, confidence, stopBps, tpBps,
    rationale: safeStr(obj.rationale) || "llm:enter",
  };
}

function extractJsonBlock(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  // Strip ```json ... ``` fences if present.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fenceMatch) return fenceMatch[1]!.trim();
  // Find first { and last } and slice — tolerates leading prose.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  return trimmed.slice(start, end + 1);
}

function numField(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  return Number.NaN;
}

function safeStr(v: unknown): string {
  return typeof v === "string" ? v.slice(0, 240) : "";
}

// ─── Public: analyzePump composes prompt + provider + parse ───────────────

export async function analyzePump(
  ctx: PumpAnalysisContext,
  provider: PumpAnalyzerProvider,
): Promise<PumpLLMSignal> {
  const prompt = buildPrompt(ctx);
  let raw: string;
  try { raw = await provider.analyze(prompt); }
  catch (err) {
    return { kind: "skip", rationale: `provider-error:${err instanceof Error ? err.message : String(err)}` };
  }
  return parseLLMResponse(raw);
}
