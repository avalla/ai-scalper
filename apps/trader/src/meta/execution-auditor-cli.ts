/**
 * Execution Auditor CLI — runs as long-lived subprocess. Every windowMinutes,
 * pulls fills from Bybit + closed trades from Redis ledger, computes the
 * audit report, writes JSON artifact + structured log.
 */

import IORedis from "ioredis";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import crypto from "node:crypto";
import { readTraderConfig } from "../config";
import { auditExecution, type ExecutionFill, type LedgerCloseEntry } from "./execution-auditor";

const CLOSED_POSITIONS_KEY = "ai-scalper:trader:positions:closed";

interface BybitFill {
  symbol: string;
  side: "Buy" | "Sell";
  isMaker: boolean;
  execFee: string;
  execValue: string;
  execPrice: string;
  execTime: string;
  orderId: string;
}

async function fetchFills(opts: {
  baseUrl: string; apiKey: string; apiSecret: string;
  symbols: string[]; sinceMs: number;
}): Promise<ExecutionFill[]> {
  const out: ExecutionFill[] = [];
  for (const symbol of opts.symbols) {
    let cursor = "";
    for (let page = 0; page < 5; page++) {
      const ts = Date.now().toString(); const rw = "5000";
      const q = `category=linear&symbol=${symbol}&startTime=${opts.sinceMs}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const sign = crypto.createHmac("sha256", opts.apiSecret).update(ts + opts.apiKey + rw + q).digest("hex");
      const r = await fetch(`${opts.baseUrl}/v5/execution/list?${q}`, { headers: {
        "X-BAPI-API-KEY": opts.apiKey,
        "X-BAPI-TIMESTAMP": ts,
        "X-BAPI-RECV-WINDOW": rw,
        "X-BAPI-SIGN": sign,
      }});
      const j = await r.json() as { retCode?: number; result?: { list?: BybitFill[]; nextPageCursor?: string } };
      if (j.retCode !== 0) break;
      const list = j.result?.list ?? [];
      for (const f of list) {
        out.push({
          symbol: f.symbol,
          side: f.side,
          isMaker: f.isMaker === true,
          execFeeUsd: Number(f.execFee || 0),
          execValueUsd: Number(f.execValue || 0),
          execPrice: Number(f.execPrice || 0),
          execTimeMs: Number(f.execTime || 0),
          orderId: f.orderId,
        });
      }
      cursor = j.result?.nextPageCursor || "";
      if (!cursor || list.length < 100) break;
    }
  }
  return out;
}

async function fetchLedger(redis: IORedis, sinceMs: number): Promise<LedgerCloseEntry[]> {
  const raw = await redis.lrange(CLOSED_POSITIONS_KEY, 0, 200);
  const out: LedgerCloseEntry[] = [];
  for (const item of raw) {
    try {
      const e = JSON.parse(item) as LedgerCloseEntry;
      const ts = e.closedAt ? Date.parse(e.closedAt) : NaN;
      if (Number.isFinite(ts) && ts >= sinceMs) out.push(e);
    } catch { /* skip */ }
  }
  return out;
}

async function fetchWalletEquity(opts: { baseUrl: string; apiKey: string; apiSecret: string }): Promise<number | undefined> {
  const ts = Date.now().toString(); const rw = "5000"; const q = "accountType=UNIFIED";
  const sign = crypto.createHmac("sha256", opts.apiSecret).update(ts + opts.apiKey + rw + q).digest("hex");
  try {
    const r = await fetch(`${opts.baseUrl}/v5/account/wallet-balance?${q}`, { headers: {
      "X-BAPI-API-KEY": opts.apiKey, "X-BAPI-TIMESTAMP": ts, "X-BAPI-RECV-WINDOW": rw, "X-BAPI-SIGN": sign,
    }});
    const j = await r.json() as { retCode?: number; result?: { list?: Array<{ totalEquity: string }> } };
    if (j.retCode !== 0) return undefined;
    return Number(j.result?.list?.[0]?.totalEquity ?? "0");
  } catch { return undefined; }
}

async function main(): Promise<void> {
  const cfg = readTraderConfig(process.env);
  if (!cfg.executionAuditorEnabled) {
    console.log(JSON.stringify({ event: "execution-auditor-disabled", reason: "executionAuditor.enabled=false" }));
    return;
  }
  const apiKey = process.env.BYBIT_API_KEY; const apiSecret = process.env.BYBIT_API_SECRET;
  const baseUrl = process.env.BYBIT_BASE_URL || "https://api.bybit.com";
  if (!apiKey || !apiSecret) {
    console.warn(JSON.stringify({ event: "execution-auditor-disabled", reason: "missing BYBIT credentials" }));
    return;
  }
  const redis = process.env.REDIS_URL ? new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null }) : null;
  if (!redis) {
    console.warn(JSON.stringify({ event: "execution-auditor-disabled", reason: "no REDIS_URL" }));
    return;
  }

  const intervalMs = Math.max(cfg.executionAuditorIntervalMinutes * 60_000, 60_000);
  const windowMs = cfg.executionAuditorWindowMinutes * 60_000;
  const symbols = [cfg.calendarPerpSymbol, cfg.calendarDatedSymbol].filter(Boolean) as string[];

  console.log(JSON.stringify({ event: "execution-auditor-loop-started", intervalMinutes: cfg.executionAuditorIntervalMinutes, windowMinutes: cfg.executionAuditorWindowMinutes }));

  let prevWalletEquity = await fetchWalletEquity({ baseUrl, apiKey, apiSecret });

  while (true) {
    const windowEndMs = Date.now();
    const windowStartMs = windowEndMs - windowMs;

    try {
      const [fills, ledger, walletNow] = await Promise.all([
        fetchFills({ baseUrl, apiKey, apiSecret, symbols, sinceMs: windowStartMs }),
        fetchLedger(redis, windowStartMs),
        fetchWalletEquity({ baseUrl, apiKey, apiSecret }),
      ]);

      const report = auditExecution({
        fills, ledgerEntries: ledger,
        walletStartUsd: prevWalletEquity, walletEndUsd: walletNow,
        windowStartMs, windowEndMs,
      });

      try {
        await mkdir(dirname(cfg.executionAuditorArtifactPath), { recursive: true });
        await writeFile(cfg.executionAuditorArtifactPath, JSON.stringify({
          generatedAt: new Date().toISOString(), report,
        }, null, 2), "utf-8");
      } catch (err) {
        console.warn(JSON.stringify({ event: "execution-auditor-artifact-write-failed", error: err instanceof Error ? err.message : String(err) }));
      }

      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        event: "execution-auditor-report",
        fillCount: report.fillCount,
        ledgerTradeCount: report.ledgerTradeCount,
        realFeesUsd: Number(report.realFeesUsd.toFixed(4)),
        estimatedFeesUsd: Number(report.estimatedFeesUsd.toFixed(4)),
        ledgerNetPnlUsd: Number(report.ledgerNetPnlUsd.toFixed(4)),
        makerFillCount: report.makerFillCount,
        takerFillCount: report.takerFillCount,
        perTradeGapUsd: report.perTradeGapUsd !== null ? Number(report.perTradeGapUsd.toFixed(4)) : null,
        flags: report.flags,
      }));

      prevWalletEquity = walletNow;
    } catch (err) {
      console.warn(JSON.stringify({ event: "execution-auditor-tick-failed", error: err instanceof Error ? err.message : String(err) }));
    }

    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ event: "execution-auditor-fatal", error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
