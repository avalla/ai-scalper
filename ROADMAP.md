# Strategy Roadmap

State of strategies in the bot. Each can be selected via `CONFIG_FILE=config.<name>.json bun run all`.

## Configuration philosophy (env-minimal)

ALL strategy / risk / execution parameters live in `apps/trader/config*.json`.
Env vars are reserved for:

- **Secrets** — `BYBIT_API_KEY`, `BYBIT_API_SECRET`, `ANTHROPIC_API_KEY`
- **Mode / network** — `BYBIT_PAPER_TRADING`, `BYBIT_BASE_URL`,
  `BYBIT_SCAN_BASE_URL`, `BYBIT_POSITION_MODE`, `CONFIG_FILE`
- **Infrastructure** — `REDIS_URL`, `BYBIT_RECV_WINDOW`,
  `BULL_BOARD_PORT`, `BULL_BOARD_BASE_PATH`,
  `SCAN_SCHEDULE_ENABLED`, `SCAN_SCHEDULE_MINUTES`,
  `SCAN_SCHEDULE_RUN_ON_START`
- **Debug / ad-hoc** — `TRADER_MAX_TICKS`, `TRADER_MODE`,
  `DRAWDOWN_HALT_COOLDOWN_MS`, `FORWARD_TRADER_STDOUT`,
  `QUIET_HEARTBEAT_TICKS`

If you need to change `BYBIT_LEVERAGE`, `STRATEGY_*`, `RISK_*`,
`AGGRESSIVE_*`, `META_*`, `LLM_MANAGED_*`, `*_USE_BULLMQ_JOBS`, etc.,
edit the JSON config — env overrides are gone.

## ✅ Shipped

| # | Name | Config | Edge | Status | Notes |
|---|---|---|---|---|---|
| 0 | `ma-crossover` | `config.json`, `config.aggressive.json` | momentum + scanner | ⚠️ Structurally losing on 1-min crypto (fees > gross profit) | Keep for reference / bandit experiments |
| 1 | `funding-arb` | `config.funding-arb.json` | funding payment harvesting | ✅ Ready for live | 3 trade/day, target 70-85% WR |
| 2 | `longer-tf` | `config.longer-tf.json` | 15m MA, fees become irrelevant | ✅ Ready for live | 1-3 trade/day |
| 3 | `basis-arb` | `config.basis-arb.json` | spot-perp basis convergence | ✅ Ready for live, **v1** | See risks below before scaling notional |
| 4 | `pairs-trading` | `config.pairs-trading.json` | BTC-ETH cointegration mean reversion | ✅ Ready for live | z-score gating, dollar-neutral two-leg |
| 5 | `bollinger-adx` | `config.bollinger-adx.json` | regime-adaptive (range vs trend) | ✅ Ready for live | single-leg, 15m bars |
| 6 | `calendar-spread` | `config.calendar-spread.json` | perp ↔ dated quarterly convergence | ✅ Ready for live, **v1** | Operator must populate `calendarSpread.datedSymbol` + `datedDeliveryAt` (Unix ms) from Bybit's listed quarterlies. Two-leg with same naked-exposure guard as basis-arb. |
| 7 | LLM strategy advisor | any config + `ANTHROPIC_API_KEY` | meta — recommends which of the 6 strategies to run | ✅ Advisory-only **v1** | Opt-in via `ANTHROPIC_API_KEY`. Runs every `ADVISOR_INTERVAL_MINUTES` (default 30) as a separate process spawned by `start-stack`. Writes `apps/trader/data/runtime/strategy-advisor.json` + posts to `alertWebhookUrl`. Does NOT auto-switch the trader's strategy — operator decides. Prompt caching keeps cost ~$0.05-0.50/day. |
| 8 | LLM order supervisor | low-freq strategy config + `ANTHROPIC_API_KEY` + `ORDER_SUPERVISOR_ENABLED=true` | meta — pre-entry approval for funding-arb / basis-arb / pairs-trading / calendar-spread | ✅ **v1** | Opt-in. Calls Haiku before each ENTRY in supervised strategies (max ~8s blocking). Rejects entry if LLM disapproves OR confidence < `ORDER_SUPERVISOR_MIN_CONFIDENCE` (default 0.5). Exits/holds NOT supervised — deterministic. Fast strategies (`ma-crossover`, `longer-tf`, `bollinger-adx`) NOT supervised — latency would kill the setup. Safe-reject default on any failure (no key, timeout, SDK error). Cost ~$0.005-0.05/trade with prompt caching → ~$0.02-1.00/day. |
| 9 | `llm-managed` | `config.llm-managed.json` + `ANTHROPIC_API_KEY` | fully autonomous LLM entry + active management | ✅ **v1** | Claude (Haiku 4.5) decides entry (`open` / `skip` every `openReviewIntervalSec`, default 10 min) AND active management every `manageReviewIntervalSec` (default 3 min): `hold`, `tp-partial`, `tp-full`, `cut-loss`, `open-hedge`, `close-hedge`, `scale-in`, `scale-out`. **Hardcoded safety rules bypass the LLM entirely**: (1) hard SL when PnL ≤ -`llmManagedMaxAbsoluteLossUsd` (default 20 USD) → forced `cut-loss`; (2) per-position max-loss breach → forced `cut-loss`; (3) `minutesHeld > llmManagedMaxHoldHours * 60` (default 24 h) → forced `tp-full`. Wallet / leverage / notional / hedge caps are clamped AFTER the LLM response. Symbol whitelist enforced — LLM-hallucinated symbols are rejected. 30-min cooldown after `cut-loss` before next OPEN decision. One position at a time in v1. Cost (Haiku 4.5 + prompt caching): ~$0.05–0.20 per call; worst-case at default intervals with an always-open position ≈ 30–40 calls/day → **$1.50–8/day**. |

