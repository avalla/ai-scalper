import { describe, expect, test } from "bun:test";
import { resolveProjectPath } from "../src/paths";

describe("resolveProjectPath", () => {
  test("returns absolute paths unchanged", () => {
    expect(resolveProjectPath("/tmp/foo/bar.json")).toBe("/tmp/foo/bar.json");
  });

  test("resolves relative paths to project root containing bun.lock", () => {
    const resolved = resolveProjectPath("apps/trader/data/scan-latest.json");
    expect(resolved.endsWith("/apps/trader/data/scan-latest.json")).toBe(true);
    expect(resolved.includes("ai-scalper")).toBe(true);
  });
});
