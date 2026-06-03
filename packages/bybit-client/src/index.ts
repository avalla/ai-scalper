export type TickerRequest = {
  category: string;
  symbol: string;
};

export type TickersRequest = {
  category: string;
  symbol?: string;
};

export type InstrumentInfoRequest = {
  category: string;
  symbol: string;
};

export type ListInstrumentsRequest = {
  category: string;
  baseCoin?: string;
  /** "LinearPerpetual" | "LinearFutures" | "InverseFutures" — pass-through filter. */
  contractType?: string;
  /** Bybit caps at 1000; we paginate via cursor if needed. */
  limit?: number;
};

export type KlineRequest = {
  category: string;
  symbol: string;
  interval: string;
  limit?: number;
};

export type MarketTicker = {
  symbol: string;
  lastPrice: string;
  markPrice: string;
  indexPrice: string;
  prevPrice1h: string;
  prevPrice24h: string;
  price24hPcnt: string;
  turnover24h: string;
  volume24h: string;
  openInterestValue: string;
  fundingRate: string;
  nextFundingTime: string;
  bid1Price: string;
  ask1Price: string;
  bid1Size: string;
  ask1Size: string;
};

export interface InstrumentInfo {
  symbol: string;
  /** "LinearPerpetual" | "LinearFutures" | "InverseFutures" | "Spot". Present on linear/inverse. */
  contractType?: string;
  /** Unix ms as string. "0" for perpetuals; future settlement time for dated futures. */
  deliveryTime?: string;
  baseCoin?: string;
  quoteCoin?: string;
  status?: string;
  leverageFilter: {
    minLeverage: string;
    maxLeverage: string;
    leverageStep: string;
  };
  lotSizeFilter: {
    minNotionalValue: string;
    maxOrderQty: string;
    maxMktOrderQty: string;
    minOrderQty: string;
    qtyStep: string;
  };
  priceFilter: {
    minPrice: string;
    maxPrice: string;
    tickSize: string;
  };
}

export interface MarketKline {
  startTime: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  closePrice: string;
  volume: string;
  turnover: string;
}

export type OrderSide = "Buy" | "Sell";
export type OrderType = "Market" | "Limit";
export type TimeInForce = "GTC" | "IOC" | "PostOnly";

export type CreateOrderRequest = {
  category: string;
  symbol: string;
  side: OrderSide;
  qty: string;
  orderType: OrderType;
  price?: string;
  reduceOnly?: boolean;
  closeOnTrigger?: boolean;
  positionIdx?: 0 | 1 | 2;
  slippageToleranceType?: "Percent" | "TickSize";
  slippageTolerance?: string;
  timeInForce?: TimeInForce;
  orderLinkId?: string;
  stopLoss?: string;
  takeProfit?: string;
};

export interface CancelOrderRequest {
  category: string;
  symbol: string;
  orderId?: string;
  orderLinkId?: string;
}

export interface RealtimeOrderRequest {
  category: string;
  symbol: string;
  orderId?: string;
  orderLinkId?: string;
  openOnly?: 0 | 1;
}

export interface CreateOrderResponse {
  orderId: string;
  orderLinkId: string;
}

export interface SwitchPositionMarginModeRequest {
  category: string;
  symbol: string;
  /** 0 = cross, 1 = isolated. */
  tradeMode: 0 | 1;
  buyLeverage: string;
  sellLeverage: string;
}

export interface RealtimeOrder {
  orderId: string;
  orderLinkId: string;
  orderStatus: string;
  price: string;
  qty: string;
  leavesQty: string;
  cumExecQty: string;
  avgPrice: string;
}

export interface PositionInfoRequest {
  category: string;
  symbol: string;
}

export interface PositionInfo {
  symbol: string;
  side: string;
  size: string;
  avgPrice: string;
  stopLoss: string;
  takeProfit: string;
}


export interface SetLeverageRequest {
  category: string;
  symbol: string;
  buyLeverage: string;
  sellLeverage: string;
}

type BybitListResponse<T> = {
  retCode: number;
  retMsg: string;
  result?: {
    category?: string;
    list?: T[];
  };
  time: number;
};

type BybitSingleResponse<T> = {
  retCode: number;
  retMsg: string;
  result?: T;
  time: number;
};

type BybitKlineResponse = {
  retCode: number;
  retMsg: string;
  result?: {
    category?: string;
    symbol?: string;
    list?: string[][];
  };
  time: number;
};

type BybitClientOptions = {
  apiKey?: string;
  apiSecret?: string;
  baseUrl?: string;
  recvWindow?: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function createQuery(params: Record<string, string>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    search.set(key, value);
  }
  return search.toString();
}

