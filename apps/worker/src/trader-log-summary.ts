function readString(
  parsed: Record<string, unknown>,
  key: string,
): string | null {
  const value = parsed[key];
  return typeof value === "string" ? value : null;
}

function readNumber(
  parsed: Record<string, unknown>,
  key: string,
): number | null {
  const value = parsed[key];
  return typeof value === "number" ? value : null;
}

function readTopRankedSetups(parsed: Record<string, unknown>): string | null {
  const value = parsed.rankedSetupsTop;
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const compact = value
    .slice(0, 3)
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const typedEntry = entry as Record<string, unknown>;
      const symbol = typeof typedEntry.symbol === "string" ? typedEntry.symbol : null;
      const action = typeof typedEntry.action === "string" ? typedEntry.action : null;
      const score = typeof typedEntry.score === "number" ? typedEntry.score : null;

      if (!symbol) {
        return null;
      }

      return `${symbol}${action ? `:${action}` : ""}${score !== null ? `@${score}` : ""}`;
    })
    .filter((entry): entry is string => Boolean(entry));

  return compact.length > 0 ? compact.join(",") : null;
}

export function summarizeTraderStdout(line: string): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }

  const symbol = readString(parsed, "symbol") ?? "unknown";
  const action = readString(parsed, "action") ?? "unknown";
  const risk = readString(parsed, "risk") ?? "unknown";
  const aggressiveRisk = readString(parsed, "aggressiveRisk") ?? "unknown";
  const mode = readString(parsed, "mode") ?? "unknown";
  const intent = readString(parsed, "intent");
  const intentReason = readString(parsed, "intentReason");
  const ticks = readNumber(parsed, "ticks");
  const topRanked = readTopRankedSetups(parsed);
  const position = parsed.position;
  const lastExecution = parsed.lastExecution && typeof parsed.lastExecution === "object"
    ? parsed.lastExecution as Record<string, unknown>
    : null;

  const summaryParts = [
    `mode=${mode}`,
    `pair=${symbol}`,
    `signal=${action}`,
  ];

  if (ticks !== null) {
    summaryParts.push(`ticks=${ticks}`);
  }

  if (topRanked) {
    summaryParts.push(`top=${topRanked}`);
  }

  if (intent) {
    summaryParts.push(`intent=${intent}`);
  } else if (action === "long" || action === "short") {
    summaryParts.push(`intent=open-${action}`);
  }

  if (intentReason) {
    summaryParts.push(`reason=${intentReason}`);
  }

  if (risk !== "allowed") {
    summaryParts.push(`risk=${risk}`);
  }

  if (aggressiveRisk !== "allowed") {
    summaryParts.push(`aggressiveRisk=${aggressiveRisk}`);
  }

  if (lastExecution) {
    const executionMode = readString(lastExecution, "executionMode") ?? "unknown";
    const filled = lastExecution.filled;
    summaryParts.push(`execution=${executionMode}`);
    if (typeof filled === "boolean") {
      summaryParts.push(`filled=${filled}`);
    }
  }

  if (position && typeof position === "object") {
    const typedPosition = position as Record<string, unknown>;
    const side = readString(typedPosition, "side") ?? "unknown";
    const entryPrice = typedPosition.entryPrice;
    summaryParts.push(`position=${side}`);
    if (typeof entryPrice === "number") {
      summaryParts.push(`entry=${entryPrice}`);
    }
  } else {
    summaryParts.push("position=flat");
  }

  return summaryParts.join(" ");
}
