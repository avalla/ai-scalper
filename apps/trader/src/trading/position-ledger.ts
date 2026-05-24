import IORedis from "ioredis";
import type { OpenPosition, TraderState } from "@ai-scalper/trading-core";

const OPEN_STATE_KEY = "ai-scalper:trader:position-state";
const CLOSED_POSITIONS_KEY = "ai-scalper:trader:positions:closed";
const CLOSED_POSITIONS_LIMIT = 100;

interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  lpush(key: string, value: string): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  quit(): Promise<unknown>;
  disconnect(): void;
}

export interface PersistedTraderSnapshot extends TraderState {
  openPositionSymbol: string | null;
  updatedAt: string;
}

export interface ClosedPositionLedgerEntry {
  closedAt: string;
  cumulativeRealizedPnlUsd: number;
  entryPrice: number;
  exitPrice: number;
  exitReason: string;
  leverage: number;
  notionalUsd: number;
  openedAt: string;
  quantity: number;
  /** Net PnL (gross minus fees) — what actually hits the wallet. */
  realizedPnlUsd: number;
  /** Pre-fee gross PnL. Optional for backward-compat with old ledger entries. */
  grossPnlUsd?: number;
  /** Round-trip fee charged on this close. Optional for backward-compat. */
  feeUsd?: number;
  /** Bandit champion variant that was active at entry — for per-variant attribution. */
  championIdAtEntry?: string | null;
  /** Strategy that produced this trade. Optional for backward-compat with old ledger entries. */
  strategyType?: "ma-crossover" | "funding-arb" | "longer-tf" | "basis-arb" | "pairs-trading" | "bollinger-adx" | "calendar-spread" | "llm-managed" | "liquidation-cascade";
  /** LLM-managed: which action was the close attributed to (tp-full, cut-loss, scale-out, safety-hard-sl, ...). */
  llmManagedAction?: string;
  /** LLM-managed: reasoning string from the LLM (or safety system) for this close. */
  llmManagedReasoning?: string;
  /** Basis (bps) at entry — present for basis-arb trades, undefined otherwise. */
  basisEntryBps?: number;
  /** Basis (bps) at exit — present for basis-arb trades, undefined otherwise. */
  basisExitBps?: number;
  /** Pairs-trading: the leg2 symbol (leg1 is recorded in `symbol`). */
  pairsLeg2Symbol?: string;
  /** Pairs-trading: spread z-score at entry. */
  pairsEntryZ?: number;
  /** Pairs-trading: spread z-score at exit. */
  pairsExitZ?: number;
  /** Calendar-spread: dated quarterly symbol (perp is recorded in `symbol`). */
  calendarDatedSymbol?: string;
  /** Calendar-spread: spread bps at entry. */
  calendarEntrySpreadBps?: number;
  /** Calendar-spread: spread bps at exit. */
  calendarExitSpreadBps?: number;
  side: OpenPosition["side"];
  stopLossPrice: number;
  symbol: string;
  takeProfitPrice: number;
}

export function createPositionLedgerClient(redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379"): RedisClientLike {
  return new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
  });
}

function isOpenPosition(value: unknown): value is OpenPosition {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    (candidate.side === "long" || candidate.side === "short")
    && typeof candidate.quantity === "number"
    && typeof candidate.notionalUsd === "number"
    && typeof candidate.entryPrice === "number"
    && typeof candidate.leverage === "number"
    && typeof candidate.openedAt === "number"
    && typeof candidate.stopLossPrice === "number"
    && typeof candidate.takeProfitPrice === "number"
  );
}

function parsePersistedTraderSnapshot(raw: string): PersistedTraderSnapshot | null {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const position = parsed.position;

  if (
    (parsed.lastTradeAt !== null && typeof parsed.lastTradeAt !== "number")
    || typeof parsed.realizedPnlUsd !== "number"
    || (position !== null && !isOpenPosition(position))
    || (parsed.openPositionSymbol !== null && typeof parsed.openPositionSymbol !== "string")
    || typeof parsed.updatedAt !== "string"
  ) {
    return null;
  }

  const dayStartedAt =
    parsed.dayStartedAt === undefined || parsed.dayStartedAt === null
      ? null
      : typeof parsed.dayStartedAt === "number"
        ? parsed.dayStartedAt
        : null;

  return {
    lastTradeAt: parsed.lastTradeAt as number | null,
    realizedPnlUsd: parsed.realizedPnlUsd,
    position: (position as OpenPosition | null) ?? null,
    dayStartedAt,
    openPositionSymbol: (parsed.openPositionSymbol as string | null) ?? null,
    updatedAt: parsed.updatedAt,
  };
}

export interface PositionLedgerOptions {
  /**
   * Optional cost tracker — when provided, `appendClosedPosition` records the
   * trade's `feeUsd` into the rolling cost window. Loose coupling so the
   * ledger remains usable without Redis-backed cost tracking.
   */
  costTracker?: { recordBybitFee(feeUsd: number): Promise<void> };
}

export function createPositionLedger(
  client: RedisClientLike = createPositionLedgerClient(),
  options: PositionLedgerOptions = {},
) {
  return {
    async appendClosedPosition(entry: ClosedPositionLedgerEntry): Promise<void> {
      await client.lpush(CLOSED_POSITIONS_KEY, JSON.stringify(entry));
      await client.ltrim(CLOSED_POSITIONS_KEY, 0, CLOSED_POSITIONS_LIMIT - 1);
      if (options.costTracker && typeof entry.feeUsd === "number" && entry.feeUsd > 0) {
        try {
          await options.costTracker.recordBybitFee(entry.feeUsd);
        } catch { /* tracker is best-effort; don't break ledger writes */ }
      }
    },

    async close(): Promise<void> {
      await client.quit();
      client.disconnect();
    },

    async loadSnapshot(): Promise<PersistedTraderSnapshot | null> {
      const raw = await client.get(OPEN_STATE_KEY);
      if (!raw) {
        return null;
      }

      try {
        return parsePersistedTraderSnapshot(raw);
      } catch {
        return null;
      }
    },

    async syncSnapshot(snapshot: PersistedTraderSnapshot): Promise<void> {
      await client.set(OPEN_STATE_KEY, JSON.stringify(snapshot));
    },
  };
}
