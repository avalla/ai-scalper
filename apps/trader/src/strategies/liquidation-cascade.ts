/**
 * Liquidation-cascade strategy (pure logic, no I/O).
 *
 * Detects clusters of liquidation prints in a rolling window per (symbol, side)
 * and decides a mean-reversion entry.
 *
 * Bybit V5 semantics:
 *   publicTrade with BT=true is a "block trade" — used for forced liquidations.
 *   The `side` field is the side of the LIQUIDATION ORDER (a forced market
 *   close). A liquidation `side="Sell"` means LONGS were forcibly sold off
 *   (longs liquidated → price pressure DOWN → mean reverts UP).
 *
 *   liquidation side "Sell"  → longs liquidated  → enter LONG to catch rebound
 *   liquidation side "Buy"   → shorts liquidated → enter SHORT (rebound from short squeeze)
 *
 * Exit logic is handled by callers via the existing manage primitives
 * (time-based + bps-against). This module only emits the entry decision.
 */

export interface LiquidationPrint {
  ts: number;
  symbol: string;
  side: "Buy" | "Sell";
  sizeUsd: number;
}

export interface LiquidationCluster {
  symbol: string;
  /** Side of the liquidations (forced closes). */
  side: "Buy" | "Sell";
  totalUsd: number;
  count: number;
  startedAt: number;
  endedAt: number;
}

export interface LiquidationCascadeInput {
  recentLiquidations: LiquidationPrint[];
  windowMs: number;
  minClusterUsd: number;
  minCount: number;
  now: number;
}

export type LiquidationCascadeDecision =
  | { kind: "enter"; symbol: string; side: "long" | "short"; reason: string; clusterUsd: number; cluster: LiquidationCluster }
  | { kind: "skip"; reason: string };

export function detectClusters(input: LiquidationCascadeInput): LiquidationCluster[] {
  const cutoff = input.now - input.windowMs;
  const fresh = input.recentLiquidations.filter((p) => p.ts >= cutoff && p.sizeUsd > 0);
  const groups = new Map<string, LiquidationCluster>();
  for (const p of fresh) {
    const sym = p.symbol.toUpperCase();
    const key = `${sym}|${p.side}`;
    const cur = groups.get(key);
    if (!cur) {
      groups.set(key, {
        symbol: sym,
        side: p.side,
        totalUsd: p.sizeUsd,
        count: 1,
        startedAt: p.ts,
        endedAt: p.ts,
      });
    } else {
      cur.totalUsd += p.sizeUsd;
      cur.count += 1;
      if (p.ts < cur.startedAt) cur.startedAt = p.ts;
      if (p.ts > cur.endedAt) cur.endedAt = p.ts;
    }
  }
  return Array.from(groups.values())
    .filter((c) => c.totalUsd >= input.minClusterUsd && c.count >= input.minCount)
    .sort((a, b) => b.totalUsd - a.totalUsd);
}

export function liquidationCascadeDecide(input: LiquidationCascadeInput): LiquidationCascadeDecision {
  if (input.recentLiquidations.length === 0) {
    return { kind: "skip", reason: "no-liquidations" };
  }
  const clusters = detectClusters(input);
  if (clusters.length === 0) {
    return { kind: "skip", reason: "no-cluster-meets-threshold" };
  }
  const top = clusters[0]!;
  // Reverse: longs liquidated (side=Sell) → enter LONG; shorts liquidated (side=Buy) → enter SHORT
  const enterSide: "long" | "short" = top.side === "Sell" ? "long" : "short";
  const liquidatedSide = top.side === "Sell" ? "longs" : "shorts";
  return {
    kind: "enter",
    symbol: top.symbol,
    side: enterSide,
    reason: `cascade-${liquidatedSide}-liquidated-$${Math.round(top.totalUsd)}-n${top.count}`,
    clusterUsd: top.totalUsd,
    cluster: top,
  };
}
