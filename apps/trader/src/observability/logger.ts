import pino, { type Logger } from "pino";

/**
 * Structured logger for ai-scalper. Reads LOG_LEVEL from env (default: "info").
 * Use `logEvent(name, data)` for structured event lines that match the legacy
 * `{event, ...}` shape used elsewhere in the codebase.
 */
export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "ai-scalper-trader" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function logEvent(name: string, data: Record<string, unknown> = {}): void {
  logger.info({ event: name, ...data });
}

export function createTestLogger(opts: {
  level?: string;
  destination?: pino.DestinationStream;
}): Logger {
  return pino(
    {
      level: opts.level ?? "info",
      base: { app: "ai-scalper-trader" },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    opts.destination,
  );
}
