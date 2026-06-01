import { describe, expect, test } from "bun:test";
import { createAnthropicProvider } from "./anthropic-provider";

describe("createAnthropicProvider", () => {
  test("concatenates text blocks from the response", async () => {
    const client = {
      messages: {
        async create(_req: any) {
          return { content: [{ type: "text", text: "part1" }, { type: "text", text: "part2" }] };
        },
      },
    };
    const p = createAnthropicProvider({ client, apiKey: "x" });
    expect(await p.analyze("ping")).toBe("part1\npart2");
  });

  test("filters out non-text content blocks", async () => {
    const client = {
      messages: {
        async create() {
          return { content: [{ type: "tool_use" }, { type: "text", text: "kept" }] };
        },
      },
    };
    const p = createAnthropicProvider({ client, apiKey: "x" });
    expect(await p.analyze("ping")).toBe("kept");
  });

  test("propagates timeout when SDK call hangs", async () => {
    const client = {
      messages: { create: () => new Promise<never>(() => { /* never resolves */ }) },
    };
    const p = createAnthropicProvider({ client, apiKey: "x", timeoutMs: 50 });
    await expect(p.analyze("ping")).rejects.toThrow(/anthropic-timeout/);
  });

  test("throws when no API key configured and no client injected", async () => {
    const orig = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const p = createAnthropicProvider();
      await expect(p.analyze("ping")).rejects.toThrow(/missing-api-key/);
    } finally {
      if (orig !== undefined) process.env.ANTHROPIC_API_KEY = orig;
    }
  });

  test("passes the prompt as the user message", async () => {
    let captured: any;
    const client = {
      messages: { async create(req: any) { captured = req; return { content: [{ type: "text", text: "ok" }] }; } },
    };
    const p = createAnthropicProvider({ client, apiKey: "x" });
    await p.analyze("the-prompt");
    expect(captured.messages[0].content).toBe("the-prompt");
    expect(captured.messages[0].role).toBe("user");
  });
});
