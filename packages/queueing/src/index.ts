export const QUEUE_NAMES = {
  marketScan: "market-scan",
  candidateBacktest: "candidate-backtest",
} as const;

export const JOB_NAMES = {
  marketScanRun: "market-scan.run",
  candidateBacktestRun: "candidate-backtest.run",
} as const;

export interface MarketScanJobData {
  requestedAt: string;
  trigger: "manual" | "cli" | "schedule";
}

export interface CandidateBacktestJobData {
  requestedAt: string;
  requestedByJobId: string | null;
  symbol: string;
  score: number;
  netEdgeBps: number;
  turnover24h: number;
  minuteRangeBps: number;
  priorityBucket: "high-liquidity" | "high-volatility" | "standard";
}

export const DEFAULT_JOB_POLICY = {
  attempts: 3,
  removeOnComplete: 20,
  removeOnFail: 50,
  backoff: {
    type: "exponential" as const,
    delay: 1_000,
  },
};
