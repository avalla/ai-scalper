/**
 * live-preflight — run BEFORE starting ai-scalper-live.service for the first time.
 *
 * Validates every prerequisite for safe live trading. Exits 0 only if all pass.
 * Designed to be run with the same env file the systemd unit uses:
 *
 *   sudo -E env $(cat /etc/ai-scalper/live.env | grep -v '^#') \
 *     bun run apps/trader/src/scripts/live-preflight.ts
 *
 * Checks (in order — stops on first hard failure):
 *   1. BYBIT_BASE_URL points to mainnet (not testnet)
 *   2. BYBIT_PAPER_TRADING is explicitly "false"
 *   3. API key + secret loaded
 *   4. Wallet balance read OK + ≥ minimum USDT
 *   5. Instrument info available for perp + nearest dated future
 *   6. calendar-rotator picks a valid dated symbol
 *   7. Cross-margin switchable on perp (idempotent — no-op if already cross)
 *   8. Leverage settable on perp at configured value
 *   9. REDIS_URL reachable (and is /1, not /0 paper db)
 */

import { createBybitClient } from "@ai-scalper/bybit-client";
import { createCalendarRotator } from "../pipeline/calendar-rotator";
import { ensureCrossMargin } from "../pipeline/cross-margin";
import IORedis from "ioredis";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIN_WALLET_USDT = 30; // floor below which trading is infeasible
const RED = "\x1b[31m"; const GREEN = "\x1b[32m"; const YELLOW = "\x1b[33m"; const DIM = "\x1b[2m"; const RESET = "\x1b[0m";

function ok(msg: string) { console.log(`${GREEN}✓${RESET} ${msg}`); }
function warn(msg: string) { console.log(`${YELLOW}!${RESET} ${msg}`); }
function fail(msg: string): never { console.log(`${RED}✗${RESET} ${msg}`); process.exit(1); }
function dim(msg: string) { console.log(`${DIM}  ${msg}${RESET}`); }

async function main() {
  console.log("\n=== live-preflight ===\n");

  // 1 — mainnet base url
  const baseUrl = process.env.BYBIT_BASE_URL ?? "";
  if (!baseUrl.includes("api.bybit.com") || baseUrl.includes("testnet")) {
    fail(`BYBIT_BASE_URL must be mainnet (https://api.bybit.com). got: "${baseUrl}"`);
  }
  ok(`mainnet base url: ${baseUrl}`);

  // 2 — paper trading flag explicit
  if (process.env.BYBIT_PAPER_TRADING !== "false") {
    fail(`BYBIT_PAPER_TRADING must be exactly "false" (got: "${process.env.BYBIT_PAPER_TRADING}")`);
  }
  ok(`paper trading: false`);

  // 3 — api credentials present (don't print them)
  if (!process.env.BYBIT_API_KEY || !process.env.BYBIT_API_SECRET) {
    fail(`BYBIT_API_KEY / BYBIT_API_SECRET missing from environment`);
  }
  if (process.env.BYBIT_API_KEY.includes("REPLACE")) {
    fail(`BYBIT_API_KEY still contains REPLACE placeholder`);
  }
  ok(`API credentials loaded (key starts: ${process.env.BYBIT_API_KEY.slice(0, 6)}…)`);

  const client = createBybitClient();

  // 4 — wallet balance read
  let balanceUsd = 0;
  try {
    const raw = await client.getWalletBalance("UNIFIED") as { result?: { list?: any[] } };
    const list = raw?.result?.list ?? [];
    const usdt = list[0]?.coin?.find?.((c: any) => c.coin === "USDT");
    balanceUsd = Number(usdt?.walletBalance ?? 0);
    if (!Number.isFinite(balanceUsd) || balanceUsd <= 0) {
      fail(`wallet balance parsing returned ${balanceUsd}. raw=${JSON.stringify(raw).slice(0, 300)}`);
    }
    if (balanceUsd < MIN_WALLET_USDT) {
      fail(`wallet balance $${balanceUsd.toFixed(2)} < minimum $${MIN_WALLET_USDT}. fund the account first.`);
    }
    ok(`wallet balance: $${balanceUsd.toFixed(2)} USDT`);
  } catch (err) {
    fail(`wallet balance call failed (check API permissions: needs READ on Wallet): ${err instanceof Error ? err.message : err}`);
  }

  // 5 — load live config to know which symbols matter
  const configPath = join(process.cwd(), "..", "trader", process.env.CONFIG_FILE ?? "config.live-pipeline.json");
  let cfg: any;
  try { cfg = JSON.parse(readFileSync(configPath, "utf8")); } catch (err) { fail(`cannot read ${configPath}: ${err instanceof Error ? err.message : err}`); }
  const perp = cfg.calendarSpread?.perpSymbol ?? "BTCUSDT";
  const fallbackDated = cfg.calendarSpread?.datedSymbol ?? "";
  const leverage = cfg.calendarSpread?.leverage ?? 10;
  ok(`live config: perp=${perp} fallbackDated=${fallbackDated || "<empty>"} leverage=${leverage}`);

  // 6 — rotator picks a real symbol
  const baseCoin = perp.replace(/USDT$|USDC$/, "");
  const rotator = createCalendarRotator(client, { baseCoin, refreshMs: 60_000, log: () => {} });
  const pick = await rotator.refresh();
  if (!pick) fail(`calendar-rotator could not pick any dated future for ${baseCoin}. is Bybit listing weeklies/quarterlies for this coin?`);
  const hoursAhead = Math.round((pick.deliveryAt - Date.now()) / 3_600_000);
  ok(`rotator pick: ${pick.symbol} (${hoursAhead}h to settlement)`);

  // 7 — instrument info for perp + picked dated
  try {
    await Promise.all([
      client.getInstrumentInfo({ category: "linear", symbol: perp }),
      client.getInstrumentInfo({ category: "linear", symbol: pick.symbol }),
    ]);
    ok(`instrument info ok for ${perp} + ${pick.symbol}`);
  } catch (err) { fail(`instrument info fetch failed: ${err instanceof Error ? err.message : err}`); }

  // 8 — cross-margin switchable + leverage settable. ensureCrossMargin does both
  // in one idempotent call. retCode 110026/110043 (alreadySet) is success.
  const cm = await ensureCrossMargin({ client, category: "linear", symbol: perp, leverage, log: (p) => dim(`cross-margin: ${JSON.stringify(p)}`) });
  if (!cm.ok) fail(`cross-margin/leverage call failed for ${perp}: ${cm.error}`);
  ok(`cross-margin + leverage=${leverage} on ${perp} (${cm.alreadySet ? "already set" : "applied"})`);

  // 9 — redis reachable, db != 0 (which is paper)
  const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  const dbMatch = redisUrl.match(/\/(\d+)$/);
  const db = dbMatch ? Number(dbMatch[1]) : 0;
  if (db === 0) warn(`REDIS_URL points to DB 0 — paper service also uses DB 0. live ledger will mix with paper. recommended: ${redisUrl}/1`);
  else ok(`REDIS_URL DB ${db} (separate from paper DB 0)`);

  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
  try { await redis.connect(); await redis.ping(); ok(`redis reachable: ${redisUrl}`); }
  catch (err) { fail(`redis unreachable: ${err instanceof Error ? err.message : err}`); }
  finally { await redis.quit().catch(() => {}); }

  console.log(`\n${GREEN}preflight passed${RESET} — safe to start ai-scalper-live.service\n`);
}

main().catch((err) => { console.error(`${RED}preflight crashed:${RESET}`, err); process.exit(2); });
