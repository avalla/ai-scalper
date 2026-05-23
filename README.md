# ai-scalper

Bun + TypeScript monorepo for building a Bybit API scalping system.

## Workspaces

- `apps/trader` - polling loop, signal evaluation, paper or live execution
- `packages/bybit-client` - minimal Bybit REST client, auth signing, order creation
- `packages/trading-core` - pure strategy and risk primitives

## Current behavior

- scans Bybit linear USDT perps and ranks the strongest live setups
- selects the top setup only when score, net edge, and directional trend are strong enough
- trades the selected setup with risk gates on cooldown, spread, position size, and daily loss
- executes in paper mode by default
- can send market orders when `BYBIT_PAPER_TRADING=false`
- supports `taker`, `maker-entry`, and `maker-preferred-with-timeout` entry policies

## Run

```bash
bun install
cp .env.example .env
bun run worker
```

In another terminal:

```bash
bun run start
```

One-command startup:

```bash
bun run up
```

`bun run up` starts the worker, waits for all queues to become ready, and then enqueues the trader session automatically.

Full one-command startup:

```bash
bun run all
```

`bun run all` starts:

- BullMQ worker + trader session bootstrap
- Bull Board

Bull Board:

```bash
bun run board
```

Open:

```text
http://localhost:3010/admin/queues
```

The board is configured in read-only mode and shows:

- `market-scan`
- `candidate-backtest`
- `paper-session`
- `live-session`

Entry execution mode:

- `ENTRY_EXECUTION_MODE=taker` - immediate market entry
- `ENTRY_EXECUTION_MODE=maker-entry` - post-only limit entry, no taker fallback
- `ENTRY_EXECUTION_MODE=maker-preferred-with-timeout` - post-only limit entry, then market fallback if not filled within `ENTRY_MAKER_TIMEOUT_MS`
- `ENTRY_MAKER_OFFSET_TICKS` shifts the maker quote away from the touch
- exits remain taker/reduce-only

Wallet auto-sizing:

- `AUTO_SIZE_FROM_WALLET=true` reads the Bybit wallet balance at startup
- `WALLET_ACCOUNT_TYPE=UNIFIED` selects the Bybit account type
- `WALLET_COIN=USDT` selects the balance coin to inspect
- `WALLET_FRACTION=1` uses 100% of the detected USD value for sizing
- `WALLET_MAX_ORDER_USD_CAP=75` caps the resolved order size
- if the wallet read fails, the trader falls back to `BYBIT_ORDER_USD`

Scanner-first trade gating:

- `TRADE_SCAN_REFRESH_MS=60000` refreshes the ranked market setups every 60 seconds
- `TRADE_MIN_SETUP_SCORE=45` is the minimum scanner score required before the trader can open a position
- `TRADE_MIN_SETUP_NET_EDGE_BPS=6` is the minimum scanner edge required before the trader can open a position
- `SCAN_SIGNAL_THRESHOLD_BPS=3` controls how much recent kline trend is needed for scanner direction (`long` or `short`)

## Aggressive perps mode

Set:

```bash
TRADING_PROFILE=aggressive-perps
```

Guardrails currently enforced in this mode:

- optional trade whitelist via `AGGRESSIVE_ALLOWED_SYMBOLS`
- optional scan-linked trade whitelist via `AGGRESSIVE_REQUIRE_SCAN_CANDIDATE=true`
- leverage cap via `AGGRESSIVE_MAX_LEVERAGE`
- funding cap via `AGGRESSIVE_MAX_FUNDING_RATE_BPS`
- estimated max loss per trade via `AGGRESSIVE_MAX_LOSS_PER_TRADE_USD`
- minimum estimated liquidation buffer via `AGGRESSIVE_MIN_ESTIMATED_LIQ_BUFFER_BPS`

When `AGGRESSIVE_REQUIRE_SCAN_CANDIDATE=true`, the trader will only execute symbols that are:

- in `AGGRESSIVE_ALLOWED_SYMBOLS`
- present in the recent scan artifact at `AGGRESSIVE_SCAN_CANDIDATES_PATH`
- or, as fallback, in `AGGRESSIVE_SCAN_LATEST_PATH`
- not older than `AGGRESSIVE_SCAN_MAX_AGE_MINUTES`

Scanner-first execution:

- the trader refreshes a live ranked setup list from the scanner
- while flat, it targets the top-ranked setup that is not in ticker cooldown
- when a position is open, it stays on that symbol until the position is closed
- `TRADE_CANDIDATE_SYMBOLS` acts as a manual override filter on top of the live scan
- symbols with repeated `ticker-unavailable` errors are cooled down using `TICKER_FAILURE_THRESHOLD` and `TICKER_FAILURE_COOLDOWN_TICKS`
- runtime state is persisted at `apps/trader/data/runtime/active-symbols.json`

Exceptional leverage path:

- enable with `EXCEPTIONAL_LEVERAGE_ENABLED=true`
- keeps base leverage by default
- promotes to `EXCEPTIONAL_LEVERAGE` only if spread, funding, hourly move, minute range, and net edge all pass strict gates

## Scan tradable pairs

```bash
bun run scan
```

The scanner ranks Bybit linear USDT pairs using a scalping heuristic based on:

- 24h turnover
- open interest value
- bid/ask spread
- 1h movement
- recent 1m candle range
- recent kline trend direction
- estimated round-trip cost
- leverage ceiling
- funding penalty

It uses `BYBIT_SCAN_BASE_URL` and defaults that to Bybit mainnet market data, even if trading remains pointed at testnet.

Each scan also persists:

- latest ranked scan at `apps/trader/data/scan-latest.json`
- timestamped scan snapshots at `apps/trader/data/scans/`
- top symbols queued for follow-up at `apps/trader/data/backtest-candidates.json`

## Queue-based workers

```bash
bun run worker
```

In another terminal:

```bash
bun run enqueue:scan
bun run enqueue:session
```

The worker uses BullMQ + Redis and runs:

- `market-scan`
- `candidate-backtest`
- `paper-session`
- `live-session`

`bun run start` now enqueues a trader session.

`bun run scan` now enqueues a market scan.

Automatic market scan scheduling:

- enabled by default inside the worker
- `SCAN_SCHEDULE_MINUTES=5` runs the scan every 5 minutes
- `SCAN_SCHEDULE_RUN_ON_START=true` enqueues one scan as soon as the worker is ready
- set `SCAN_SCHEDULE_ENABLED=false` to disable the automatic scheduler

Cleanup enabled:

- dedupe by time-windowed `candidate-backtest.run:<symbol>:<bucket>` job id
- priority buckets for `high-liquidity`, `high-volatility`, `standard`
- per-symbol queue artifact output under `apps/trader/data/backtests/queue/`
- timestamped history output under `apps/trader/data/backtests/history/`
- minimal candidate backtest proxy that decides `promote-to-real-backtest` or `hold`

## Notes

- default API base URL is Bybit testnet
- live execution requires `BYBIT_API_KEY` and `BYBIT_API_SECRET`
- order quantity is derived from `BYBIT_ORDER_USD / lastPrice`
