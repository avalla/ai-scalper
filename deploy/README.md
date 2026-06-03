# Deploy runbook

Three supported paths: manual (tmux), systemd, docker-compose. Pick one.

## Prerequisites

- Linux host (x86_64; arm64 also works with `oven/bun:1` images)
- Bun >= 1.3.6 (manual / systemd) — `curl -fsSL https://bun.sh/install | bash`
- Redis >= 7 (any deploy)
- Outbound HTTPS to `api.bybit.com` / `api-testnet.bybit.com` and `api.anthropic.com`
- **WS feeder only** — outbound WSS to `stream.bybit.com:443`
  (or `stream-testnet.bybit.com:443`) when `USE_WEBSOCKET=true`

## Environment

Copy `.env.example` to `.env` at the repo root and fill in:

| Var | Required | Notes |
|---|---|---|
| `BYBIT_API_KEY` / `BYBIT_API_SECRET` | live only | omit for paper |
| `BYBIT_PAPER_TRADING` | yes | `true` (default) or `false` |
| `BYBIT_BASE_URL` | optional | defaults to testnet |
| `REDIS_URL` | yes | `redis://127.0.0.1:6379` for local |
| `ANTHROPIC_API_KEY` | optional | enables LLM strategies + advisor |
| `ALERT_WEBHOOK_URL` | optional | Discord/Slack/Telegram webhook for health alerts |
| `LOG_LEVEL` | optional | `info` (default), `debug`, `warn` |
| `CONFIG_FILE` | optional | per-strategy config selector (e.g. `config.funding-arb.json`) |
| `USE_WEBSOCKET` | optional | when `true`, `start-stack` spawns the `ws-feeder-cli` process; mirror of trader config `runtime.useWebSocket` |
| `WS_FEEDER_SYMBOLS` | optional | comma-separated symbol list; defaults to the top-liquid set (BTC/ETH/SOL/XRP/DOGE/BNB) |
| `BYBIT_WS_BASE_URL` | optional | defaults to `wss://stream.bybit.com/v5/public` |
| `BYBIT_WS_CATEGORY` | optional | `linear` (default) / `spot` / `inverse` |

`.env` MUST live next to the `docker-compose.yml` if using docker.

## Option A — Manual (tmux)

```bash
git clone <repo> ai-scalper && cd ai-scalper
bun install
cp .env.example .env  # then edit
tmux new-session -d -s scalper 'bun run all'
tmux attach -t scalper
```

Detach with `Ctrl-b d`. Kill with `tmux kill-session -t scalper`.

## Option B — systemd

```bash
# 1. Place repo in /opt/ai-scalper, owned by user `trader`
sudo useradd -r -m -d /opt/ai-scalper -s /bin/bash trader || true
sudo chown -R trader:trader /opt/ai-scalper
sudo -u trader bash -lc 'cd /opt/ai-scalper && bun install'

# 2. Install the unit
sudo cp deploy/ai-scalper.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ai-scalper

# 3. Follow logs
journalctl -u ai-scalper -f
```

Stop: `sudo systemctl stop ai-scalper`. Restart: `sudo systemctl restart ai-scalper`.

## Option C — Docker Compose

```bash
cp .env.example .env  # then edit; REDIS_URL is auto-set to redis://redis:6379
docker compose up -d --build
docker compose logs -f bot
```

Stop: `docker compose down`. Persisted: `redis-data` volume + `apps/trader/data/`.

## WS feeder (Phase 1 — opt-in)

When `USE_WEBSOCKET=true` and `runtime.useWebSocket` is enabled in the
trader config, `start-stack` spawns an additional long-running process
(`apps/worker/src/ws-feeder-cli.ts`) that maintains a single Bybit V5
public WebSocket connection and publishes every ticker update to Redis.
The market scanner reads from that shared cache; other strategies still
use REST in Phase 1. Resource cost: one persistent connection, ~1KB/sec.

Run standalone for debugging:

```bash
cd apps/worker
WS_FEEDER_SYMBOLS=BTCUSDT,ETHUSDT bun src/ws-feeder-cli.ts
```

## Monitoring

