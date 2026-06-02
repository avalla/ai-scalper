/**
 * ensureCrossMargin — idempotent helper used by every adapter that opens a
 * leveraged position. Sets the symbol to CROSS margin mode with the configured
 * leverage. Tolerates "already set" (alreadySet=true) silently and logs but
 * does not throw on transient API errors (operator may have explicitly chosen
 * isolated for a reason).
 *
 * Why per-trade: cross vs isolated is a per-symbol setting on Classic Bybit
 * accounts. The pump-scanner trades a dynamic universe of 50-80 symbols, and
 * manual UI-clicking each is impractical. The Bybit API is cheap and
 * idempotent, so calling before each entry is the safest approach.
 *
 * The leverage is sent in the SAME call (Bybit applies both together). This
 * means callers can typically skip a separate `setLeverage` call when they
 * use this helper, but doing both is harmless.
 */

import type { createBybitClient } from "@ai-scalper/bybit-client";

type BybitClient = ReturnType<typeof createBybitClient>;

export interface EnsureCrossMarginParams {
  client: BybitClient;
  category: "linear" | "inverse";
  symbol: string;
  leverage: number;
  log?: (payload: Record<string, unknown>) => void;
}

export async function ensureCrossMargin(params: EnsureCrossMarginParams): Promise<{ ok: boolean; alreadySet?: boolean; error?: string }> {
  const log = params.log ?? ((p) => console.log(JSON.stringify(p)));
  try {
    const r = await params.client.switchPositionMarginMode({
      category: params.category,
      symbol: params.symbol,
      tradeMode: 0, // 0 = cross
      buyLeverage: String(params.leverage),
      sellLeverage: String(params.leverage),
    });
    if (!r.alreadySet) {
      log({ event: "cross-margin-applied", symbol: params.symbol, leverage: params.leverage });
    }
    return { ok: true, alreadySet: r.alreadySet };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log({ event: "cross-margin-failed", symbol: params.symbol, leverage: params.leverage, err: msg });
    return { ok: false, error: msg };
  }
}
