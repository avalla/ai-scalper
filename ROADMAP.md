# Strategy Roadmap

State of strategies in the bot. Each can be selected via `CONFIG_FILE=config.<name>.json bun run all`.

## ✅ Shipped

| # | Name | Config | Edge | Status | Notes |
|---|---|---|---|---|---|
| 0 | `ma-crossover` | `config.json`, `config.aggressive.json` | momentum + scanner | ⚠️ Structurally losing on 1-min crypto (fees > gross profit) | Keep for reference / bandit experiments |
| 1 | `funding-arb` | `config.funding-arb.json` | funding payment harvesting | ✅ Ready for live | 3 trade/day, target 70-85% WR |
| 2 | `longer-tf` | `config.longer-tf.json` | 15m MA, fees become irrelevant | ✅ Ready for live | 1-3 trade/day |
| 3 | `basis-arb` | `config.basis-arb.json` | spot-perp basis convergence | ✅ Ready for live, **v1** | See risks below before scaling notional |

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

### #3 — Calendar spread (perp vs dated quarterly futures)

Bybit lists dated quarterly contracts (e.g. `BTC-25SEP25`). They trade at different prices than the perp. The spread converges at settlement.

**Why**: Pure convergence trade, structurally similar to basis-arb but on longer horizon (weeks → months). Higher capital efficiency (no funding rate noise).

**Effort**: ~4h. Needs:
- Discovery of which dated contracts exist on Bybit (instruments-info endpoint with `delivery` filter)
- Two-leg execution: long quarterly + short perp (or vice versa)
- Settlement-aware exit: close ~24h before quarterly settlement
- Margin model: cross-margin between perp + quarterly

**Files to create**:
- `apps/trader/src/strategies/calendar-spread.ts` + test
- `apps/trader/config.calendar-spread.json`

**Risk**: lower frequency (1 trade per quarter ideal). Capital locked for weeks. Best for larger wallet.

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
```

For all of them, monitor with:

```bash
bun run report
```