- **Bull Board** — `http://localhost:3010/admin/queues` — live queue state for every BullMQ worker.
- **/health** — `http://localhost:3010/health` — JSON snapshot; HTTP 200 = healthy, 503 = degraded. Use for k8s/uptime probes.
- **Logs** — pino JSON lines on stdout. `bun run report` prints aggregated PnL + costs.
- **Alerts** — when `ALERT_WEBHOOK_URL` is set, two consecutive `/health` failures POST a payload to the webhook.
- **Daily PnL report** — `bun run report:daily` builds the last-24h report (configurable via `DAILY_REPORT_WINDOW_HOURS`) and posts it to `ALERT_WEBHOOK_URL` (stdout-only if unset). Schedule via cron, e.g. `0 9 * * * cd /opt/ai-scalper && /home/trader/.bun/bin/bun run report:daily`, or a systemd timer.

## Multi-strategy (concurrent)

Run N strategies side-by-side as isolated trader subprocesses. Shared worker stack (BullMQ, Bull Board, /health, optional WS feeder/advisor) stays single instance via `bun run up`; the multi-supervisor only manages the trader processes.

```
# In one terminal: shared infra
bun run up

# In another: N traders, one per config file
STRATEGY_CONFIGS="config.funding-arb.json,config.basis-arb.json,config.bollinger-adx.json" \
  bun run up:multi
```

Each child's stdout is prefixed with `[<strategy-name>]` and interleaved on the supervisor's stdout. SIGTERM/SIGINT propagate to all children; if any child crashes, the supervisor tears down the rest (fail-fast — operator restarts via systemd).

## Private WebSocket (positions)

The package exports `createBybitWsPrivateClient` (WS auth + position subscription) and `createWsPrivatePositionSource` (cache + REST fallback). `funding-arb-manage-processor` accepts an optional `positionSource` dep — when wired, reconcile reads come from the WS cache with REST fallback after 5s staleness; otherwise legacy REST passthrough is preserved. Other strategies still use REST polling; migration is incremental.

To wire end-to-end (next step): construct the WS private client at worker bootstrap, start it, build a `createWsPrivatePositionSource({ws, fallback})`, and pass it to the funding-arb manage worker as `positionSource`. Until then, the abstraction is in place and tested but not active.

## Phase 3 pipeline (scan → evaluate → trading-agent)

Opt-in via trader config `runtime.usePipeline: true`. When enabled, the worker
replaces the legacy per-strategy open-processors for the piloted strategies
(`funding-arb`, `basis-arb`, `longer-tf`, `bollinger-adx`, `calendar-spread`,
`pairs-trading`) with a three-stage flow:

```
[1] market-scan            (recurring, unchanged)
[2] strategy-evaluate      (stateless: market + config → TradingIntent[])
[3] trading-agent          (single executor; per-strategy adapters place
                            orders + enqueue the manage job)
```

- The trading-agent enforces a single GLOBAL one-position invariant across all
  piloted manage queues (not per-strategy).
- Manage workers are reused verbatim from Phase 2 — position lifecycle is
  identical.
- `usePipeline` is mutually exclusive with the legacy Phase 2 open stacks: when
  on, `useBullmqJobs` open-processors are suppressed to avoid double-opens.
- New Bull Board queues: `strategy-evaluate`, `trading-agent`.
- Pilot scope: `funding-arb`, `basis-arb`, `longer-tf`, `bollinger-adx`,
  `calendar-spread`, `pairs-trading`. The kline strategies (`longer-tf`,
  `bollinger-adx`, `pairs-trading`) fetch klines fresh each evaluate tick (the
  worker-side cache was dropped for statelessness). Still on the legacy path
  (`usePipeline: false`): `ma-crossover` (bandit state), `llm-managed` (LLM
  memory), `liquidation-cascade` (microstructure).

## Leveraged trading (pipeline pilots) — opt-in

`calendar-spread` and `basis-arb` support cross-margin leverage on the perp legs.
Three safety guards make this responsible to enable; **none of them are optional
when leverage > 1**.

### Per-strategy config

```jsonc
{
  "calendarSpread": {
    "leverage": 5,                    // clamped to [1, 10]; default 1
    "spreadDivergenceStopBps": 30,    // close immediately if |spread| widens
                                      // > 30bps beyond entry. 0 = disabled.
    // ... other calendarSpread fields
  },
  "basisArb": {
    "leverage": 5,
    "spreadDivergenceStopBps": 30,
    // ... other basisArb fields
  }
}
```

