import { describe, expect, test } from "bun:test";
import {
  JOB_NAMES,
  LLM_MANAGED_JOB_POLICY,
  QUEUE_NAMES,
  type LlmManagedManageJobData,
  type LlmManagedOpenTickJobData,
} from "../src/index";

describe("llm-managed queue/job name constants", () => {
  test("queue and job names exist and are unique", () => {
    expect(QUEUE_NAMES.llmManagedOpenDecision).toBe("llm-managed-open-decision");
    expect(QUEUE_NAMES.llmManagedTradeManagement).toBe("llm-managed-trade-management");
    expect(JOB_NAMES.llmManagedOpenTick).toBe("llm-managed-open-tick");
    expect(JOB_NAMES.llmManagedManageTick).toBe("llm-managed-manage-tick");

    // No duplicates across the constant tables.
    const queueValues = Object.values(QUEUE_NAMES);
    expect(new Set(queueValues).size).toBe(queueValues.length);
    const jobValues = Object.values(JOB_NAMES);
    expect(new Set(jobValues).size).toBe(jobValues.length);
  });

  test("LLM_MANAGED_JOB_POLICY does not auto-retry (attempts=1)", () => {
    expect(LLM_MANAGED_JOB_POLICY.attempts).toBe(1);
    expect(LLM_MANAGED_JOB_POLICY.removeOnComplete).toBeGreaterThanOrEqual(20);
    expect(LLM_MANAGED_JOB_POLICY.removeOnFail).toBeGreaterThanOrEqual(20);
  });
});

describe("llm-managed job data type shapes", () => {
  test("LlmManagedOpenTickJobData accepts a well-formed payload", () => {
    const data: LlmManagedOpenTickJobData = {
      triggeredAt: new Date(0).toISOString(),
      configFile: "config.llm-managed.json",
    };
    expect(data.triggeredAt).toBe("1970-01-01T00:00:00.000Z");
    expect(data.configFile).toBe("config.llm-managed.json");
  });

  test("LlmManagedManageJobData supports null hedge and non-empty decisionsHistory", () => {
    const data: LlmManagedManageJobData = {
      positionId: "llm-managed-position:1700000000000-BTCUSDT",
      symbol: "BTCUSDT",
      side: "long",
      entryPrice: 100,
      qty: 0.1,
      qtyStep: "0.001",
      minOrderQty: "0.001",
      notionalUsd: 10,
      leverage: 3,
      openedAt: new Date(1_700_000_000_000).toISOString(),
      targetPnlUsd: 5,
      maxLossUsd: 2,
      entryReasoning: "scanner-positive-edge",
      mfeUsd: 1.2,
      maeUsd: -0.4,
      decisionsHistory: [
        { at: new Date().toISOString(), action: "hold", reasoning: "thesis-intact" },
      ],
      hedge: null,
      lastReviewAt: new Date().toISOString(),
    };
    expect(data.hedge).toBeNull();
    expect(data.decisionsHistory.length).toBe(1);
    expect(data.positionId.startsWith("llm-managed-position:")).toBe(true);
  });

  test("LlmManagedManageJobData supports an active hedge sub-record", () => {
    const data: LlmManagedManageJobData = {
      positionId: "llm-managed-position:1700000000000-BTCUSDT",
      symbol: "BTCUSDT",
      side: "long",
      entryPrice: 100,
      qty: 0.1,
      qtyStep: "0.001",
      minOrderQty: "0.001",
      notionalUsd: 10,
      leverage: 3,
      openedAt: new Date(1_700_000_000_000).toISOString(),
      targetPnlUsd: 5,
      maxLossUsd: 2,
      entryReasoning: "scanner-positive-edge",
      mfeUsd: 0,
      maeUsd: 0,
      decisionsHistory: [],
      hedge: {
        symbol: "ETHUSDT",
        side: "short",
        entryPrice: 3000,
        qty: 0.01,
        notionalUsd: 5,
        openedAt: new Date().toISOString(),
      },
      lastReviewAt: new Date().toISOString(),
    };
    expect(data.hedge?.symbol).toBe("ETHUSDT");
    expect(data.hedge?.side).toBe("short");
  });
});
