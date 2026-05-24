# Deploy runbook

Three supported paths: manual (tmux), systemd, docker-compose. Pick one.

## Prerequisites

- Linux host (x86_64; arm64 also works with `oven/bun:1` images)
- Bun >= 1.3.6 (manual / systemd) — `curl -fsSL https://bun.sh/install | bash`
- Redis >= 7 (any deploy)
- Outbound HTTPS to `api.bybit.com` / `api-testnet.bybit.com` and `api.anthropic.com`

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

## Monitoring

- **Bull Board** — `http://localhost:3010/admin/queues` — live queue state for every BullMQ worker.
- **/health** — `http://localhost:3010/health` — JSON snapshot; HTTP 200 = healthy, 503 = degraded. Use for k8s/uptime probes.
- **Logs** — pino JSON lines on stdout. `bun run report` prints aggregated PnL + costs.
- **Alerts** — when `ALERT_WEBHOOK_URL` is set, two consecutive `/health` failures POST a payload to the webhook.

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