### The three guards (built-in)

1. **Hard leverage ceiling** — `clampLeverage` in `config.ts` caps every leverage
   value to `MAX_LEVERAGE_ALLOWED = 10`. Configs above that emit a `leverage-
   clamped` warning and are clamped, not rejected. **There is no way to run
   above 10x via JSON config**; the ceiling is a code-level safety policy.
2. **Spread-divergence stop** — each manage processor checks `|currentSpread| -
   |entrySpread|` before deciding. If the gap exceeds `spreadDivergenceStopBps`
   the position closes immediately as `divergence-stop`, capping the leveraged
   loss before the spread can blow further. Setting `0` disables the guard
   (acceptable at 1x leverage; **dangerous at higher leverage**).
3. **Pre-trade leverage upsert** — adapters call `setLeverage` on the perp leg(s)
   before placing entries so Bybit's account-level leverage matches the intent
   (avoids partial fills using a stale leverage setting).

### What the math does (calendar-spread example)

| leverage | qty/leg | exposure | margin used | gross/trade | net @ maker (4bps) |
|---|---|---|---|---|---|
| 1x | 0.002 BTC | $292 | $292 | $0.38 | $0.27 |
| 5x | 0.010 BTC | $1460 | $292 | $1.90 | $1.35 |
| 10x | 0.020 BTC | $2920 | $292 | $3.80 | $2.70 |

Same margin → linear scale of both gross and (assumption-based) net. Real risk
also scales linearly — a 100bps adverse divergence at 10x = $29 of loss (vs ~$3
at 1x). That's why `spreadDivergenceStopBps` is mandatory at higher leverage.

### Account-side prerequisite (Bybit UI)

Set the Bybit unified account to **Cross Margin**. This is not done by code —
it's an account setting in the exchange UI. Without it, each leg uses isolated
margin and the "cross safety" between legs doesn't apply.

## Aggressive trader (leveraged, capital-tiered) — DANGEROUS, opt-in

Separate subsystem alongside the conservative pipeline. Different queues
(`aggressive-evaluate`, `aggressive-manage`), separate ledger namespace
(`ai-scalper:aggressive:positions:closed`), own one-position invariant, own
config file. The two subsystems never share state — by design.

### Pipeline
```
liquidation events ──▶ liquidation-map (heuristic, free)
                              ▼
                       liquidation-hunter (direction + stop + TP)
                              ▼
                       guards (daily-loss-cap, max-trades, capital-cap)
                              ▼
                       placeAggressiveEntry ──▶ manage tick (stop/TP every 2s)
```

### Prerequisites
- **WS feeder MUST be running** (`USE_WEBSOCKET=true`) — the aggressive
  events-reader requires price-tagged liquidation events written by the feeder.
  Without it the liquidation map stays empty and nothing trades.
- Bybit account on **Cross Margin** if going live (the leverage values in the
  tier ladder go up to 25x and assume cross).

### Activation

1. Copy and edit the example config:
```bash
cp apps/trader/config.aggressive.example.json apps/trader/config.aggressive.json
$EDITOR apps/trader/config.aggressive.json   # set "enabled": true, tune sizing
```
2. Confirm WS feeder + paper trading env are set on the worker service.
3. Restart the worker:
```bash
sudo systemctl restart ai-scalper-paper
```
At startup you'll see `{"event":"aggressive-stack-ready",...}` in
`/tmp/ai-scalper-paper.log` if the config loaded and is `enabled: true`.

### Risk profile (read before enabling)
- Default starting equity: $100 paper. Default max capital: $200. Treat as
  capital you're prepared to lose entirely.
- Default tier 1: **leverage 25x**, $50 notional/trade, -2% hard stop → a
  hit stop = -50% of account. Two consecutive stops = -75%.
- Daily-loss cap defaults to 50% of day-start equity — once tripped, no new
  entries until UTC midnight.
- Hard ceiling: max `MAX_LEVERAGE_ALLOWED=10` for the conservative pipeline
  guards do NOT apply here. The aggressive subsystem deliberately uses its
  own tier-ladder leverage (typed `number`), so a typo in
  `config.aggressive.json` is not auto-clamped. **Validate your ladder.**