---

## 🆕 Trade-as-BullMQ-Job migration (Phase 1 PoC — shipped behind flag)

`llm-managed` is the PoC for a structural shift: each trade is a persisted
BullMQ job in Redis rather than mutable state in the trader subprocess.
Benefits:

- Bot crash → BullMQ restarts the job from its persisted snapshot — no
  orphan positions.
- Each manage tick is a discrete worker invocation — no long-lived state
  in trader memory.
- Bull Board shows every live position (operator visibility).
- 1-position-at-a-time enforced by querying the trade-management queue's
  active/waiting/delayed counts (no dual-write hazards).
- Cooldown after `cut-loss` lives in a Redis key — survives restart.

### What ships in Phase 1

- New queue names + job-data types in `@ai-scalper/queueing`:
  `llm-managed:open-decision`, `llm-managed:trade-management`,
  `LlmManagedOpenTickJobData`, `LlmManagedManageJobData`,
  `LLM_MANAGED_JOB_POLICY` (attempts:1).
- Shared Redis state helper
  (`apps/trader/src/strategies/llm-managed-redis.ts`) for cross-process
  cooldown + active-position counting.
- Pure-and-DI'd processors in the trader package:
  `llm-managed-open-processor.ts` + `llm-managed-manage-processor.ts`.
- BullMQ Worker wiring (`apps/worker/src/llm-managed-workers.ts`) +
  recurring open-tick upsert + Bull Board registration.
- Config flag `runtime.useBullmqJobs` (default **false**). When true and
  the active strategy is `llm-managed`, the in-process
  `runLlmManagedTick` loop becomes a no-op (the trader subprocess just
  idles until the session job exits — trades are owned by the workers).

> **Config simplification (2026-05):** the 8 previously-separate
> `<strategy>UseBullmqJobs` JSON fields and their `*_USE_BULLMQ_JOBS`
> env counterparts have been consolidated into a single
> `runtime.useBullmqJobs` boolean. Only the strategy named in
> `strategy.type` is gated by this flag; the 7 inactive strategies are
> dormant anyway. Env override has been REMOVED — set it in JSON.

### Phase 2 — ✅ shipped (behind a single consolidated flag, default OFF)

All 7 remaining strategies now have a BullMQ trade-as-job pipeline that
mirrors the Phase 1 llm-managed PoC: one recurring `open-decision` job and
one `trade-management` job per live position, each completing when the
position closes (tp / sl / convergence / external-close).

Single flag → enable the BullMQ stack for the active strategy (legacy
in-process loop becomes a no-op when the flag is true; behavior is
byte-identical when false):

```json
{
  "runtime": { "useBullmqJobs": true },
  "strategy": { "type": "funding-arb" }
}
```

| Strategy | Queues |
|---|---|
| funding-arb | `funding-arb:open-decision` + `funding-arb:trade-management` |
| longer-tf | `longer-tf:open-decision` + `longer-tf:trade-management` |
| bollinger-adx | `bollinger-adx:open-decision` + `bollinger-adx:trade-management` |
| basis-arb | `basis-arb:open-decision` + `basis-arb:trade-management` |
| pairs-trading | `pairs-trading:open-decision` + `pairs-trading:trade-management` |
| calendar-spread | `calendar-spread:open-decision` + `calendar-spread:trade-management` |
| ma-crossover | `ma-crossover:open-decision` + `ma-crossover:trade-management` |

Shared Phase 2 infrastructure:

- `apps/trader/src/strategies/shared/bullmq-shared-state.ts` — generic
  `createStrategySharedState({ strategy, redis, manageQueue })` that
  namespaces cooldown/last-trade-at Redis keys per strategy. The Phase 1
  `createLlmManagedSharedState` is now a thin wrapper over this factory
  and preserves its original `ai-scalper:llm-managed:last-cut-loss-at`
  key for backward compat.
