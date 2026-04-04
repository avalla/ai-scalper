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
  bid1Price: string;
  ask1Price: string;
  bid1Size: string;
  ask1Size: string;
};

export interface InstrumentInfo {
  symbol: string;
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
  body?: Record<string, string>;
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
      return await signedRequest<unknown>({
        apiKey,
        apiSecret,
        baseUrl,
        recvWindow,
        method: "GET",
        path: "/v5/account/wallet-balance",
        query: { accountType },
      });
    },

    async setLeverage(request: SetLeverageRequest): Promise<void> {
      const apiKey = options.apiKey || requiredEnv("BYBIT_API_KEY");
      const apiSecret = options.apiSecret || requiredEnv("BYBIT_API_SECRET");

      await signedRequest<unknown>({
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
    },

    async createOrder(request: CreateOrderRequest): Promise<CreateOrderResponse> {
      const apiKey = options.apiKey || requiredEnv("BYBIT_API_KEY");
      const apiSecret = options.apiSecret || requiredEnv("BYBIT_API_SECRET");

      const data = await signedRequest<BybitSingleResponse<CreateOrderResponse>>({
        apiKey,
        apiSecret,
        baseUrl,
        recvWindow,
        method: "POST",
        path: "/v5/order/create",
        body: {
          category: request.category,
          symbol: request.symbol,
          side: request.side,
          qty: request.qty,
          orderType: request.orderType,
          price: request.price ?? "",
          reduceOnly: request.reduceOnly ? "true" : "false",
          closeOnTrigger: request.closeOnTrigger ? "true" : "false",
          positionIdx: String(request.positionIdx ?? 0),
          slippageToleranceType: request.slippageToleranceType ?? "",
          slippageTolerance: request.slippageTolerance ?? "",
          timeInForce: request.timeInForce ?? "",
          orderLinkId: request.orderLinkId ?? "",
        },
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
          orderId: request.orderId ?? "",
          orderLinkId: request.orderLinkId ?? "",
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
  };
}
