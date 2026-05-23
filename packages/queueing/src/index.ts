export const QUEUE_NAMES = {
  marketScan: "market-scan",
  paperSession: "paper-session",
  liveSession: "live-session",
} as const;

export const JOB_NAMES = {
  marketScanRun: "market-scan.run",
  paperSessionStart: "paper-session.start",
  liveSessionStart: "live-session.start",
} as const;

export interface MarketScanJobData {
  requestedAt: string;
  trigger: "manual" | "cli" | "schedule";
}

export interface TraderSessionJobData {
  entryExecutionMode: "taker" | "maker-entry" | "maker-preferred-with-timeout";
  paperTrading: boolean;
  requestedAt: string;
  tradingProfile: "standard" | "aggressive-perps";
  trigger: "manual" | "cli" | "schedule";
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
