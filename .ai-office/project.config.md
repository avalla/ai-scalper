agency: crypto-scalping-studio
project_name: ai-scalper

# Tech stack — used by $office-validate (dev stage)
typecheck_cmd: "bun run typecheck"
lint_cmd: "bun run lint"
test_cmd: "bun run test"
test_runner: bun test

# Design system — used by $office-review (UX sector)
ui_framework: ""
design_system: ""

# Quality thresholds — override agency defaults
coverage_min: 80
lighthouse_min: 90

# Pipeline behaviour — manual | auto
advance_mode: manual
pre_implementation_mode: minimal
interactive_choices_mode: text

# Task completion verification — optional ordered commands
completion_check_cmd_1: ""
completion_check_cmd_2: ""
completion_check_cmd_3: ""

# Git task workflow — opt-in branch/worktree isolation
task_isolation_mode: none
task_base_branch: "dev"
task_merge_target: "dev"
task_worktree_root: ".ai-office/worktrees"


# Optional: skip pipeline stages for this project
# skip_stages: []
---

# Project Configuration

**Project:** ai-scalper
**Agency:** crypto-scalping-studio
**Created:** 2026-03-31

## Notes

- Objective: build a crypto scalping system intended to generate positive risk-adjusted returns from short-horizon trades on supported exchanges.
- Domain: exchange-integrated crypto scalping bot with paper trading by default and optional live execution once strategy evidence is strong enough.
- Runtime: Bun + TypeScript monorepo with `apps/trader` orchestration and shared packages for exchange access and trading logic.
- Primary AI Office flow: use the crypto-scalping pipeline for new profit-seeking strategy work - signal brief, risk parameters, signal design, implementation, backtest, review, paper trade, deploy, monitor.
- Profitability must be treated as a measured outcome, not an assumption; strategy changes need evidence from backtests, forward tests, and paper trading before live rollout.
- Exchange support should remain modular so the project can expand beyond Bybit without rewriting core strategy and risk logic.
- For small code-only fixes with no strategy or risk impact, fast-track directly to implementation, QA, and review.
- Risk-sensitive changes must document drawdown limits, position sizing, cooldowns, spread protection, slippage assumptions, fee impact, and live-trading guardrails before release.
- Validation evidence should include `bun run typecheck`, `bun run lint`, and `bun run test`, plus strategy-specific proof such as backtest, fee-adjusted expectancy, and paper-trade results when trading behavior changes.
- Secrets and live-trading credentials must stay out of git; use `.env` locally and keep `.env.example` as the contract.
