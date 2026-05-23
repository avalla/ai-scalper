import { describe, expect, test } from "bun:test";
import { resolveWalletOrderUsd } from "./wallet-sizing";

describe("resolveWalletOrderUsd", () => {
  test("falls back when auto size is disabled", () => {
    expect(resolveWalletOrderUsd({
      autoSizeFromWallet: false,
      fallbackOrderUsd: 75,
      maxOrderUsdCap: null,
      walletBalanceResponse: null,
      walletCoin: "USDT",
      walletFraction: 1,
    })).toEqual({
      orderUsd: 75,
      reason: "wallet-auto-size-disabled",
      walletAvailableUsd: null,
    });
  });

  test("uses total available balance when it is present", () => {
    expect(resolveWalletOrderUsd({
      accountType: "UNIFIED",
      autoSizeFromWallet: true,
      fallbackOrderUsd: 25,
      maxOrderUsdCap: null,
      walletBalanceResponse: {
        result: {
          list: [
            {
              accountType: "UNIFIED",
              totalAvailableBalance: "75",
              coin: [
                {
                  coin: "USDT",
                  usdValue: "75",
                },
              ],
            },
          ],
        },
      },
      walletCoin: "USDT",
      walletFraction: 1,
    })).toEqual({
      orderUsd: 75,
      reason: "wallet-auto-sized",
      walletAvailableUsd: 75,
    });
  });

  test("applies wallet fraction and cap", () => {
    expect(resolveWalletOrderUsd({
      accountType: "UNIFIED",
      autoSizeFromWallet: true,
      fallbackOrderUsd: 25,
      maxOrderUsdCap: 80,
      walletBalanceResponse: {
        result: {
          list: [
            {
              accountType: "UNIFIED",
              totalAvailableBalance: "120",
              coin: [
                {
                  coin: "USDT",
                  usdValue: "120",
                },
              ],
            },
          ],
        },
      },
      walletCoin: "USDT",
      walletFraction: 0.8,
    })).toEqual({
      orderUsd: 80,
      reason: "wallet-auto-sized",
      walletAvailableUsd: 120,
    });
  });

  test("falls back when wallet data is unreadable", () => {
    expect(resolveWalletOrderUsd({
      accountType: "UNIFIED",
      autoSizeFromWallet: true,
      fallbackOrderUsd: 25,
      maxOrderUsdCap: null,
      walletBalanceResponse: {
        result: {
          list: [],
        },
      },
      walletCoin: "USDT",
      walletFraction: 1,
    })).toEqual({
      orderUsd: 25,
      reason: "wallet-list-missing",
      walletAvailableUsd: null,
    });
  });
});
