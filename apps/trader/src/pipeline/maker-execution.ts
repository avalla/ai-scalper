/**
 * Maker-with-timeout order execution helper for the Phase 3 pipeline.
 *
 * Places a post-only limit at best bid (Buy) / best ask (Sell), polls the order
 * status until it fills or the timeout expires, then cancels and (optionally)
 * falls back to a market order. Designed to replace the pipeline adapters'
 * naked taker Market orders so they pay maker fees on entries that fill.
 *
 * The helper is pure DI: client, ticker source, scheduler (sleep), and now().
 * The legacy in-process trader has its own maker orchestration tangled in
 * run-trader.ts; this module is the pipeline's standalone equivalent.
 */

import type { createBybitClient } from "@ai-scalper/bybit-client";
import type { TickerSource } from "@ai-scalper/bybit-client/ticker-source";

type BybitClient = ReturnType<typeof createBybitClient>;

export type MakerExecutionMode = "taker" | "maker-with-timeout";

export type OrderCategory = "linear" | "spot" | "inverse";
export type OrderSide = "Buy" | "Sell";

export interface MakerExecutionDeps {
  client: BybitClient;
  tickerSource: TickerSource;
  /** Sleep helper (defaults to setTimeout-based). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (payload: Record<string, unknown>) => void;
}

export interface MakerOrderRequest {
  category: OrderCategory;
  symbol: string;
  side: OrderSide;
  qty: string;
  /** Decimal places to format the limit price (from instrument tickSize). Default 2. */
  pricePrecision?: number;
  /** Optional — set true for the closing leg / compensation. */
  reduceOnly?: boolean;
}

export interface MakerExecutionOpts {
  /** How long to wait for the limit to fill before giving up. Default 30s. */
  timeoutMs?: number;
  /** Poll interval while waiting. Default 2s. */
  pollIntervalMs?: number;
  /** If true, place a Market order when the limit didn't fill / was rejected. */
  fallbackToTaker?: boolean;
}

export type MakerExecutionResult =
  | {
      status: "filled-maker";
      orderId: string;
      fillPrice: number;
      qty: number;
    }
  | {
      status: "filled-taker-fallback";
      orderId: string;
      reason: "timeout" | "post-only-rejected";
    }
  | {
      status: "skipped-failed";
      reason: string;
    };

/**
 * Place a post-only limit at the best price on the requested side, wait up to
 * `timeoutMs` for it to fill, then cancel + (optionally) fall back to Market.
 */
export async function placeOrderWithMakerPreference(
  req: MakerOrderRequest,
  deps: MakerExecutionDeps,
  opts: MakerExecutionOpts = {},
): Promise<MakerExecutionResult> {
  const log = deps.log ?? ((p) => console.log(JSON.stringify(p)));
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 2_000;
  const fallbackToTaker = opts.fallbackToTaker ?? true;
  const precision = req.pricePrecision ?? 2;

  // 1. Best-price discovery via the ticker source.
  let bid = 0; let ask = 0;
  try {
    const t = await deps.tickerSource.getTicker(req.symbol, { category: req.category });
    bid = Number(t.bid1Price); ask = Number(t.ask1Price);
  } catch (err) {
    log({ event: "maker-exec-skip", reason: "ticker-unavailable", err: err instanceof Error ? err.message : String(err) });
    return fallbackToTaker
      ? await placeTakerFallback(req, deps, "ticker-unavailable")
      : { status: "skipped-failed", reason: "ticker-unavailable" };
  }
  if (!Number.isFinite(bid) || bid <= 0 || !Number.isFinite(ask) || ask <= 0) {
    return fallbackToTaker
      ? await placeTakerFallback(req, deps, "best-price-invalid")
      : { status: "skipped-failed", reason: "best-price-invalid" };
  }

  // Maker side: a Buy joins the bid; a Sell joins the ask.
  const makerPrice = req.side === "Buy" ? bid : ask;
  const priceStr = makerPrice.toFixed(precision);

  // 2. Place post-only limit.
  let orderId: string;
  try {
    const res = await deps.client.createOrder({
      category: req.category, symbol: req.symbol, side: req.side,
      qty: req.qty, orderType: "Limit", price: priceStr,
      timeInForce: "PostOnly",
      ...(req.reduceOnly ? { reduceOnly: true } : {}),
    } as Parameters<BybitClient["createOrder"]>[0]);
    orderId = res.orderId;
  } catch (err) {
    log({ event: "maker-exec-post-only-rejected", err: err instanceof Error ? err.message : String(err) });
    return fallbackToTaker
      ? await placeTakerFallback(req, deps, "post-only-rejected")
      : { status: "skipped-failed", reason: "post-only-rejected" };
  }

  // 3. Poll until filled, cancelled, rejected, or timeout.
  const start = (deps.now ?? Date.now)();
  while (true) {
    await sleep(pollIntervalMs);
    let order;
    try {
      order = await deps.client.getRealtimeOrder({ category: req.category, symbol: req.symbol, orderId });
    } catch (err) {
      log({ event: "maker-exec-poll-error", err: err instanceof Error ? err.message : String(err) });
      // transient — keep polling within timeout
      order = null;
    }
    if (order) {
      if (order.orderStatus === "Filled") {
        return { status: "filled-maker", orderId, fillPrice: Number(order.avgPrice || makerPrice), qty: Number(order.cumExecQty || req.qty) };
      }
      if (order.orderStatus === "Cancelled" || order.orderStatus === "Rejected") {
        log({ event: "maker-exec-order-terminal", orderStatus: order.orderStatus });
        return fallbackToTaker
          ? await placeTakerFallback(req, deps, "post-only-rejected")
          : { status: "skipped-failed", reason: `order-${order.orderStatus.toLowerCase()}` };
      }
    }
    const elapsed = (deps.now ?? Date.now)() - start;
    if (elapsed >= timeoutMs) {
      // 4. Timeout — cancel + fallback.
      try { await deps.client.cancelOrder({ category: req.category, symbol: req.symbol, orderId }); }
      catch (err) { log({ event: "maker-exec-cancel-failed", err: err instanceof Error ? err.message : String(err) }); }
      return fallbackToTaker
        ? await placeTakerFallback(req, deps, "timeout")
        : { status: "skipped-failed", reason: "timeout" };
    }
  }
}

async function placeTakerFallback(
  req: MakerOrderRequest,
  deps: MakerExecutionDeps,
  reason: "timeout" | "post-only-rejected" | "ticker-unavailable" | "best-price-invalid",
): Promise<MakerExecutionResult> {
  try {
    const res = await deps.client.createOrder({
      category: req.category, symbol: req.symbol, side: req.side,
      qty: req.qty, orderType: "Market",
      ...(req.reduceOnly ? { reduceOnly: true } : {}),
    } as Parameters<BybitClient["createOrder"]>[0]);
    const safeReason: "timeout" | "post-only-rejected" =
      reason === "timeout" ? "timeout" : "post-only-rejected";
    return { status: "filled-taker-fallback", orderId: res.orderId, reason: safeReason };
  } catch (err) {
    return { status: "skipped-failed", reason: `taker-fallback-failed:${err instanceof Error ? err.message : String(err)}` };
  }
}
