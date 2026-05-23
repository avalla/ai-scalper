import { Queue, Worker } from "bullmq";
import { scanMarket, readScanConfig } from "@ai-scalper/market-scanner";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  DEFAULT_JOB_POLICY,
  JOB_NAMES,
  QUEUE_NAMES,
  type MarketScanJobData,
  type TraderSessionJobData,
} from "@ai-scalper/queueing";
import { createRedisConnection } from "./redis";
import { summarizeTraderStdout } from "./trader-log-summary";

const scanJobTimeoutMs = Number(process.env.SCAN_JOB_TIMEOUT_MS || "30000");
const scanScheduleEnabled = process.env.SCAN_SCHEDULE_ENABLED !== "false";
const scanScheduleMinutes = Number(process.env.SCAN_SCHEDULE_MINUTES || "5");
const scanScheduleRunOnStart = process.env.SCAN_SCHEDULE_RUN_ON_START !== "false";
const connection = createRedisConnection();
const queue = new Queue<MarketScanJobData>(QUEUE_NAMES.marketScan, {
  connection,
  defaultJobOptions: DEFAULT_JOB_POLICY,
});
const paperSessionQueue = new Queue<TraderSessionJobData>(QUEUE_NAMES.paperSession, {
  connection,
  defaultJobOptions: DEFAULT_JOB_POLICY,
});
const liveSessionQueue = new Queue<TraderSessionJobData>(QUEUE_NAMES.liveSession, {
  connection,
  defaultJobOptions: DEFAULT_JOB_POLICY,
});

const BOARD_PORT = Number(process.env.BULL_BOARD_PORT || "3010");
const BOARD_BASE_PATH = process.env.BULL_BOARD_BASE_PATH || "/admin/queues";
const tradingMode = (process.env.BYBIT_PAPER_TRADING || "true") === "true" ? "paper" : "live";
const network = (process.env.BYBIT_BASE_URL || "").includes("testnet") ? "testnet" : "mainnet";

console.log(JSON.stringify({
  app: "ai-scalper-worker",
  bullBoard: `http://localhost:${BOARD_PORT}${BOARD_BASE_PATH}`,
  tradingMode,
  network,
  scanScheduler: scanScheduleEnabled ? `every ${scanScheduleMinutes}m` : "disabled",
  redis: (process.env.REDIS_URL || "redis://127.0.0.1:6379").replace(/:.+@/, ":***@"),
}, null, 2));

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

async function logJob(job: { log: (row: string) => Promise<number> }, message: string): Promise<void> {
  await job.log(`${new Date().toISOString()} ${message}`);
}

async function collectStream(params: {
  onLine?: (line: string) => Promise<void>;
  stream: ReadableStream<Uint8Array> | null;
}): Promise<string> {
  if (!params.stream) {
    return "";
  }

  const reader = params.stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let collected = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    const chunk = decoder.decode(value, { stream: true });
    collected += chunk;
    buffer += chunk;

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const normalizedLine = line.trim();
      if (!normalizedLine || !params.onLine) {
        continue;
      }

      await params.onLine(normalizedLine);
    }
  }

  const tail = buffer.trim();
  if (tail && params.onLine) {
    await params.onLine(tail);
  }

  return collected;
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



function scheduledScanJobId(): string {
  const dedupeBucket = Math.floor(Date.now() / (scanScheduleMinutes * 60_000));
  return `${JOB_NAMES.marketScanRun}:schedule:${dedupeBucket}`;
}

async function enqueueScheduledScan(trigger: MarketScanJobData["trigger"]): Promise<void> {
  await queue.add(
    JOB_NAMES.marketScanRun,
    {
      requestedAt: new Date().toISOString(),
      trigger,
    },
    {
      ...DEFAULT_JOB_POLICY,
      jobId: scheduledScanJobId(),
    },
  );
}