async function sign(secret: string, payload: string): Promise<string> {
  const keyData = new TextEncoder().encode(secret);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(payload),
  );

  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function parseJson<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

async function signedRequest<T>(params: {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  recvWindow: string;
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}): Promise<T> {
  const timestamp = String(Date.now());
  const query = params.query ? createQuery(params.query) : "";
  const body = params.body ? JSON.stringify(params.body) : "";
  const payload = `${timestamp}${params.apiKey}${params.recvWindow}${params.method === "GET" ? query : body}`;
  const signature = await sign(params.apiSecret, payload);
  const url = `${params.baseUrl}${params.path}${query ? `?${query}` : ""}`;
  const response = await fetch(url, {
    method: params.method,
    headers: {
      "Content-Type": "application/json",
      "X-BAPI-API-KEY": params.apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": params.recvWindow,
      "X-BAPI-SIGN": signature,
    },
    body: params.method === "POST" ? body : undefined,
  });

  if (!response.ok) {
    throw new Error(`Bybit request failed: ${response.statusText}`);
  }

  return await parseJson<T>(response);
}

export function createBybitClient(options: BybitClientOptions = {}) {
  const baseUrl = options.baseUrl || process.env.BYBIT_BASE_URL || "https://api-testnet.bybit.com";
  const recvWindow = options.recvWindow || process.env.BYBIT_RECV_WINDOW || "5000";

  return {
    async getTicker(request: TickerRequest): Promise<MarketTicker> {
      const query = createQuery({
        category: request.category,
        symbol: request.symbol,
      });
      const response = await fetch(`${baseUrl}/v5/market/tickers?${query}`);
      const data = await parseJson<BybitListResponse<MarketTicker>>(response);

      if (!response.ok || data.retCode !== 0 || !data.result?.list?.length) {
        throw new Error(`Bybit ticker request failed: ${data.retMsg || response.statusText}`);
      }

      return data.result.list[0];
    },

    async getTickers(request: TickersRequest): Promise<MarketTicker[]> {
      const queryParams: Record<string, string> = {
        category: request.category,
      };
      if (request.symbol) {
        queryParams.symbol = request.symbol;
      }
      const query = createQuery(queryParams);
      const response = await fetch(`${baseUrl}/v5/market/tickers?${query}`);
      const data = await parseJson<BybitListResponse<MarketTicker>>(response);

      if (!response.ok || data.retCode !== 0 || !data.result?.list?.length) {
        throw new Error(`Bybit tickers request failed: ${data.retMsg || response.statusText}`);
      }

      return data.result.list;
    },

    async getInstrumentInfo(request: InstrumentInfoRequest): Promise<InstrumentInfo> {
      const query = createQuery({
        category: request.category,
        symbol: request.symbol,
      });
      const response = await fetch(`${baseUrl}/v5/market/instruments-info?${query}`);
      const data = await parseJson<BybitListResponse<InstrumentInfo>>(response);

      if (!response.ok || data.retCode !== 0 || !data.result?.list?.length) {
        throw new Error(`Bybit instrument request failed: ${data.retMsg || response.statusText}`);
      }

      return data.result.list[0];
    },

    async listInstruments(request: ListInstrumentsRequest): Promise<InstrumentInfo[]> {
      const queryParams: Record<string, string> = {
        category: request.category,
        limit: String(request.limit ?? 1000),
      };
      if (request.baseCoin) queryParams.baseCoin = request.baseCoin;
      const query = createQuery(queryParams);
      const response = await fetch(`${baseUrl}/v5/market/instruments-info?${query}`);
      const data = await parseJson<BybitListResponse<InstrumentInfo>>(response);
      if (!response.ok || data.retCode !== 0) {
        throw new Error(`Bybit instruments list failed: ${data.retMsg || response.statusText}`);
      }
      const list = data.result?.list ?? [];
      if (request.contractType) return list.filter((i) => i.contractType === request.contractType);
      return list;
    },

    async getKlines(request: KlineRequest): Promise<MarketKline[]> {
      const query = createQuery({
        category: request.category,
        symbol: request.symbol,
        interval: request.interval,
        limit: String(request.limit ?? 30),
      });
      const response = await fetch(`${baseUrl}/v5/market/kline?${query}`);
      const data = await parseJson<BybitKlineResponse>(response);

      if (!response.ok || data.retCode !== 0 || !data.result?.list?.length) {
        throw new Error(`Bybit kline request failed: ${data.retMsg || response.statusText}`);
      }

      return data.result.list.map((entry) => ({
        startTime: entry[0],
        openPrice: entry[1],
        highPrice: entry[2],
        lowPrice: entry[3],
        closePrice: entry[4],
        volume: entry[5],
        turnover: entry[6],
      }));
    },

    async getWalletBalance(accountType = "UNIFIED"): Promise<unknown> {
      const apiKey = options.apiKey || requiredEnv("BYBIT_API_KEY");
      const apiSecret = options.apiSecret || requiredEnv("BYBIT_API_SECRET");
      const data = await signedRequest<BybitSingleResponse<unknown>>({
        apiKey,
        apiSecret,
        baseUrl,
        recvWindow,
        method: "GET",
        path: "/v5/account/wallet-balance",
        query: { accountType },
      });
      if (data.retCode !== 0) {
        throw new Error(`Bybit wallet balance failed: ${data.retMsg}`);
      }
      return data;
    },

    async setLeverage(request: SetLeverageRequest): Promise<{ alreadySet: boolean }> {
      const apiKey = options.apiKey || requiredEnv("BYBIT_API_KEY");
      const apiSecret = options.apiSecret || requiredEnv("BYBIT_API_SECRET");

      const data = await signedRequest<BybitSingleResponse<unknown>>({
        apiKey,
        apiSecret,
        baseUrl,
        recvWindow,
        method: "POST",
        path: "/v5/position/set-leverage",
        body: {
          category: request.category,
          symbol: request.symbol,
          buyLeverage: request.buyLeverage,
          sellLeverage: request.sellLeverage,
        },
      });
      if (data.retCode === 110043) {
        return { alreadySet: true };
      }
      if (data.retCode !== 0) {
        throw new Error(`Bybit set leverage failed: ${data.retMsg}`);
      }
      return { alreadySet: false };
    },

    /**
     * Switch margin mode for a position (cross vs isolated). Works on Classic
     * accounts (per-symbol) and on UTA where per-position override is allowed.
     * Returns `{alreadySet:true}` on Bybit code 110026 ("already in this mode")
     * so callers can call this idempotently before every entry without errors.
     * Also accepts leverage in the same request body — Bybit applies it
     * together with the mode switch.
     */
    async switchPositionMarginMode(request: SwitchPositionMarginModeRequest): Promise<{ alreadySet: boolean }> {
      const apiKey = options.apiKey || requiredEnv("BYBIT_API_KEY");
      const apiSecret = options.apiSecret || requiredEnv("BYBIT_API_SECRET");
      const data = await signedRequest<BybitSingleResponse<unknown>>({
        apiKey, apiSecret, baseUrl, recvWindow,
        method: "POST",
        path: "/v5/position/switch-isolated",
        body: {
          category: request.category,
          symbol: request.symbol,
          tradeMode: request.tradeMode,
          buyLeverage: request.buyLeverage,
          sellLeverage: request.sellLeverage,
        },
      });
      // 110026 = already in the requested margin mode (idempotent success).
      // 110043 = leverage already set to this value (same call carries leverage).
      if (data.retCode === 110026 || data.retCode === 110043) return { alreadySet: true };
      if (data.retCode !== 0) {
        throw new Error(`Bybit switch margin mode failed: ${data.retMsg}`);
      }
      return { alreadySet: false };
    },

    async setTradingStop(request: SetTradingStopRequest): Promise<{ retCode: number; retMsg: string }> {
      const apiKey = options.apiKey || requiredEnv("BYBIT_API_KEY");
      const apiSecret = options.apiSecret || requiredEnv("BYBIT_API_SECRET");

      const body: Record<string, unknown> = {
        category: request.category,
        symbol: request.symbol,
        ...(request.stopLoss !== undefined ? { stopLoss: request.stopLoss } : {}),
        ...(request.takeProfit !== undefined ? { takeProfit: request.takeProfit } : {}),
        ...(request.positionIdx !== undefined ? { positionIdx: request.positionIdx } : {}),
      };

      const data = await signedRequest<BybitSingleResponse<unknown>>({
        apiKey,
        apiSecret,
        baseUrl,
        recvWindow,
        method: "POST",
        path: "/v5/position/trading-stop",
        body,
      });

      if (data.retCode !== 0) {
        const err = new Error(`Bybit set-trading-stop failed: ${data.retMsg}`) as Error & {
          retCode?: number;
          retMsg?: string;
        };
        err.retCode = data.retCode;
        err.retMsg = data.retMsg;
        throw err;
      }

      return { retCode: data.retCode, retMsg: data.retMsg };
    },

    async createOrder(request: CreateOrderRequest): Promise<CreateOrderResponse> {
      const apiKey = options.apiKey || requiredEnv("BYBIT_API_KEY");
      const apiSecret = options.apiSecret || requiredEnv("BYBIT_API_SECRET");

      const body: Record<string, unknown> = {
        category: request.category,
        symbol: request.symbol,
        side: request.side,
        qty: request.qty,
        orderType: request.orderType,
        ...(request.price !== undefined ? { price: request.price } : {}),
        ...(request.reduceOnly !== undefined ? { reduceOnly: request.reduceOnly } : {}),
        ...(request.closeOnTrigger !== undefined ? { closeOnTrigger: request.closeOnTrigger } : {}),
        ...(request.positionIdx !== undefined ? { positionIdx: request.positionIdx } : {}),
        ...(request.slippageToleranceType !== undefined
          ? { slippageToleranceType: request.slippageToleranceType }
          : {}),
        ...(request.slippageTolerance !== undefined
          ? { slippageTolerance: request.slippageTolerance }
          : {}),
        ...(request.timeInForce !== undefined ? { timeInForce: request.timeInForce } : {}),
        ...(request.orderLinkId !== undefined ? { orderLinkId: request.orderLinkId } : {}),
        ...(request.stopLoss !== undefined ? { stopLoss: request.stopLoss } : {}),
        ...(request.takeProfit !== undefined ? { takeProfit: request.takeProfit } : {}),
      };

      const data = await signedRequest<BybitSingleResponse<CreateOrderResponse>>({
        apiKey,
        apiSecret,
        baseUrl,
        recvWindow,
        method: "POST",
        path: "/v5/order/create",
        body,
      });

      if (data.retCode !== 0 || !data.result) {
        throw new Error(`Bybit create order failed: ${data.retMsg}`);
      }

      return data.result;
    },

    async cancelOrder(request: CancelOrderRequest): Promise<CreateOrderResponse> {
      const apiKey = options.apiKey || requiredEnv("BYBIT_API_KEY");
      const apiSecret = options.apiSecret || requiredEnv("BYBIT_API_SECRET");

      const data = await signedRequest<BybitSingleResponse<CreateOrderResponse>>({
        apiKey,
        apiSecret,
        baseUrl,
        recvWindow,
        method: "POST",
        path: "/v5/order/cancel",
        body: {
          category: request.category,
          symbol: request.symbol,
          ...(request.orderId !== undefined ? { orderId: request.orderId } : {}),
          ...(request.orderLinkId !== undefined ? { orderLinkId: request.orderLinkId } : {}),
        },
      });

      if (data.retCode !== 0 || !data.result) {
        throw new Error(`Bybit cancel order failed: ${data.retMsg}`);
      }

      return data.result;
    },

    async getRealtimeOrder(request: RealtimeOrderRequest): Promise<RealtimeOrder | null> {
      const apiKey = options.apiKey || requiredEnv("BYBIT_API_KEY");
      const apiSecret = options.apiSecret || requiredEnv("BYBIT_API_SECRET");

      const data = await signedRequest<BybitListResponse<RealtimeOrder>>({
        apiKey,
        apiSecret,
        baseUrl,
        recvWindow,
        method: "GET",
        path: "/v5/order/realtime",
        query: {
          category: request.category,
          symbol: request.symbol,
          orderId: request.orderId ?? "",
          orderLinkId: request.orderLinkId ?? "",
          openOnly: String(request.openOnly ?? 0),
        },
      });

      if (data.retCode !== 0) {
        throw new Error(`Bybit realtime order request failed: ${data.retMsg}`);
      }

      return data.result?.list?.[0] ?? null;
    },

    async getPosition(request: PositionInfoRequest): Promise<PositionInfo | null> {
      const apiKey = options.apiKey || requiredEnv("BYBIT_API_KEY");
      const apiSecret = options.apiSecret || requiredEnv("BYBIT_API_SECRET");

      const data = await signedRequest<BybitListResponse<PositionInfo>>({
        apiKey,
        apiSecret,
        baseUrl,
        recvWindow,
        method: "GET",
        path: "/v5/position/list",
        query: {
          category: request.category,
          symbol: request.symbol,
        },
      });

      if (data.retCode !== 0) {
        throw new Error(`Bybit position request failed: ${data.retMsg}`);
      }

      return data.result?.list?.find((position) => Number(position.size || "0") > 0) ?? null;
    },
  };
}

export interface SetTradingStopRequest {
  category: string;
  symbol: string;
  stopLoss?: string;
  takeProfit?: string;
  positionIdx?: 0 | 1 | 2;
}
