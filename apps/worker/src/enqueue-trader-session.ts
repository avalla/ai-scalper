import { Queue } from "bullmq";
import {
  DEFAULT_JOB_POLICY,
  JOB_NAMES,
  QUEUE_NAMES,
  type TraderSessionJobData,
} from "@ai-scalper/queueing";
import { createRedisConnection } from "./redis";

const connection = createRedisConnection();

async function main(): Promise<void> {
  const paperTrading = (process.env.BYBIT_PAPER_TRADING || "true") === "true";
  const queueName = paperTrading ? QUEUE_NAMES.paperSession : QUEUE_NAMES.liveSession;
  const jobName = paperTrading ? JOB_NAMES.paperSessionStart : JOB_NAMES.liveSessionStart;
  const queue = new Queue<TraderSessionJobData>(queueName, {
    connection,
  });

  await queue.add(
    jobName,
    {
      entryExecutionMode:
        process.env.ENTRY_EXECUTION_MODE === "maker-entry" ||
        process.env.ENTRY_EXECUTION_MODE === "maker-preferred-with-timeout"
          ? process.env.ENTRY_EXECUTION_MODE
          : "taker",
      paperTrading,
      requestedAt: new Date().toISOString(),
      tradingProfile: process.env.TRADING_PROFILE === "aggressive-perps" ? "aggressive-perps" : "standard",
      trigger: "cli",
    },
    DEFAULT_JOB_POLICY,
  );

  console.log(JSON.stringify({
    queue: queueName,
    job: jobName,
    paperTrading,
    status: "enqueued",
  }, null, 2));

  await queue.close();
}

await main();
await connection.quit();
