import { describe, expect, test } from "bun:test";
import { parseAnthropicUsage, recordAnthropicResponseUsage } from "./anthropic-usage";

describe("parseAnthropicUsage", () => {
  test("extracts the standard usage block", () => {
    expect(parseAnthropicUsage({
      usage: { input_tokens: 100, output_tokens: 50 },
    })).toEqual({ inputTokens: 100, cachedTokens: 0, outputTokens: 50 });
  });

  test("lumps cache_creation into inputTokens; cache_read into cachedTokens", () => {
    expect(parseAnthropicUsage({
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 200,
        output_tokens: 50,
      },
    })).toEqual({ inputTokens: 130, cachedTokens: 200, outputTokens: 50 });
  });

  test("returns null for unparseable responses", () => {
    expect(parseAnthropicUsage(null)).toBeNull();
    expect(parseAnthropicUsage({})).toBeNull();
    expect(parseAnthropicUsage("not-an-object")).toBeNull();
    expect(parseAnthropicUsage({ usage: "string" })).toBeNull();
  });

  test("recordAnthropicResponseUsage is a no-op without a tracker", async () => {
    await recordAnthropicResponseUsage(undefined, { usage: { input_tokens: 1 } }, "m");
  });

  test("recordAnthropicResponseUsage forwards parsed usage to the tracker", async () => {
    const calls: unknown[] = [];
    const tracker = {
      async recordAnthropicCall(u: unknown) { calls.push(u); },
    };
    await recordAnthropicResponseUsage(tracker, {
      usage: { input_tokens: 10, output_tokens: 2 },
    }, "claude-haiku-4-5");
    expect(calls).toEqual([{
      inputTokens: 10, cachedTokens: 0, outputTokens: 2, model: "claude-haiku-4-5",
    }]);
  });

  test("recordAnthropicResponseUsage swallows tracker errors", async () => {
    const tracker = {
      async recordAnthropicCall() { throw new Error("boom"); },
    };
    await recordAnthropicResponseUsage(tracker, {
      usage: { input_tokens: 1, output_tokens: 1 },
    }, "m");
  });
});
