import { Queue, Worker } from "bullmq";
import { scanMarket, readScanConfig } from "@ai-scalper/market-scanner";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  DEFAULT_JOB_POLICY,
  JOB_NAMES,
  QUEUE_NAMES,
  type CandidateBacktestJobData,
  type MarketScanJobData,
} from "@ai-scalper/queueing";
import { createRedisConnection } from "./redis";

const scanJobTimeoutMs = Number(process.env.SCAN_JOB_TIMEOUT_MS || "30000");
const candidateBacktestJobTimeoutMs = Number(process.env.CANDIDATE_BACKTEST_JOB_TIMEOUT_MS || "15000");
const candidateBacktestHighLiquidityPriority = Number(process.env.CANDIDATE_BACKTEST_HIGH_LIQUIDITY_PRIORITY || "1");
const candidateBacktestHighVolatilityPriority = Number(process.env.CANDIDATE_BACKTEST_HIGH_VOLATILITY_PRIORITY || "2");
const candidateBacktestStandardPriority = Number(process.env.CANDIDATE_BACKTEST_STANDARD_PRIORITY || "3");
const candidateBacktestDedupeWindowMinutes = Number(process.env.CANDIDATE_BACKTEST_DEDUPE_WINDOW_MINUTES || "30");
const connection = createRedisConnection();
const queue = new Queue<MarketScanJobData>(QUEUE_NAMES.marketScan, {
  connection,
  defaultJobOptions: DEFAULT_JOB_POLICY,
});
const candidateBacktestQueue = new Queue<CandidateBacktestJobData>(QUEUE_NAMES.candidateBacktest, {
  connection,
  defaultJobOptions: DEFAULT_JOB_POLICY,
});