### Monitoring (aggressive ledger separate from conservative)
```bash
redis-cli LRANGE ai-scalper:aggressive:positions:closed 0 -1 \
  | jq -s 'if length==0 then "no aggressive trades yet" else {trades:length, gross:(map(.grossPnlUsd)|add), fees:(map(.feeUsd)|add), net:(map(.realizedPnlUsd)|add), avg_net:((map(.realizedPnlUsd)|add)/length), wins:(map(select(.realizedPnlUsd>0))|length), losses:(map(select(.realizedPnlUsd<=0))|length)} end'
```

### Pump-scanner sub-pipeline (optional, inside aggressive config)

The aggressive subsystem can run TWO evaluators in parallel that share the
SAME manage queue + ledger + daily-state (and therefore the one-position
invariant — only one trade open at a time across all aggressive sources):

1. **liquidation-hunter** (existing) — reads Bybit WS liquidation cascade
   events directly. Reactive: enters on confirmed cascade signals.
2. **pump-scanner** (new) — scans the entire liquid universe of linear perps,
   detects price/volume anomalies, and (optionally) sends the candidate to a
   Claude LLM that decides whether to enter and with what stop/TP.

#### Pipeline
```
[universe fetcher] → liquidity filter → active symbols
       ↓
[rolling-window store] ← ticker push every tick
       ↓
[pump-scanner: scanSymbol per symbol] → anomaly detected?
       ↓
[Claude analyzer] ← if llm.enabled (otherwise dry-run logs only)
       ↓
[guards: daily-cap, max-trades, capital-cap]
       ↓
[placeAggressiveEntry] → shared aggressive-manage queue
       ↓
[manage worker: stop / TP / max-hold every 2s]
```

#### Activating

Edit `config.aggressive.json`, set both `enabled: true` AND the sub-block:
```jsonc
"pumpScanner": {
  "enabled": true,
  "evaluateTickMs": 5000,
  "universeRefreshMs": 300000,
  "windowMs": 300000,
  "liquidity": { "min24hTurnoverUsd": 10000000, "maxSpreadBps": 5, "minBookDepthUsd": 0 },
  "anomaly": { "priceChangeBpsThreshold": 200, "volumeMultipleThreshold": 2.0, "minWindowVolumeUsd": 50000 },
  "llm": { "enabled": false, "minConfidence": 0.6, "model": "claude-haiku-4-5-20251001" },
  "sizing": { "maxNotionalUsdPerTrade": 50, "leverage": 10 },
  "symbolBlacklist": ["USDC", "DAI"]
}
```

**Strongly recommended**: leave `llm.enabled: false` for the first 24-72h so the
scanner runs in DRY-RUN. Check `/tmp/ai-scalper-paper.log` for
`pump-scanner-anomaly-detected` events to confirm the anomaly rate is
reasonable (5-20/day expected). Only then enable the LLM.

Requires `ANTHROPIC_API_KEY` in the systemd unit environment when LLM is on.

#### One-position invariant (important)

Both `liquidation-hunter` and `pump-scanner` check the SAME
`aggressive-manage` BullMQ queue before opening. If a trade is open, neither
will open another. Whichever evaluator triggers first wins the slot. This is
intentional risk management at high leverage; do not change without adding
correlation-aware portfolio sizing.

### Disable
Set `"enabled": false` in `config.aggressive.json` and restart, or remove
the file entirely. The conservative pipeline continues unchanged.

## LIVE trading — go-live runbook (calendar-spread only)

The `ai-scalper-live.service` runs the Phase-3 pipeline against the **real
Bybit mainnet wallet**, scoped narrowly:

- only `calendar-spread` (env `PIPELINE_STRATEGIES=calendar-spread`)
- aggressive subsystem disabled (`config.aggressive.live.json` `enabled:false`)
- dedicated **Redis DB 1** (paper stays on DB 0 — no ledger collision)
- own log file `/tmp/ai-scalper-live.log`
- runs **in parallel** with `ai-scalper-paper.service` for empirical
  paper→live erosion measurement

### One-time operator setup

1. **Generate Bybit API key** on the *mainnet* account, with:
   - `Read-Write` on Contract Trading
   - `Read` on Wallet
   - **NO** Withdraw permission
   - IP whitelist: this server's egress IP (`curl ifconfig.me`)

