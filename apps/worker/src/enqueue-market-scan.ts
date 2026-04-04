import { Queue } from "bullmq";
import {
  DEFAULT_JOB_POLICY,
  JOB_NAMES,
  QUEUE_NAMES,
  type MarketScanJobData,
} from "@ai-scalper/queueing";
import { createRedisConnection } from "./redis";

const connection = createRedisConnection();
const queue = new Queue<MarketScanJobData>(QUEUE_NAMES.marketScan, {
  connection,
});

async function main(): Promise<void> {
  await queue.add(
    JOB_NAMES.marketScanRun,
    {
      requestedAt: new Date().toISOString(),
      trigger: "cli",
    },
    DEFAULT_JOB_POLICY,
  );

  console.log(JSON.stringify({
    queue: QUEUE_NAMES.marketScan,
    job: JOB_NAMES.marketScanRun,
    status: "enqueued",
  }, null, 2));
}

await main();
await queue.close();
await connection.quit();
