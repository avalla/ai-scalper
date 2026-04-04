import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export interface ScanCandidateGate {
  allowedSymbols: string[];
  reason: "ok" | "file-missing" | "invalid-json" | "stale" | "missing-generated-at";
  generatedAt: string | null;
}

type BacktestCandidatesFile = {
  generatedAt?: string;
  candidates?: Array<{
    symbol?: string;
  }>;
};

export type ScanArtifactFile = {
  generatedAt?: string;
  candidates?: Array<{
    symbol?: string;
  }>;
};

function resolveArtifactPath(artifactPath: string): string {
  if (isAbsolute(artifactPath)) {
    return artifactPath;
  }

  const cwd = process.cwd();
  if (cwd.endsWith("/apps/trader") || cwd.endsWith("/apps/worker")) {
    return join(cwd, "..", "..", artifactPath);
  }

  return join(cwd, artifactPath);
}

export async function loadRecentScanCandidates(params: {
  artifactPath: string;
  maxAgeMinutes: number;
}): Promise<ScanCandidateGate> {
  const resolvedPath = resolveArtifactPath(params.artifactPath);

  let raw: string;
  try {
    raw = await readFile(resolvedPath, "utf8");
  } catch {
    return {
      allowedSymbols: [],
      reason: "file-missing",
      generatedAt: null,
    };
  }

  let parsed: ScanArtifactFile;
  try {
    parsed = JSON.parse(raw) as BacktestCandidatesFile;
  } catch {
    return {
      allowedSymbols: [],
      reason: "invalid-json",
      generatedAt: null,
    };
  }

  if (!parsed.generatedAt) {
    return {
      allowedSymbols: [],
      reason: "missing-generated-at",
      generatedAt: null,
    };
  }

  const generatedAtMs = Date.parse(parsed.generatedAt);
  const maxAgeMs = params.maxAgeMinutes * 60_000;
  if (!Number.isFinite(generatedAtMs) || (Date.now() - generatedAtMs) > maxAgeMs) {
    return {
      allowedSymbols: [],
      reason: "stale",
      generatedAt: parsed.generatedAt,
    };
  }

  return {
    allowedSymbols: (parsed.candidates ?? [])
      .map((candidate) => candidate.symbol?.trim() ?? "")
      .filter(Boolean),
    reason: "ok",
    generatedAt: parsed.generatedAt,
  };
}

export async function loadRecentScanCandidatesFromMany(params: {
  artifactPaths: string[];
  maxAgeMinutes: number;
}): Promise<ScanCandidateGate> {
  for (const artifactPath of params.artifactPaths) {
    const result = await loadRecentScanCandidates({
      artifactPath,
      maxAgeMinutes: params.maxAgeMinutes,
    });

    if (result.reason === "ok" && result.allowedSymbols.length > 0) {
      return result;
    }
  }

  return {
    allowedSymbols: [],
    reason: "file-missing",
    generatedAt: null,
  };
}
