export interface SymbolAvailabilityState {
  consecutiveTickerFailures: number;
  tickerCooldownUntilTick: number;
}

export function createSymbolAvailabilityState(): SymbolAvailabilityState {
  return {
    consecutiveTickerFailures: 0,
    tickerCooldownUntilTick: -1,
  };
}

export function isSymbolInTickerCooldown(params: {
  currentTick: number;
  state: SymbolAvailabilityState | undefined;
}): boolean {
  if (!params.state) {
    return false;
  }

  return params.currentTick < params.state.tickerCooldownUntilTick;
}

export function registerTickerFailure(params: {
  cooldownTicks: number;
  currentTick: number;
  state: SymbolAvailabilityState | undefined;
  threshold: number;
}): SymbolAvailabilityState {
  const previous = params.state ?? createSymbolAvailabilityState();
  const consecutiveTickerFailures = previous.consecutiveTickerFailures + 1;

  return {
    consecutiveTickerFailures,
    tickerCooldownUntilTick: consecutiveTickerFailures >= params.threshold
      ? params.currentTick + params.cooldownTicks
      : previous.tickerCooldownUntilTick,
  };
}

export function registerTickerSuccess(
  state: SymbolAvailabilityState | undefined,
): SymbolAvailabilityState {
  const previous = state ?? createSymbolAvailabilityState();

  return {
    consecutiveTickerFailures: 0,
    tickerCooldownUntilTick: previous.tickerCooldownUntilTick,
  };
}
