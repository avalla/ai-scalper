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
import { startBoardServer, type BoardServerHandle } from "./board";
import { summarizeTraderStdout } from "./trader-log-summary";
import { readTraderConfig } from "../../trader/src/config";
import { startLlmManagedWorkerStack, type LlmManagedWorkerStack } from "./llm-managed-workers";
import { startFundingArbWorkerStack, type FundingArbWorkerStack } from "./funding-arb-workers";
import { startLongerTfWorkerStack, type LongerTfWorkerStack } from "./longer-tf-workers";
import { startBollingerAdxWorkerStack, type BollingerAdxWorkerStack } from "./bollinger-adx-workers";
import { startBasisArbWorkerStack, type BasisArbWorkerStack } from "./basis-arb-workers";
import { startPairsTradingWorkerStack, type PairsTradingWorkerStack } from "./pairs-trading-workers";
import { startCalendarSpreadWorkerStack, type CalendarSpreadWorkerStack } from "./calendar-spread-workers";
import { startMaCrossoverWorkerStack, type MaCrossoverWorkerStack } from "./ma-crossover-workers";
import { startLiquidationCascadeWorkerStack, type LiquidationCascadeWorkerStack } from "./liquidation-cascade-workers";
import { startPipelineWorkerStack, type PipelineWorkerStack } from "./pipeline-workers";
import { startAggressiveWorkerStack, type AggressiveWorkerStack } from "./aggressive-workers";
import { loadAggressiveConfig } from "../../trader/src/aggressive/config";
import { startPumpScannerWorkerStack, type PumpScannerWorkerStack } from "./pump-scanner-worker";

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

let llmManagedStack: LlmManagedWorkerStack | null = null;
let fundingArbStack: FundingArbWorkerStack | null = null;
let longerTfStack: LongerTfWorkerStack | null = null;
let bollingerAdxStack: BollingerAdxWorkerStack | null = null;
let basisArbStack: BasisArbWorkerStack | null = null;
let pairsTradingStack: PairsTradingWorkerStack | null = null;
let calendarSpreadStack: CalendarSpreadWorkerStack | null = null;
let maCrossoverStack: MaCrossoverWorkerStack | null = null;
let liquidationCascadeStack: LiquidationCascadeWorkerStack | null = null;
let pipelineStack: PipelineWorkerStack | null = null;
let aggressiveStack: AggressiveWorkerStack | null = null;
let pumpScannerStack: PumpScannerWorkerStack | null = null;
let boardHandle: BoardServerHandle | null = null;
/** Optional ws-feeder subprocess (spawned by main() when USE_WEBSOCKET=true). */
let wsFeederProcess: ReturnType<typeof Bun.spawn> | null = null;
/** Optional LLM advisor subprocess (spawned when ANTHROPIC_API_KEY is set
 *  AND advisor.enabled is true in the trader config). */
let advisorProcess: ReturnType<typeof Bun.spawn> | null = null;

