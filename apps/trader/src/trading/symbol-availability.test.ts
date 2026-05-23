import { describe, expect, test } from "bun:test";
import {
  createSymbolAvailabilityState,
  isSymbolInTickerCooldown,
  registerTickerFailure,
  registerTickerSuccess,
} from "./symbol-availability";

describe("symbol availability", () => {
  test("enters cooldown after repeated ticker failures", () => {
    const firstFailure = registerTickerFailure({
      cooldownTicks: 4,
      currentTick: 2,
      state: undefined,
      threshold: 3,
    });
    const secondFailure = registerTickerFailure({
      cooldownTicks: 4,
      currentTick: 3,
      state: firstFailure,
      threshold: 3,
    });
    const thirdFailure = registerTickerFailure({
      cooldownTicks: 4,
      currentTick: 4,
      state: secondFailure,
      threshold: 3,
    });

    expect(thirdFailure.consecutiveTickerFailures).toBe(3);
    expect(isSymbolInTickerCooldown({
      currentTick: 5,
      state: thirdFailure,
    })).toBe(true);
    expect(isSymbolInTickerCooldown({
      currentTick: 8,
      state: thirdFailure,
    })).toBe(false);
  });

  test("resets failure count after a ticker success", () => {
    const state = registerTickerFailure({
      cooldownTicks: 4,
      currentTick: 4,
      state: createSymbolAvailabilityState(),
      threshold: 1,
    });
    const recovered = registerTickerSuccess(state);

    expect(recovered.consecutiveTickerFailures).toBe(0);
    expect(recovered.tickerCooldownUntilTick).toBe(state.tickerCooldownUntilTick);
  });
});
