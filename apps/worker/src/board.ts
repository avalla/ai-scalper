import express from "express";
import { Queue } from "bullmq";
import { createBullBoard } from "@bull-board/api/dist/index.js";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express/dist/index.js";
import { QUEUE_NAMES } from "@ai-scalper/queueing";
import { createRedisConnection } from "./redis";

const boardPort = Number(process.env.BULL_BOARD_PORT || "3010");
const boardBasePath = process.env.BULL_BOARD_BASE_PATH || "/admin/queues";
const connection = createRedisConnection();

function buildQueues() {
  return [
    new Queue(QUEUE_NAMES.marketScan, { connection }),
    new Queue(QUEUE_NAMES.paperSession, { connection }),
    new Queue(QUEUE_NAMES.liveSession, { connection }),
    // Phase 1 PoC: llm-managed BullMQ migration. Always registered so the
    // operator can see live trade-management jobs even when no positions
    // are open (queues are auto-created the first time we read them).
    new Queue(QUEUE_NAMES.llmManagedOpenDecision, { connection }),
    new Queue(QUEUE_NAMES.llmManagedTradeManagement, { connection }),
    // Phase 2 — per-strategy queues. Read-only so the operator can monitor
    // live trades for any strategy via Bull Board.
    new Queue(QUEUE_NAMES.fundingArbOpenDecision, { connection }),
    new Queue(QUEUE_NAMES.fundingArbTradeManagement, { connection }),
    new Queue(QUEUE_NAMES.longerTfOpenDecision, { connection }),
    new Queue(QUEUE_NAMES.longerTfTradeManagement, { connection }),
    new Queue(QUEUE_NAMES.bollingerAdxOpenDecision, { connection }),
    new Queue(QUEUE_NAMES.bollingerAdxTradeManagement, { connection }),
    new Queue(QUEUE_NAMES.basisArbOpenDecision, { connection }),
    new Queue(QUEUE_NAMES.basisArbTradeManagement, { connection }),
    new Queue(QUEUE_NAMES.pairsTradingOpenDecision, { connection }),
    new Queue(QUEUE_NAMES.pairsTradingTradeManagement, { connection }),
    new Queue(QUEUE_NAMES.calendarSpreadOpenDecision, { connection }),
    new Queue(QUEUE_NAMES.calendarSpreadTradeManagement, { connection }),
    new Queue(QUEUE_NAMES.maCrossoverOpenDecision, { connection }),
    new Queue(QUEUE_NAMES.maCrossoverTradeManagement, { connection }),
  ];
}

async function main(): Promise<void> {
  const app = express();
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(boardBasePath);

  const queues = buildQueues();
  createBullBoard({
    queues: queues.map((queue) => new BullMQAdapter(queue, { readOnlyMode: true })),
    serverAdapter,
    options: {
      uiConfig: {
        boardTitle: "ai-scalper queues",
        hideRedisDetails: true,
      },
    },
  });

  app.use(boardBasePath, serverAdapter.getRouter());

  app.listen(boardPort, () => {
    console.log(JSON.stringify({
      basePath: boardBasePath,
      port: boardPort,
      status: "ready",
      url: `http://localhost:${boardPort}${boardBasePath}`,
    }, null, 2));
  });
}

await main();
