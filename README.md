# ai-scalper

Bun + TypeScript monorepo for building a Bybit API scalping system.

## Workspaces

- `apps/trader` - polling loop, signal evaluation, paper or live execution
- `packages/bybit-client` - minimal Bybit REST client, auth signing, order creation
- `packages/trading-core` - pure strategy and risk primitives

## Current behavior

- polls Bybit ticker data
- builds a moving-average crossover signal
- blocks trades on cooldown, spread, position size, and daily loss
- executes in paper mode by default
- can send market orders when `BYBIT_PAPER_TRADING=false`
- supports `taker`, `maker-entry`, and `maker-preferred-with-timeout` entry policies

## Run

```bash
bun install
cp .env.example .env
bun run start
```

Entry execution mode:

- `ENTRY_EXECUTION_MODE=taker` - immediate market entry
- `ENTRY_EXECUTION_MODE=maker-entry` - post-only limit entry, no taker fallback
- `ENTRY_EXECUTION_MODE=maker-preferred-with-timeout` - post-only limit entry, then market fallback if not filled within `ENTRY_MAKER_TIMEOUT_MS`
- `ENTRY_MAKER_OFFSET_TICKS` shifts the maker quote away from the touch
- exits remain taker/reduce-only

## Aggressive perps mode

Set:

```bash
TRADING_PROFILE=aggressive-perps
```

Guardrails currently enforced in this mode:

- symbol whitelist via `AGGRESSIVE_ALLOWED_SYMBOLS`
- optional scan-linked whitelist via `AGGRESSIVE_REQUIRE_SCAN_CANDIDATE=true`
- leverage cap via `AGGRESSIVE_MAX_LEVERAGE`
- funding cap via `AGGRESSIVE_MAX_FUNDING_RATE_BPS`
- estimated max loss per trade via `AGGRESSIVE_MAX_LOSS_PER_TRADE_USD`
- minimum estimated liquidation buffer via `AGGRESSIVE_MIN_ESTIMATED_LIQ_BUFFER_BPS`

When `AGGRESSIVE_REQUIRE_SCAN_CANDIDATE=true`, the bot will only trade symbols that are:

- in `AGGRESSIVE_ALLOWED_SYMBOLS`
- present in the recent scan artifact at `AGGRESSIVE_SCAN_CANDIDATES_PATH`
- or, as fallback, in `AGGRESSIVE_SCAN_LATEST_PATH`
- not older than `AGGRESSIVE_SCAN_MAX_AGE_MINUTES`

Multi-symbol rotation:

- set `TRADE_CANDIDATE_SYMBOLS=ETHUSDT,SOLUSDT,BTCUSDT`
- when flat, the runtime rotates until every candidate has recent metrics
- once all candidates have been observed, the runtime prefers the strongest symbol by recent edge, spread, funding, and hourly move
- when a position is open, the runtime stays on that symbol until the position is closed
- if `TRADE_CANDIDATE_SYMBOLS` is empty, it falls back to recent scan candidates before `BYBIT_SYMBOL`
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
- estimated round-trip cost
- leverage ceiling
- funding penalty

It uses `BYBIT_SCAN_BASE_URL` and defaults that to Bybit mainnet market data, even if trading remains pointed at testnet.

Each scan also persists:

- latest ranked scan at `apps/trader/data/scan-latest.json`
- timestamped scan snapshots at `apps/trader/data/scans/`
- top symbols queued for follow-up at `apps/trader/data/backtest-candidates.json`

## Queue-based scan worker

```bash
bun run worker
```

In another terminal:

```bash
bun run enqueue:scan
```

The worker uses BullMQ + Redis and runs the same market scan pipeline through the `market-scan` queue.

It also fans out a separate `candidate-backtest` queue for the filtered top symbols.

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
