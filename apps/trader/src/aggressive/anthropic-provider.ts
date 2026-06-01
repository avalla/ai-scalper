/**
 * Anthropic Claude provider for the pump analyzer.
 *
 * Wraps a Claude `messages.create` call into the `PumpAnalyzerProvider`
 * interface so the analyzer stays decoupled from the SDK. Uses the SAME SDK
 * the rest of the project already depends on (no new package).
 */

import Anthropic from "@anthropic-ai/sdk";
import type { PumpAnalyzerProvider } from "./pump-analyzer";

export interface AnthropicProviderOptions {
  apiKey?: string;
  /** Defaults to a fast Claude model suitable for short JSON outputs. */
  model?: string;
  /** Hard cap on completion tokens. Default 512 (the response is small JSON). */
  maxTokens?: number;
  /** Hard timeout for the whole call (ms). Default 15s. */
  timeoutMs?: number;
  /** Inject a pre-built client (tests, retries, custom transport). */
  client?: { messages: { create: (req: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> } };
}

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("anthropic-timeout")), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); })
     .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

export function createAnthropicProvider(opts: AnthropicProviderOptions = {}): PumpAnalyzerProvider {
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;

  // Lazy construct so importing this module doesn't require the key.
  let client = opts.client;

  return {
    async analyze(prompt) {
      if (!client) {
        if (!apiKey || apiKey.trim() === "") {
          throw new Error("anthropic-provider:missing-api-key");
        }
        client = new Anthropic({ apiKey }) as unknown as typeof client;
      }
      const response = await withTimeout(
        client!.messages.create({
          model, max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
        timeoutMs,
      );
      // Concatenate text blocks (Claude returns array of content blocks).
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n")
        .trim();
      return text;
    },
  };
}
