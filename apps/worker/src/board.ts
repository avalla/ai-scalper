import express from "express";
import { Queue } from "bullmq";
import { createBullBoard } from "@bull-board/api/dist/index.js";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express/dist/index.js";
import { QUEUE_NAMES } from "@ai-scalper/queueing";
import { createRedisConnection } from "./redis";
import { runHealthChecks, type WsHealthProbe } from "./health";
import { readWsHeartbeat, type WsHeartbeat } from "./ws-heartbeat";
import { resolve } from "node:path";

const WS_HEARTBEAT_STALE_MS = 30_000;

const DEFAULT_BOARD_PORT = Number(process.env.BULL_BOARD_PORT || "3010");
const DEFAULT_BOARD_BASE_PATH = process.env.BULL_BOARD_BASE_PATH || "/admin/queues";

function buildQueues(connection: ReturnType<typeof createRedisConnection>) {
  return [
    new Queue(QUEUE_NAMES.marketScan, { connection }),
    new Queue(QUEUE_NAMES.paperSession, { connection }),
    new Queue(QUEUE_NAMES.liveSession, { connection }),
    new Queue(QUEUE_NAMES.llmManagedOpenDecision, { connection }),
    new Queue(QUEUE_NAMES.llmManagedTradeManagement, { connection }),
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
    new Queue(QUEUE_NAMES.liquidationCascadeOpenDecision, { connection }),
    new Queue(QUEUE_NAMES.liquidationCascadeTradeManagement, { connection }),
  ];
}

export interface BoardServerOpts {
  /** Defaults to env BULL_BOARD_PORT or 3010. */
  port?: number;
  /** Defaults to env BULL_BOARD_BASE_PATH or "/admin/queues". */
  basePath?: string;
  /** Re-use the worker's existing connection in-process; standalone mode creates its own. */
  connection?: ReturnType<typeof createRedisConnection>;
}

export interface BoardServerHandle {
  close(): Promise<void>;
}

/**
 * Start the Bull Board admin UI + /health probe. Can be invoked in-process by
 * the worker bootstrap (re-using its Redis connection) OR standalone via
 * `bun src/board.ts` (creates its own connection).
 */
export async function startBoardServer(opts: BoardServerOpts = {}): Promise<BoardServerHandle> {
  const port = opts.port ?? DEFAULT_BOARD_PORT;
  const basePath = opts.basePath ?? DEFAULT_BOARD_BASE_PATH;
  const connection = opts.connection ?? createRedisConnection();
  const ownsConnection = opts.connection === undefined;

  const app = express();
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(basePath);

  const queues = buildQueues(connection);
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

  app.use(basePath, serverAdapter.getRouter());

  const scanLatestPath = process.env.SCAN_LATEST_PATH
    ?? resolve(process.cwd(), "../trader/data/scan-latest.json");
  app.get("/health", async (_req, res) => {
    let heartbeat: WsHeartbeat | null = null;
    try {
      heartbeat = await readWsHeartbeat(connection as unknown as Parameters<typeof readWsHeartbeat>[0]);
    } catch {
      heartbeat = null;
    }
    const now = Date.now();
    const heartbeatFresh = heartbeat !== null && now - heartbeat.writtenAt <= WS_HEARTBEAT_STALE_MS;
    const wsProbe: WsHealthProbe = heartbeatFresh
      ? {
          isConnected: () => heartbeat!.isConnected,
          lastMessageAt: () => heartbeat!.lastMessageAt > 0 ? heartbeat!.lastMessageAt : null,
          reconnectsLastHour: () => heartbeat!.reconnects,
        }
      : {
          isConnected: () => false,
          lastMessageAt: () => null,
          reconnectsLastHour: () => 0,
        };
    const result = await runHealthChecks({
      redis: connection as unknown as { ping(): Promise<string> },
      queueLengths: async () => {
        const out: Record<string, { waiting?: number; failed?: number }> = {};
        for (const q of queues) {
          const [waiting, failed] = await Promise.all([
            q.getWaitingCount().catch(() => 0),
            q.getFailedCount().catch(() => 0),
          ]);
          out[q.name] = { waiting, failed };
        }
        return out;
      },
      ws: wsProbe,
      scanLatestPath,
    });
    res.status(result.ok ? 200 : 503).json(result);
  });

  const server = app.listen(port, () => {
    console.log(JSON.stringify({
      event: "bull-board-ready",
      basePath,
      port,
      url: `http://localhost:${port}${basePath}`,
    }));
  });

  return {
    async close() {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      if (ownsConnection) await connection.quit().catch(() => {});
    },
  };
}

// Standalone mode: when this file is the entry point (`bun src/board.ts`),
// auto-start with the env-driven defaults. When imported from index.ts, the
// caller is responsible for invoking startBoardServer().
if (import.meta.main) {
  await startBoardServer();
}
