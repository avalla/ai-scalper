export interface ResolveCandidateSymbolsParams {
  configuredSymbol: string;
  tradeCandidateSymbols: string[];
  scanCandidateSymbols: string[];
}

export interface SymbolRuntimeMetrics {
  hourlyMoveBps: number;
  netEdgeBps: number;
  spreadBps: number;
  fundingRateBps: number;
  observedAt: string;
}

export interface SelectActiveSymbolParams {
  candidateSymbols: string[];
  fallbackSymbol: string;
  openPositionSymbol: string | null;
  rotationTick: number;
  symbolMetrics?: Record<string, SymbolRuntimeMetrics>;
}

function scoreSymbolMetrics(metrics: SymbolRuntimeMetrics): number {
  return (
    (metrics.netEdgeBps * 2) +
    (Math.min(metrics.hourlyMoveBps, 200) / 10) -
    metrics.spreadBps -
    Math.abs(metrics.fundingRateBps)
  );
}

export function resolveCandidateSymbols(params: ResolveCandidateSymbolsParams): string[] {
  if (params.tradeCandidateSymbols.length > 0) {
    return params.tradeCandidateSymbols;
  }

  if (params.scanCandidateSymbols.length > 0) {
    return params.scanCandidateSymbols;
  }

  return [params.configuredSymbol];
}

export function rankCandidateSymbols(params: {
  candidateSymbols: string[];
  symbolMetrics: Record<string, SymbolRuntimeMetrics>;
}): string[] {
  return [...params.candidateSymbols].sort((left, right) => {
    const leftMetrics = params.symbolMetrics[left];
    const rightMetrics = params.symbolMetrics[right];

    if (!leftMetrics && !rightMetrics) {
      return 0;
    }

    if (!leftMetrics) {
      return 1;
    }

    if (!rightMetrics) {
      return -1;
    }

    return scoreSymbolMetrics(rightMetrics) - scoreSymbolMetrics(leftMetrics);
  });
}

export function selectActiveSymbol(params: SelectActiveSymbolParams): {
  symbol: string;
  rankedSymbols: string[];
  reason: "open-position" | "best-observed" | "candidate-rotation" | "fallback";
} {
  if (params.openPositionSymbol) {
    return {
      symbol: params.openPositionSymbol,
      rankedSymbols: params.candidateSymbols,
      reason: "open-position",
    };
  }

  if (params.candidateSymbols.length === 0) {
    return {
      symbol: params.fallbackSymbol,
      rankedSymbols: [params.fallbackSymbol],
      reason: "fallback",
    };
  }

  const rankedSymbols = params.symbolMetrics
    ? rankCandidateSymbols({
        candidateSymbols: params.candidateSymbols,
        symbolMetrics: params.symbolMetrics,
      })
    : params.candidateSymbols;
  const hasObservedAllCandidates = params.candidateSymbols.every((symbol) => params.symbolMetrics?.[symbol]);
  const bestObservedSymbol = hasObservedAllCandidates
    ? rankedSymbols.find((symbol) => params.symbolMetrics?.[symbol])
    : null;

  if (bestObservedSymbol) {
    return {
      symbol: bestObservedSymbol,
      rankedSymbols,
      reason: "best-observed",
    };
  }

  return {
    symbol: params.candidateSymbols[params.rotationTick % params.candidateSymbols.length],
    rankedSymbols,
    reason: "candidate-rotation",
  };
}