async function main(): Promise<void> {
  // ── Optional ws-feeder subprocess (Phase 1 WS feed). ────────────────────
  // When USE_WEBSOCKET=true the feeder writes ticker + liquidation events
  // into Redis. The aggressive subsystem REQUIRES this for the liquidation
  // map; the conservative pipeline also benefits (cached ticker source).
  if (process.env.USE_WEBSOCKET === "true") {
    wsFeederProcess = Bun.spawn({
      cmd: ["bun", "src/ws-feeder-cli.ts"],
      env: process.env,
      stdout: "inherit",
      stderr: "inherit",
    });
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      event: "ws-feeder-spawned",
      pid: wsFeederProcess.pid,
    }));
  }

  // ── Optional LLM strategy advisor (Step 1+2 — see strategy-advisor.ts). ─
  // Spawned when ANTHROPIC_API_KEY is in env. Reads the live trader config
  // to check advisor.enabled. Advisory-only: writes JSON artifact + webhook,
  // never mutates the running trader.
  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim() !== "") {
    try {
      const traderCfg = readTraderConfig(process.env);
      if (traderCfg.advisorEnabled) {
        const traderAppDir = join(__dirname, "..", "..", "trader");
        advisorProcess = Bun.spawn({
          cmd: ["bun", "src/meta/strategy-advisor-runner-cli.ts"],
          cwd: traderAppDir,
          env: process.env,
          stdout: "inherit",
          stderr: "inherit",
        });
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          event: "advisor-spawned",
          pid: advisorProcess.pid,
          model: traderCfg.advisorModel,
          intervalMinutes: traderCfg.advisorIntervalMinutes,
        }));
      }
    } catch (err) {
      console.warn(JSON.stringify({
        ts: new Date().toISOString(),
        event: "advisor-spawn-failed",
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  await queue.waitUntilReady();
  await paperSessionQueue.waitUntilReady();
  await liveSessionQueue.waitUntilReady();
  await worker.waitUntilReady();
  await paperSessionWorker.waitUntilReady();
  await liveSessionWorker.waitUntilReady();

  const activeQueues: string[] = [
    QUEUE_NAMES.marketScan, QUEUE_NAMES.paperSession, QUEUE_NAMES.liveSession,
  ];

  // ── Phase 1 PoC: llm-managed BullMQ workers (gated) ──────────────────
  let llmManagedFlag = false;
  try {
    const traderConfig = readTraderConfig();
    llmManagedFlag = traderConfig.strategyType === "llm-managed" && traderConfig.useBullmqJobs;
    if (llmManagedFlag) {
      llmManagedStack = await startLlmManagedWorkerStack({ connection, config: traderConfig });
      activeQueues.push(
        QUEUE_NAMES.llmManagedOpenDecision,
        QUEUE_NAMES.llmManagedTradeManagement,
      );
      llmManagedStack.openWorker.on("failed", logFailure(QUEUE_NAMES.llmManagedOpenDecision));
      llmManagedStack.manageWorker.on("failed", logFailure(QUEUE_NAMES.llmManagedTradeManagement));
    }
  } catch (err) {
    console.warn(JSON.stringify({
      level: "warn",
      event: "llm-managed-bullmq-bootstrap-failed",
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  // ── Phase 2 PoC: per-strategy BullMQ workers (gated) ─────────────────
  try {
    const cfg = readTraderConfig();
    const startStack = async <S>(params: {
      strategy: "funding-arb" | "longer-tf" | "bollinger-adx" | "basis-arb" | "pairs-trading" | "calendar-spread" | "ma-crossover" | "liquidation-cascade";
      flag: boolean;
      openQ: string; manageQ: string;
      start: () => Promise<S>;
      assign: (s: S) => void;
    }) => {
      if (cfg.strategyType !== params.strategy || !params.flag) return;
      const stack = await params.start();
      params.assign(stack);
      activeQueues.push(params.openQ, params.manageQ);
      const ow = (stack as unknown as { openWorker: { on: (e: string, h: (...args: unknown[]) => void) => void } }).openWorker;
      const mw = (stack as unknown as { manageWorker: { on: (e: string, h: (...args: unknown[]) => void) => void } }).manageWorker;
      ow.on("failed", logFailure(params.openQ) as unknown as (...args: unknown[]) => void);
      mw.on("failed", logFailure(params.manageQ) as unknown as (...args: unknown[]) => void);
    };
    // When the Phase 3 pipeline owns trading, the legacy per-strategy open
    // stacks must not also run (would double-open). The pipeline starts its
    // own manage workers for the piloted strategies.
    const useBullmq = cfg.useBullmqJobs && !cfg.usePipeline;
    await startStack({
      strategy: "funding-arb", flag: useBullmq,
      openQ: QUEUE_NAMES.fundingArbOpenDecision, manageQ: QUEUE_NAMES.fundingArbTradeManagement,
      start: () => startFundingArbWorkerStack({ connection, config: cfg }),
      assign: (s) => { fundingArbStack = s; },
    });
    await startStack({
      strategy: "longer-tf", flag: useBullmq,
      openQ: QUEUE_NAMES.longerTfOpenDecision, manageQ: QUEUE_NAMES.longerTfTradeManagement,
      start: () => startLongerTfWorkerStack({ connection, config: cfg }),
      assign: (s) => { longerTfStack = s; },
    });
    await startStack({
      strategy: "bollinger-adx", flag: useBullmq,
      openQ: QUEUE_NAMES.bollingerAdxOpenDecision, manageQ: QUEUE_NAMES.bollingerAdxTradeManagement,
      start: () => startBollingerAdxWorkerStack({ connection, config: cfg }),
      assign: (s) => { bollingerAdxStack = s; },
    });
    await startStack({
      strategy: "basis-arb", flag: useBullmq,
      openQ: QUEUE_NAMES.basisArbOpenDecision, manageQ: QUEUE_NAMES.basisArbTradeManagement,
      start: () => startBasisArbWorkerStack({ connection, config: cfg }),
      assign: (s) => { basisArbStack = s; },
    });
    await startStack({
      strategy: "pairs-trading", flag: useBullmq,
      openQ: QUEUE_NAMES.pairsTradingOpenDecision, manageQ: QUEUE_NAMES.pairsTradingTradeManagement,
      start: () => startPairsTradingWorkerStack({ connection, config: cfg }),
      assign: (s) => { pairsTradingStack = s; },
    });
    await startStack({
      strategy: "calendar-spread", flag: useBullmq,
      openQ: QUEUE_NAMES.calendarSpreadOpenDecision, manageQ: QUEUE_NAMES.calendarSpreadTradeManagement,
      start: () => startCalendarSpreadWorkerStack({ connection, config: cfg }),
      assign: (s) => { calendarSpreadStack = s; },
    });
    await startStack({
      strategy: "ma-crossover", flag: useBullmq,
      openQ: QUEUE_NAMES.maCrossoverOpenDecision, manageQ: QUEUE_NAMES.maCrossoverTradeManagement,
      start: () => startMaCrossoverWorkerStack({ connection, config: cfg }),
      assign: (s) => { maCrossoverStack = s; },
    });
    await startStack({
      strategy: "liquidation-cascade", flag: useBullmq,
      openQ: QUEUE_NAMES.liquidationCascadeOpenDecision, manageQ: QUEUE_NAMES.liquidationCascadeTradeManagement,
      start: () => startLiquidationCascadeWorkerStack({ connection, config: cfg }),
      assign: (s) => { liquidationCascadeStack = s; },
    });
  } catch (err) {
    console.warn(JSON.stringify({
      level: "warn",
      event: "phase2-bullmq-bootstrap-failed",
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  // ── Phase 3: scan → evaluate → trading-agent pipeline (gated) ────────
  try {
    const cfg = readTraderConfig();
    if (cfg.usePipeline) {
      pipelineStack = await startPipelineWorkerStack({ connection, config: cfg });
      activeQueues.push(QUEUE_NAMES.strategyEvaluate, QUEUE_NAMES.tradingAgent);
      pipelineStack.evaluateWorker.on("failed", logFailure(QUEUE_NAMES.strategyEvaluate));
      pipelineStack.agentWorker.on("failed", logFailure(QUEUE_NAMES.tradingAgent));
    }
  } catch (err) {
    console.warn(JSON.stringify({
      level: "warn",
      event: "phase3-pipeline-bootstrap-failed",
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  // ── Aggressive trader subsystem (separate, gated by its own config file) ──
  try {
    const aggressiveCfg = loadAggressiveConfig();
    if (aggressiveCfg && aggressiveCfg.enabled) {
      const cfg = readTraderConfig();
      aggressiveStack = await startAggressiveWorkerStack({
        connection, traderConfig: cfg, aggressiveConfig: aggressiveCfg,
      });
      activeQueues.push("aggressive-evaluate", "aggressive-manage");
      aggressiveStack.evalWorker.on("failed", logFailure("aggressive-evaluate"));
      aggressiveStack.manageWorker.on("failed", logFailure("aggressive-manage"));

      // Pump-scanner is OPTIONAL inside the aggressive config — shares the same
      // manage queue + ledger + daily-state. Both producers, one consumer.
      if (aggressiveCfg.pumpScanner?.enabled) {
        pumpScannerStack = await startPumpScannerWorkerStack({
          connection, traderConfig: cfg, aggressive: aggressiveCfg,
        });
        activeQueues.push("pump-scanner-evaluate");
        pumpScannerStack.evalWorker.on("failed", logFailure("pump-scanner-evaluate"));
      }
    }
  } catch (err) {
    console.warn(JSON.stringify({
      level: "warn",
      event: "aggressive-bootstrap-failed",
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  // Bull Board admin UI + /health probe. In-process: re-uses the worker's
  // existing Redis connection. Port collisions across paper/live are avoided
  // by setting BULL_BOARD_PORT in the systemd env (paper:3010, live:3011).
  try {
    boardHandle = await startBoardServer({ connection });
  } catch (err) {
    console.warn(JSON.stringify({
      level: "warn",
      event: "bull-board-bootstrap-failed",
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  console.log(JSON.stringify({
    event: "workers-ready",
    queues: activeQueues,
    llmManagedBullmq: llmManagedFlag,
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
    if (llmManagedStack) {
      await llmManagedStack.shutdown();
      console.log(JSON.stringify({ event: "shutdown-progress", step: "llm-managed-stack-closed" }));
    }
    if (fundingArbStack) {
      await fundingArbStack.shutdown();
      console.log(JSON.stringify({ event: "shutdown-progress", step: "funding-arb-stack-closed" }));
    }
    if (longerTfStack) {
      await longerTfStack.shutdown();
      console.log(JSON.stringify({ event: "shutdown-progress", step: "longer-tf-stack-closed" }));
    }
    if (bollingerAdxStack) {
      await bollingerAdxStack.shutdown();
      console.log(JSON.stringify({ event: "shutdown-progress", step: "bollinger-adx-stack-closed" }));
    }
    if (basisArbStack) {
      await basisArbStack.shutdown();
      console.log(JSON.stringify({ event: "shutdown-progress", step: "basis-arb-stack-closed" }));
    }
    if (pairsTradingStack) {
      await pairsTradingStack.shutdown();
      console.log(JSON.stringify({ event: "shutdown-progress", step: "pairs-trading-stack-closed" }));
    }
    if (calendarSpreadStack) {
      await calendarSpreadStack.shutdown();
      console.log(JSON.stringify({ event: "shutdown-progress", step: "calendar-spread-stack-closed" }));
    }
    if (maCrossoverStack) {
      await maCrossoverStack.shutdown();
      console.log(JSON.stringify({ event: "shutdown-progress", step: "ma-crossover-stack-closed" }));
    }
    if (liquidationCascadeStack) {
      await liquidationCascadeStack.shutdown();
      console.log(JSON.stringify({ event: "shutdown-progress", step: "liquidation-cascade-stack-closed" }));
    }
    if (pipelineStack) {
      await pipelineStack.shutdown();
      console.log(JSON.stringify({ event: "shutdown-progress", step: "pipeline-stack-closed" }));
    }
    if (aggressiveStack) {
      await aggressiveStack.shutdown();
      console.log(JSON.stringify({ event: "shutdown-progress", step: "aggressive-stack-closed" }));
    }
    if (pumpScannerStack) {
      await pumpScannerStack.shutdown();
      console.log(JSON.stringify({ event: "shutdown-progress", step: "pump-scanner-stack-closed" }));
    }
    if (wsFeederProcess && !wsFeederProcess.killed) {
      try { wsFeederProcess.kill("SIGTERM"); } catch { /* ignore */ }
      console.log(JSON.stringify({ event: "shutdown-progress", step: "ws-feeder-killed" }));
    }
    if (advisorProcess && !advisorProcess.killed) {
      try { advisorProcess.kill("SIGTERM"); } catch { /* ignore */ }
      console.log(JSON.stringify({ event: "shutdown-progress", step: "advisor-killed" }));
    }
    if (boardHandle) {
      await boardHandle.close();
      console.log(JSON.stringify({ event: "shutdown-progress", step: "bull-board-closed" }));
    }
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
