import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  loadRecentScanCandidates,
  loadRecentScanCandidatesFromMany,
} from "./load-scan-candidates";

const testDir = join(process.cwd(), "tmp", "scan-loader-tests");

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("loadRecentScanCandidates", () => {
  test("loads recent candidate symbols from a valid artifact", async () => {
    await mkdir(testDir, { recursive: true });
    const path = join(testDir, "recent.json");
    await writeFile(path, JSON.stringify({
      generatedAt: new Date().toISOString(),
      candidates: [
        { symbol: "BTCUSDT" },
        { symbol: "ETHUSDT" },
      ],
    }));

    const result = await loadRecentScanCandidates({
      artifactPath: path,
      maxAgeMinutes: 30,
    });

    expect(result.reason).toBe("ok");
    expect(result.allowedSymbols).toEqual(["BTCUSDT", "ETHUSDT"]);
  });

  test("marks stale artifacts as stale", async () => {
    await mkdir(testDir, { recursive: true });
    const path = join(testDir, "stale.json");
    await writeFile(path, JSON.stringify({
      generatedAt: "2020-01-01T00:00:00.000Z",
      candidates: [{ symbol: "BTCUSDT" }],
    }));

    const result = await loadRecentScanCandidates({
      artifactPath: path,
      maxAgeMinutes: 30,
    });

    expect(result.reason).toBe("stale");
    expect(result.allowedSymbols).toEqual([]);
  });
});

describe("loadRecentScanCandidatesFromMany", () => {
  test("uses the first valid recent artifact in the list", async () => {
    await mkdir(testDir, { recursive: true });
    const stalePath = join(testDir, "stale.json");
    const recentPath = join(testDir, "recent.json");

    await writeFile(stalePath, JSON.stringify({
      generatedAt: "2020-01-01T00:00:00.000Z",
      candidates: [{ symbol: "OLDUSDT" }],
    }));
    await writeFile(recentPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      candidates: [{ symbol: "SOLUSDT" }],
    }));

    const result = await loadRecentScanCandidatesFromMany({
      artifactPaths: [stalePath, recentPath],
      maxAgeMinutes: 30,
    });

    expect(result.reason).toBe("ok");
    expect(result.allowedSymbols).toEqual(["SOLUSDT"]);
  });
});
