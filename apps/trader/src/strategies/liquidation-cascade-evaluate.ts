/**
 * Glue between the Redis-backed LiquidationsCache (worker package) and the
 * pure `liquidationCascadeDecide` decision function. Strategy callers (the
 * legacy in-process tick or a future BullMQ open-processor) invoke
 * `evaluateLiquidationCascade` with a per-tick context.
 *
 * Deferred (Phase 2 continuation):
 *   - Open / manage processor pair (mirror llm-managed-*-processor.ts).
 *   - In-process tick integration in run-trader.ts (currently a stub that
 *     idles the subprocess and logs a one-shot warning).
 */
import {
  liquidationCascadeDecide,
  type LiquidationCascadeDecision,
  type LiquidationPrint,
} from "./liquidation-cascade";

export interface LiquidationsReader {
  getRecent(symbol: string, sinceMs: number): Promise<Array<{ ts: number; side: "Buy" | "Sell"; sizeUsd: number }>>;
}

export interface EvaluateLiquidationCascadeArgs {
  cache: LiquidationsReader;
  symbols: string[];
  windowMs: number;
  minClusterUsd: number;
  minCount: number;
  now?: number;
}

/**
 * Across all configured symbols, fetches the recent liquidation prints and
 * runs the cluster-detection decision. Returns the FIRST enter decision
 * (decision function ranks by total USD), else a unified skip.
 */
export async function evaluateLiquidationCascade(
  args: EvaluateLiquidationCascadeArgs,
): Promise<LiquidationCascadeDecision> {
  const now = args.now ?? Date.now();
  const since = now - args.windowMs;
  const prints: LiquidationPrint[] = [];
  for (const symbol of args.symbols) {
    const recent = await args.cache.getRecent(symbol, since);
    for (const r of recent) {
      prints.push({ ts: r.ts, side: r.side, sizeUsd: r.sizeUsd, symbol });
    }
  }
  return liquidationCascadeDecide({
    recentLiquidations: prints,
    windowMs: args.windowMs,
    minClusterUsd: args.minClusterUsd,
    minCount: args.minCount,
    now,
  });
}