- `apps/trader/src/strategies/shared/trade-job-helpers.ts` —
  `makePositionId`, `makeOpenTickJobId`, `appendDecisionHistory`,
  `floorQtyToStep`, `computeQtyFromNotional`, `safeRemoveRepeatable`.
- `apps/trader/src/strategies/shared/allocator-redis.ts` — Redis-backed
  `AllocatorStore` used by the ma-crossover bandit so allocator state
  survives bot restarts (legacy filesystem `persistAllocatorState`
  remains the canonical path while the flag is false).

Two-leg semantics (basis-arb, pairs-trading, calendar-spread):

- Position state on the manage job carries BOTH legs (entry prices, qtys,
  sides). Manage reconciles both legs; close emits reduce-only on both
  legs sequentially.
- If leg2 placement fails on `open` → leg1 is compensated reduce-only and
  NO manage job is enqueued (no exposure tracked).
- If leg2 close fails on `manage` → job stays alive with a
  `close-attempt-failed` decision-history entry; next tick retries.

ma-crossover specifics (the trickiest of the 7):

- Open-processor calls the existing pure `selectChampion` against the
  Redis-loaded `AllocatorState`, persists the advanced round-robin
  cursor, and tags the manage job with both `championIdAtEntry` AND a
  snapshot of the champion's params (so SL/TP at exit always matches
  what was active at entry, even if the bandit rotates mid-position).
- Manage-processor calls `recordClosedTrade(allocator, championId, pnl)`
  on close and saves the new allocator state back to Redis — bandit
  attribution survives the trade lifecycle.
- **Scope-down vs. spec**: the per-variant `step()` shadow execution
  (paper-mode performance attribution across ALL variants every tick)
  has NOT moved into the open-processor. In Phase 2 BullMQ mode the
  bandit learns only from the champion's actual trades. The legacy
  in-process loop keeps doing full shadow execution when the flag is
  false. This is the safe path; moving shadow execution into the
  recurring open-tick was deemed out-of-budget for Phase 2.
- Multi-symbol rotation / scanner-driven symbol selection is simplified
  in the open-processor (uses `config.symbol`). The legacy in-process
  loop's scanner gating remains canonical until Phase 3.

Test delta: 263 baseline → 319 (+56 new). Typecheck green.

### Phase 3 (deferred)