async function runWithTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: Timer | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([task, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function resolveScanOutputDir(scanOutputDir: string): string {
  if (isAbsolute(scanOutputDir)) {
    return scanOutputDir;
  }

  const cwd = process.cwd();
  if (cwd.endsWith("/apps/trader") || cwd.endsWith("/apps/worker")) {
    return join(cwd, "..", "..", scanOutputDir);
  }

  return join(cwd, scanOutputDir);
}

function priorityForCandidate(candidate: {
  priorityBucket: CandidateBacktestJobData["priorityBucket"];
}): number {
  if (candidate.priorityBucket === "high-liquidity") {
    return candidateBacktestHighLiquidityPriority;
  }
  if (candidate.priorityBucket === "high-volatility") {
    return candidateBacktestHighVolatilityPriority;
  }
  return candidateBacktestStandardPriority;
}

function candidateBacktestJobId(symbol: string): string {
  const dedupeBucket = Math.floor(Date.now() / (candidateBacktestDedupeWindowMinutes * 60_000));
  return `${JOB_NAMES.candidateBacktestRun}:${symbol}:${dedupeBucket}`;
}

async function persistCandidateBacktestArtifact(payload: {
  jobId: string | undefined;
  result: Record<string, unknown>;
}): Promise<{ latestPath: string; historyPath: string }> {
  const outputDir = resolveScanOutputDir(process.env.SCAN_OUTPUT_DIR || "apps/trader/data");
  const latestDir = join(outputDir, "backtests", "queue");
  const historyDir = join(outputDir, "backtests", "history");
  await mkdir(latestDir, { recursive: true });
  await mkdir(historyDir, { recursive: true });

  const generatedAt = new Date().toISOString();
  const latestPath = join(latestDir, `${String(payload.result.symbol)}.json`);
  const historyPath = join(
    historyDir,
    `${String(payload.result.symbol)}-${generatedAt.replaceAll(":", "-")}.json`,
  );
  const body = `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    jobId: payload.jobId ?? null,
    ...payload.result,
  }, null, 2)}\n`;
  await Bun.write(latestPath, body);
  await Bun.write(historyPath, body);

  return {
    latestPath,
    historyPath,
  };
}

function buildBacktestProxyResult(job: CandidateBacktestJobData): {
  requestedAt: string;
  requestedByJobId: string | null;
  symbol: string;
  score: number;
  netEdgeBps: number;
  turnover24h: number;
  minuteRangeBps: number;
  priorityBucket: CandidateBacktestJobData["priorityBucket"];
  status: "candidate-passed" | "candidate-rejected";
  decision: "promote-to-real-backtest" | "hold";
  checks: {
    liquidity: "pass" | "fail";
    microEdge: "pass" | "fail";
    microVolatility: "pass" | "fail";
  };
} {
  const liquidityPass = job.turnover24h >= 25_000_000;
  const microEdgePass = job.netEdgeBps >= 8;
  const microVolatilityPass = job.minuteRangeBps >= 18;
  const passed = liquidityPass && microEdgePass && microVolatilityPass;

  return {
    requestedAt: job.requestedAt,
    requestedByJobId: job.requestedByJobId,
    symbol: job.symbol,
    score: job.score,
    netEdgeBps: job.netEdgeBps,
    turnover24h: job.turnover24h,
    minuteRangeBps: job.minuteRangeBps,
    priorityBucket: job.priorityBucket,
    status: passed ? "candidate-passed" : "candidate-rejected",
    decision: passed ? "promote-to-real-backtest" : "hold",
    checks: {
      liquidity: liquidityPass ? "pass" : "fail",
      microEdge: microEdgePass ? "pass" : "fail",
      microVolatility: microVolatilityPass ? "pass" : "fail",
    },
  };
}

const worker = new Worker<MarketScanJobData>(
  QUEUE_NAMES.marketScan,
  async (job) => {
    if (job.name !== JOB_NAMES.marketScanRun) {
      throw new Error(`Unsupported job name: ${job.name}`);
    }

    const result = await runWithTimeout(
      scanMarket(readScanConfig()),
      scanJobTimeoutMs,
      JOB_NAMES.marketScanRun,
    );
    await Promise.all(result.candidates.map((candidate) => {
      const priorityBucket: CandidateBacktestJobData["priorityBucket"] = candidate.turnover24h >= 100_000_000
        ? "high-liquidity"
        : candidate.minuteRangeBps >= 40
          ? "high-volatility"
          : "standard";

      return candidateBacktestQueue.add(
        JOB_NAMES.candidateBacktestRun,
        {
          requestedAt: new Date().toISOString(),
          requestedByJobId: job.id ?? null,
          symbol: candidate.symbol,
          score: candidate.score,
          netEdgeBps: candidate.netEdgeBps,
          turnover24h: candidate.turnover24h,
          minuteRangeBps: candidate.minuteRangeBps,
          priorityBucket,
        },
        {
          ...DEFAULT_JOB_POLICY,
          jobId: candidateBacktestJobId(candidate.symbol),
          priority: priorityForCandidate({ priorityBucket }),
        },
      );
    }));

    console.log(JSON.stringify({
      worker: QUEUE_NAMES.marketScan,
      jobId: job.id,
      requestedAt: job.data.requestedAt,
      trigger: job.data.trigger,
      result,
    }, null, 2));

    return result;
  },
  {
    connection,
    concurrency: 1,
  },
);

const candidateBacktestWorker = new Worker<CandidateBacktestJobData>(
  QUEUE_NAMES.candidateBacktest,
  async (job) => {
    if (job.name !== JOB_NAMES.candidateBacktestRun) {
      throw new Error(`Unsupported job name: ${job.name}`);
    }

    const result = await runWithTimeout(
      Promise.resolve(buildBacktestProxyResult(job.data)),
      candidateBacktestJobTimeoutMs,
      JOB_NAMES.candidateBacktestRun,
    );
    const artifactPaths = await persistCandidateBacktestArtifact({
      jobId: job.id,
      result,
    });

    console.log(JSON.stringify({
      worker: QUEUE_NAMES.candidateBacktest,
      jobId: job.id,
      artifactPaths,
      result,
    }, null, 2));

    return {
      ...result,
      artifactPaths,
    };
  },
  {
    connection,
    concurrency: 1,
  },
);

worker.on("failed", (job, error) => {
  console.error(JSON.stringify({
    worker: QUEUE_NAMES.marketScan,
    jobId: job?.id ?? null,
    status: "failed",
    error: error.message,
  }, null, 2));
});

worker.on("completed", (job) => {
  console.log(JSON.stringify({
    worker: QUEUE_NAMES.marketScan,
    jobId: job.id,
    status: "completed",
  }, null, 2));
});

candidateBacktestWorker.on("failed", (job, error) => {
  console.error(JSON.stringify({
    worker: QUEUE_NAMES.candidateBacktest,
    jobId: job?.id ?? null,
    status: "failed",
    error: error.message,
  }, null, 2));
});

candidateBacktestWorker.on("completed", (job) => {
  console.log(JSON.stringify({
    worker: QUEUE_NAMES.candidateBacktest,
    jobId: job.id,
    status: "completed",
  }, null, 2));
});

async function main(): Promise<void> {
  await queue.waitUntilReady();
  await candidateBacktestQueue.waitUntilReady();
  await worker.waitUntilReady();
  await candidateBacktestWorker.waitUntilReady();

  console.log(JSON.stringify({
    worker: QUEUE_NAMES.marketScan,
    status: "ready",
  }, null, 2));
  console.log(JSON.stringify({
    worker: QUEUE_NAMES.candidateBacktest,
    status: "ready",
  }, null, 2));
}

await main();