async function runTraderSession(params: {
  job: { log: (row: string) => Promise<number> };
  paperTrading: boolean;
}): Promise<void> {
  const cwd = process.cwd();
  const traderAppDir = cwd.endsWith("/apps/worker")
    ? join(cwd, "..", "trader")
    : join(cwd, "apps", "trader");
  const subprocess = Bun.spawn({
    cmd: ["bun", "src/index.ts"],
    cwd: traderAppDir,
    env: {
      ...process.env,
      BYBIT_PAPER_TRADING: params.paperTrading ? "true" : "false",
      TRADER_MODE: "trade",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await logJob(params.job, `subprocess-started pid=${subprocess.pid ?? "unknown"}`);

  const forwardTraderStdout = (process.env.FORWARD_TRADER_STDOUT ?? "true") !== "false";
  const stdoutPromise = collectStream({
    stream: subprocess.stdout,
    onLine: async (line) => {
      if (forwardTraderStdout) {
        console.log(`[trader] ${line}`);
      }
      // Only forward to the job log if the trader event is material.
      // Quiet observational ticks, candidate-verdicts, variant filters etc. are dropped.
      const summary = summarizeTraderStdout(line);
      if (summary) {
        await logJob(params.job, summary);
      }
    },
  });
  const stderrPromise = collectStream({
    stream: subprocess.stderr,
    onLine: async (line) => {
      if (forwardTraderStdout) {
        console.error(`[trader] ${line}`);
      }
      await logJob(params.job, `stderr ${line}`);
    },
  });

  const exitCode = await subprocess.exited;
  const stdout = await stdoutPromise;
  const stderr = await stderrPromise;
  await logJob(params.job, `subprocess-exited code=${exitCode}`);
  if (exitCode !== 0) {
    const stdoutTail = stdout.trim().split("\n").slice(-20).join("\n");
    const stderrTail = stderr.trim().split("\n").slice(-20).join("\n");
    throw new Error(
      [
        `Trader session exited with code ${exitCode}`,
        stdoutTail ? `stdout:\n${stdoutTail}` : "",
        stderrTail ? `stderr:\n${stderrTail}` : "",
      ].filter(Boolean).join("\n\n"),
    );
  }
}



const worker = new Worker<MarketScanJobData>(
  QUEUE_NAMES.marketScan,
  async (job) => {
    if (job.name !== JOB_NAMES.marketScanRun) {
      throw new Error(`Unsupported job name: ${job.name}`);
    }

    await logJob(job, `started trigger=${job.data.trigger}`);
    const result = await runWithTimeout(
      scanMarket(readScanConfig()),
      scanJobTimeoutMs,
      JOB_NAMES.marketScanRun,
    );
    const topSymbols = result.candidates.slice(0, 5).map((c) => ({
      symbol: c.symbol,
      score: c.score,
      netEdgeBps: c.netEdgeBps,
    }));
    await logJob(job, `scan-completed candidates=${result.candidates.length} top=${topSymbols.map((c) => c.symbol).join(",")}`);
    console.log(JSON.stringify({
      event: "market-scan-summary",
      jobId: job.id,
      trigger: job.data.trigger,
      candidateCount: result.candidates.length,
      top: topSymbols,
    }));

    return result;
  },
  {
    connection,
    concurrency: 1,
  },
);



const paperSessionWorker = new Worker<TraderSessionJobData>(
  QUEUE_NAMES.paperSession,
  async (job) => {
    if (job.name !== JOB_NAMES.paperSessionStart) {
      throw new Error(`Unsupported job name: ${job.name}`);
    }

    await logJob(job, `started mode=paper trigger=${job.data.trigger}`);
    await runTraderSession({
      job,
      paperTrading: true,
    });
    await logJob(job, "completed mode=paper");

    return {
      finishedAt: new Date().toISOString(),
      mode: "paper",
      requestedAt: job.data.requestedAt,
      status: "completed",
    };
  },
  {
    connection,
    concurrency: 1,
  },
);

const liveSessionWorker = new Worker<TraderSessionJobData>(
  QUEUE_NAMES.liveSession,
  async (job) => {
    if (job.name !== JOB_NAMES.liveSessionStart) {
      throw new Error(`Unsupported job name: ${job.name}`);
    }

    await logJob(job, `started mode=live trigger=${job.data.trigger}`);
    await runTraderSession({
      job,
      paperTrading: false,
    });
    await logJob(job, "completed mode=live");

    return {
      finishedAt: new Date().toISOString(),
      mode: "live",
      requestedAt: job.data.requestedAt,
      status: "completed",
    };
  },
  {
    connection,
    concurrency: 1,
  },
);

// Failure listeners only — completions are already logged by logJob inside each worker fn.
const logFailure = (queueName: string) => (job: unknown, error: Error) => {
  const jobId = (job as { id?: string } | null)?.id ?? null;
  console.error(JSON.stringify({
    event: "job-failed",
    queue: queueName,
    jobId,
    error: error.message,
  }));
};
worker.on("failed", logFailure(QUEUE_NAMES.marketScan));
paperSessionWorker.on("failed", logFailure(QUEUE_NAMES.paperSession));
liveSessionWorker.on("failed", logFailure(QUEUE_NAMES.liveSession));

async function main(): Promise<void> {
  await queue.waitUntilReady();
  await paperSessionQueue.waitUntilReady();
  await liveSessionQueue.waitUntilReady();
  await worker.waitUntilReady();
  await paperSessionWorker.waitUntilReady();
  await liveSessionWorker.waitUntilReady();

  console.log(JSON.stringify({
    event: "workers-ready",
    queues: [QUEUE_NAMES.marketScan, QUEUE_NAMES.paperSession, QUEUE_NAMES.liveSession],
    scheduler: scanScheduleEnabled
      ? { enabled: true, runOnStart: scanScheduleRunOnStart, scheduleMinutes: scanScheduleMinutes }
      : { enabled: false },
  }));

  if (scanScheduleEnabled) {
    if (scanScheduleRunOnStart) {
      await enqueueScheduledScan("schedule");
    }
    setInterval(() => {
      void enqueueScheduledScan("schedule");
    }, scanScheduleMinutes * 60_000);
  }
}

connection.on("error", (error: Error) => {
  console.error(JSON.stringify({
    level: "warn",
    event: "redis-connection-error",
    error: error.message,
  }));
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ event: "shutdown-start", signal }));
  try {
    await worker.close();
    console.log(JSON.stringify({ event: "shutdown-progress", step: "market-scan-worker-closed" }));
    await paperSessionWorker.close();
    console.log(JSON.stringify({ event: "shutdown-progress", step: "paper-session-worker-closed" }));
    await liveSessionWorker.close();
    console.log(JSON.stringify({ event: "shutdown-progress", step: "live-session-worker-closed" }));
    await queue.close();
    console.log(JSON.stringify({ event: "shutdown-progress", step: "market-scan-queue-closed" }));
    await paperSessionQueue.close();
    console.log(JSON.stringify({ event: "shutdown-progress", step: "paper-session-queue-closed" }));
    await liveSessionQueue.close();
    console.log(JSON.stringify({ event: "shutdown-progress", step: "live-session-queue-closed" }));
    await connection.quit();
    console.log(JSON.stringify({ event: "shutdown-complete" }));
  } catch (error) {
    console.error(JSON.stringify({
      level: "warn",
      event: "shutdown-error",
      error: error instanceof Error ? error.message : String(error),
    }));
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

await main();