- Move ma-crossover shadow execution (per-variant `step()`) into the
  BullMQ open-tick so the bandit can attribute paper performance across
  ALL variants in BullMQ mode (not just the champion's actual trades).
- Drop the in-process legacy paths from `run-trader.ts` once the BullMQ
  flags have been live for ≥1 month with no regressions.
- Scanner-driven symbol rotation inside the ma-crossover open-processor
  (currently delegated to legacy loop).

---

## 🚧 Next on roadmap

### #2 — Pairs trading BTC-ETH (medium priority)

Cointegrated pair mean reversion. Track rolling z-score of `log(ETH_price / BTC_price)`. When |z| > 2σ, open the divergence: short the rich one + long the cheap one. Close when z → 0.

**Why**: Decorrelated edge from funding/basis. Statistical (not structural), but well-documented on BTC-ETH with ~0.85-0.90 correlation.

**Effort**: ~3h. Needs:
- 2 ticker fetches per tick (BTCUSDT + ETHUSDT)
- Rolling window of (BTC_close, ETH_close) for N samples (~200, ~3h on 1m or ~50d on 1h)
- Z-score computation: `(spread - mean) / stddev` where `spread = log(ETH) - β·log(BTC)` (β from rolling regression)
- Two-leg execution similar to basis-arb but on different symbols (linear perp both)
- Position state: `PairsPosition { btcSide, btcQty, ethSide, ethQty, entryZ }`

**Files to create**:
- `apps/trader/src/strategies/pairs-trading.ts` + test
- `apps/trader/config.pairs-trading.json`
- Extend `strategyType` union with `"pairs-trading"`

**Risk**: dollar-neutral via hedge ratio β; needs careful rebalancing if β changes.

---

### #3 — Calendar spread — ✅ shipped (see Shipped table row 6).

Follow-ups (deferred):
- Auto-discovery of available dated quarterlies via `instruments-info` (`contractType: "LinearFutures"`, non-zero `deliveryTime`). v1 takes the dated symbol from config.
- Multi-quarter ladder (run several settlement legs concurrently).

---

### Auto-switch advisor (deferred follow-up to #7)

The LLM advisor in v1 is advisory-only. Future: hot-swap the trader's `strategyType` when recommendation confidence > threshold (e.g. 0.8) AND the regime has been stable for N consecutive recommendations. Requires:
- An IPC channel from the advisor process to the trader process (Redis pub-sub or signal-driven config reload).
- A safety interlock: never swap mid-position; wait for flat state.
- Operator override / kill-switch.

---

### #4 — Bollinger + ADX regime filter

Adaptive: when ADX < 20 (range market) use Bollinger reversion; when ADX > 25 (trending) use breakout. Single-symbol, single-leg.

**Why**: Edge from regime detection. Most trading strategies fail because they assume one regime.

**Effort**: ~2h. Needs:
- ADX indicator on klines (14-period typical)
- Bollinger bands (20-period, 2 stddev) on klines
- Mode selection per tick based on ADX
- Reversion: enter when price touches BB band, exit on midline
- Breakout: enter on BB upper/lower break, ATR-trailing stop

**Files to create**:
- `apps/trader/src/strategies/bollinger-adx.ts` + test
- `apps/trader/src/indicators/adx.ts` (pure)
- `apps/trader/src/indicators/bollinger.ts` (pure)
- `apps/trader/config.bollinger-adx.json`

**Risk**: still trend-following at heart. Higher trade frequency than calendar/pairs — fees matter more.

---

### #5 — Liquidation cascade rebound (high frequency, more complex)

Bybit exposes recent trades; large `isLiquidation` true trades indicate cascading SL hits. After N liquidations in a direction within W seconds, enter opposite for the rebound.

**Why**: Microstructure edge. Cascading liquidations create overshoots.

**Effort**: ~5h. Needs:
- WebSocket subscription to `publicTrade.<symbol>` (or REST polling of `/v5/market/recent-trade` with limit=1000)
- Liquidation classification (Bybit marks them with `isMaker: false` and large size + specific tick rule)
- Cluster detection: N liquidations in W seconds in same direction
- Entry sizing based on cluster magnitude
- Exit: time-based (5-15s) or magnitude-based (when price retraces N% of cluster move)

**Files to create**:
- `apps/trader/src/strategies/liquidation-cascade.ts` + test
- WebSocket client extension to bybit-client
- `apps/trader/config.liquidation-cascade.json`

**Risk**: highest infrastructure cost of the roadmap (needs WS). Lower probability of edge after Bybit's MM bots front-run obvious cascades.

---

## 🛡️ Cross-cutting hardening (any time)

These improve safety for ALL strategies:

- [ ] **Position reconciliation on startup**: at boot, query Bybit position/list, compare with persisted snapshot, flag drift. Already exists for ma-crossover during runtime; needs to run at startup too.
- [ ] **Basis-arb naked-exposure**: harden the compensating-order path with retry+backoff. Add an in-memory "leg-open watcher" that polls Bybit for 60s after a failed compensation.
- [ ] **Funding payment ground-truth**: replace the approximate funding accrual in basis-arb with `client.getFundingHistory(symbol)` actual data.
- [ ] **Daily PnL report email/webhook**: every 24h, push `bun run report` output to alertWebhookUrl. Operator gets a daily summary.
- [ ] **Multi-strategy concurrent**: today one strategy per process. Future: spawn one trader subprocess per strategy in start-stack.ts.
- [ ] **WebSocket ticker feed**: replaces REST polling for ma-crossover/longer-tf. Sub-100ms latency, no rate-limit. Big undertaking but unlocks #5 + lower scalping cost.
- [ ] **Backtest harness**: replay historical klines through `step()` to validate strategy params before live. Currently we're tuning in production.

---

## How to choose what to ship next

When you have data from 1-2 weeks of live runs:

1. Look at `bun run report` for the strategy that ran most → identify weakness.
2. If funding-arb / basis-arb show consistent net positive → safe to scale notional, then **#2 pairs-trading** to diversify.
3. If neither converges → don't scale up, instead **#4 bollinger-adx** for regime adaptivity.
4. If you have >$5k and want lower-frequency / set-and-forget → **#3 calendar-spread**.
5. WebSocket + #5 only after the simpler strategies prove the infra is solid.

## How to launch each shipped strategy

```bash
# market-neutral, low risk, low frequency
CONFIG_FILE=config.funding-arb.json bun run all

# medium-term trend on 15m klines
CONFIG_FILE=config.longer-tf.json bun run all

# spot-perp basis convergence (NEW — v1, monitor naked-exposure risk)
CONFIG_FILE=config.basis-arb.json bun run all

# original scalping (kept for reference — expect net negative due to fees)
CONFIG_FILE=config.aggressive.json bun run all

# any low-freq strategy + LLM pre-entry order supervisor (Haiku)
ANTHROPIC_API_KEY=sk-ant-... \
  ORDER_SUPERVISOR_ENABLED=true \
  CONFIG_FILE=config.funding-arb.json bun run all
```

For all of them, monitor with:

```bash
bun run report
```