2. **Fund the wallet** with the agreed amount ($50 USDT in UNIFIED for phase 1).

3. **Set Cross Margin** on the unified account via Bybit UI (one-time global
   setting; `ensureCrossMargin` handles per-symbol toggles after that).

4. **Install env file** (secrets — NEVER commit):
   ```bash
   sudo mkdir -p /etc/ai-scalper
   sudo cp deploy/live.env.example /etc/ai-scalper/live.env
   sudo chmod 600 /etc/ai-scalper/live.env
   sudo chown root:root /etc/ai-scalper/live.env
   sudoedit /etc/ai-scalper/live.env   # paste real BYBIT_API_KEY/SECRET
   ```

5. **Install systemd unit**:
   ```bash
   sudo cp deploy/ai-scalper-live.service /etc/systemd/system/
   sudo systemctl daemon-reload
   ```

### Preflight (run BEFORE every fresh enable, ~5s)

```bash
cd /home/assistant/projects/ai-scalper/apps/worker
sudo -u assistant env $(grep -v '^#' /etc/ai-scalper/live.env | xargs) \
  bun run ../trader/src/scripts/live-preflight.ts
```

Validates: mainnet URL, paperTrading=false, API keys, wallet balance ≥ $30,
instrument info, calendar-rotator pick, cross-margin/leverage round-trip,
Redis reachability + DB isolation. Exit 0 = safe to start.

### Start / monitor / stop

```bash
sudo systemctl start ai-scalper-live      # first launch
sudo systemctl enable ai-scalper-live     # restart on boot
tail -f /tmp/ai-scalper-live.log | grep -E 'calendar|rotator|opened|exit'

# quick PnL view (separate ledger via DB 1)
redis-cli -n 1 LRANGE ai-scalper:trader:positions:closed 0 -1 \
  | jq -s '{trades:length, wins:(map(select(.realizedPnlUsd>0))|length), net:(map(.realizedPnlUsd)|add)}'

# emergency stop (does NOT close open positions — see below)
sudo systemctl stop ai-scalper-live
```

### Emergency: close positions manually

`systemctl stop` does NOT flatten positions. In an incident, close via Bybit
UI's "Close All" button (fastest + most reliable). API alternative:
```bash
sudo -u assistant env $(grep -v '^#' /etc/ai-scalper/live.env | xargs) \
  bun -e 'import("@ai-scalper/bybit-client").then(({createBybitClient})=>createBybitClient().getPosition({category:"linear",symbol:"BTCUSDT"})).then(r=>console.log(JSON.stringify(r,null,2)))'
```

### Comparing paper vs live (the whole point of parallel running)

```bash
redis-cli -n 0 LRANGE ai-scalper:trader:positions:closed 0 -1 \
  | jq -s 'map(select(.strategyType=="calendar-spread"))|{n:length,net:(map(.realizedPnlUsd)|add)}'
redis-cli -n 1 LRANGE ai-scalper:trader:positions:closed 0 -1 \
  | jq -s '{n:length,net:(map(.realizedPnlUsd)|add)}'
```

After 1-2 weeks parallel, the live/paper net ratio is the empirical erosion
of *our* code, not a textbook estimate.

## Troubleshooting

| Symptom | Check |
|---|---|
| `/health` → 503, reason `redis: down` | `docker compose ps redis` / `systemctl status redis` |
| `/health` → 503, reason `bybit: <err>` | Outbound HTTPS to Bybit blocked, or testnet maintenance |
| `/health` → 503, reason `anthropic: silent` | LLM strategy/advisor not running, or `ANTHROPIC_API_KEY` missing |
| `/health` → 503, reason `kline: stale` | Scanner worker not running (`bun run worker` / re-enqueue scan) |
| No trades opened | Check `apps/trader/data/scan-latest.json` is fresh and `tradeMinSetupScore` is achievable |
| Bull Board empty | Worker hasn't been enqueued yet — run `bun run enqueue:session` or `bun run enqueue:scan` |

## Upgrading

```bash
# manual / systemd
cd /opt/ai-scalper
git pull
bun install
sudo systemctl restart ai-scalper  # if systemd

# docker
git pull
docker compose up -d --build
```

Always smoke-test with `BYBIT_PAPER_TRADING=true` before flipping to live.
