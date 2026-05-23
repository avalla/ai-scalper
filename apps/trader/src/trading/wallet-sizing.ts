export interface ResolveWalletOrderUsdParams {
  accountType?: string;
  autoSizeFromWallet: boolean;
  fallbackOrderUsd: number;
  maxOrderUsdCap: number | null;
  walletBalanceResponse: unknown;
  walletCoin: string;
  walletFraction: number;
}

function toNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function resolveWalletOrderUsd(params: ResolveWalletOrderUsdParams): {
  orderUsd: number;
  reason: string;
  walletAvailableUsd: number | null;
} {
  if (!params.autoSizeFromWallet) {
    return {
      orderUsd: params.fallbackOrderUsd,
      reason: "wallet-auto-size-disabled",
      walletAvailableUsd: null,
    };
  }

  if (!isRecord(params.walletBalanceResponse)) {
    return {
      orderUsd: params.fallbackOrderUsd,
      reason: "wallet-response-invalid",
      walletAvailableUsd: null,
    };
  }

  const result = params.walletBalanceResponse.result;
  if (!isRecord(result) || !Array.isArray(result.list) || result.list.length === 0) {
    return {
      orderUsd: params.fallbackOrderUsd,
      reason: "wallet-list-missing",
      walletAvailableUsd: null,
    };
  }

  const accountEntry = result.list.find((entry) => {
    if (!isRecord(entry)) {
      return false;
    }

    if (!params.accountType) {
      return true;
    }

    return entry.accountType === params.accountType;
  });

  if (!isRecord(accountEntry)) {
    return {
      orderUsd: params.fallbackOrderUsd,
      reason: "wallet-account-missing",
      walletAvailableUsd: null,
    };
  }

  const totalAvailableBalance = toNumber(accountEntry.totalAvailableBalance);
  const coins = Array.isArray(accountEntry.coin) ? accountEntry.coin : [];
  const coinEntry = coins.find((coin) => isRecord(coin) && coin.coin === params.walletCoin);
  const coinUsdValue = isRecord(coinEntry) ? toNumber(coinEntry.usdValue) : null;
  const walletAvailableUsd = coinUsdValue ?? totalAvailableBalance;

  if (walletAvailableUsd === null || walletAvailableUsd <= 0) {
    return {
      orderUsd: params.fallbackOrderUsd,
      reason: "wallet-available-missing",
      walletAvailableUsd: null,
    };
  }

  const fractionalOrderUsd = walletAvailableUsd * params.walletFraction;
  const cappedOrderUsd = params.maxOrderUsdCap === null
    ? fractionalOrderUsd
    : Math.min(fractionalOrderUsd, params.maxOrderUsdCap);

  if (!Number.isFinite(cappedOrderUsd) || cappedOrderUsd <= 0) {
    return {
      orderUsd: params.fallbackOrderUsd,
      reason: "wallet-order-invalid",
      walletAvailableUsd,
    };
  }

  return {
    orderUsd: Number(cappedOrderUsd.toFixed(2)),
    reason: "wallet-auto-sized",
    walletAvailableUsd,
  };
}
