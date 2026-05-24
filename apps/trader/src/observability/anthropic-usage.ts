/**
 * Extract token usage from an Anthropic SDK response (shape returned by
 * `Anthropic.messages.create`). Returns null if the response doesn't have
 * a parseable usage block — keeps cost recording best-effort.
 *
 * The Anthropic SDK exposes:
 *   response.usage = {
 *     input_tokens, output_tokens,
 *     cache_creation_input_tokens, cache_read_input_tokens
 *   }
 *
 * We treat `cache_read_input_tokens` as cached (cheap), `input_tokens` as
 * the regular new input. Cache-creation tokens are billed at full input
 * price, so we lump them into `inputTokens`.
 */
export function parseAnthropicUsage(response: unknown): {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
} | null {
  if (!response || typeof response !== "object") return null;
  const usage = (response as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const inputRaw = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const cacheCreate = typeof u.cache_creation_input_tokens === "number"
    ? u.cache_creation_input_tokens
    : 0;
  const cacheRead = typeof u.cache_read_input_tokens === "number"
    ? u.cache_read_input_tokens
    : 0;
  const outputRaw = typeof u.output_tokens === "number" ? u.output_tokens : 0;
  return {
    inputTokens: inputRaw + cacheCreate,
    cachedTokens: cacheRead,
    outputTokens: outputRaw,
  };
}

export async function recordAnthropicResponseUsage(
  tracker: { recordAnthropicCall(usage: {
    inputTokens: number; cachedTokens: number; outputTokens: number; model: string;
  }): Promise<void> } | undefined,
  response: unknown,
  model: string,
): Promise<void> {
  if (!tracker) return;
  const parsed = parseAnthropicUsage(response);
  if (!parsed) return;
  try {
    await tracker.recordAnthropicCall({ ...parsed, model });
  } catch {
    /* best-effort */
  }
}
