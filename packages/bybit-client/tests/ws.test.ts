import { describe, expect, it } from "bun:test";
import { createBybitWsClient, type WsScheduler, type WsTransport } from "../src/ws";

// --- Fake transport + scheduler infrastructure ---------------------------

const OPEN = 1;
const CLOSED = 3;

type Sent = string;

class FakeSocket implements WsTransport {
  readyState = 0;
  onopen: ((this: WsTransport, ev: unknown) => void) | null = null;
  onmessage: ((this: WsTransport, ev: { data: string | ArrayBuffer | Buffer }) => void) | null = null;
  onclose: ((this: WsTransport, ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((this: WsTransport, ev: unknown) => void) | null = null;
  sent: Sent[] = [];
  closed = false;

  constructor(public url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = CLOSED;
    this.onclose?.call(this, { code, reason });
  }

  // Helpers for tests
  open(): void {
    this.readyState = OPEN;
    this.onopen?.call(this, {});
  }

  emit(data: unknown): void {
    this.onmessage?.call(this, { data: typeof data === "string" ? data : JSON.stringify(data) });
  }
}

interface TimerEntry { fn: () => void; due: number; interval: number | null; handle: number; }

class FakeScheduler implements WsScheduler {
  current = 0;
  private nextHandle = 1;
  private timers: TimerEntry[] = [];

  setTimeout(handler: () => void, ms: number): unknown {
    const handle = this.nextHandle++;
    this.timers.push({ fn: handler, due: this.current + ms, interval: null, handle });
    return handle;
  }
  clearTimeout(h: unknown): void {
    this.timers = this.timers.filter((t) => t.handle !== h || t.interval !== null);
  }
  setInterval(handler: () => void, ms: number): unknown {
    const handle = this.nextHandle++;
    this.timers.push({ fn: handler, due: this.current + ms, interval: ms, handle });
    return handle;
  }
  clearInterval(h: unknown): void {
    this.timers = this.timers.filter((t) => t.handle !== h || t.interval === null);
  }
  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    const target = this.current + ms;
    // Re-fire intervals as they come due. Cap iterations to avoid loops.
    let safety = 1000;
    while (safety-- > 0) {
      const due = this.timers.filter((t) => t.due <= target).sort((a, b) => a.due - b.due);
      if (due.length === 0) break;
      const next = due[0]!;
      this.current = next.due;
      if (next.interval !== null) {
        next.due += next.interval;
      } else {
        this.timers = this.timers.filter((t) => t.handle !== next.handle);
      }
      next.fn();
    }
    this.current = target;
  }
}

function makeFactory(): { factory: (url: string) => WsTransport; created: FakeSocket[] } {
  const created: FakeSocket[] = [];
  return {
    created,
    factory: (url: string) => {
      const s = new FakeSocket(url);
      created.push(s);
      return s;
    },
  };
}

const tickerSnapshot = (symbol: string) => ({
  topic: `tickers.${symbol}`,
  type: "snapshot" as const,
  data: {
    symbol,
    lastPrice: "100.0",
    bid1Price: "99.99",
    ask1Price: "100.01",
    markPrice: "100.0",
    indexPrice: "100.0",
    fundingRate: "0.0001",
    nextFundingTime: "1700000000000",
    prevPrice1h: "99.5",
    prevPrice24h: "98.0",
    price24hPcnt: "0.02",
    turnover24h: "1000000",
    volume24h: "100",
    openInterestValue: "5000000",
    bid1Size: "10",
    ask1Size: "10",
  },
  ts: 1700000000000,
});

// --- Tests ---------------------------------------------------------------

describe("bybit ws client", () => {
  it("start() creates a connection but sends nothing before subscribe", async () => {
    const { factory, created } = makeFactory();
    const sched = new FakeScheduler();
    const client = createBybitWsClient({ transport: factory, scheduler: sched });
    await client.start();
    expect(created.length).toBe(1);
    created[0]!.open();
    expect(created[0]!.sent).toEqual([]);
    expect(client.isConnected()).toBe(true);
  });

  it("subscribeTicker sends correct op message after socket is open", async () => {
    const { factory, created } = makeFactory();
    const sched = new FakeScheduler();
    const client = createBybitWsClient({ transport: factory, scheduler: sched });
    await client.start();
    created[0]!.open();
    await client.subscribeTicker("BTCUSDT");
    const subMsg = created[0]!.sent.find((s) => s.includes("subscribe"));
    expect(subMsg).toBeDefined();
    expect(JSON.parse(subMsg!)).toEqual({
      op: "subscribe",
      args: ["tickers.BTCUSDT"],
    });
    expect(client.getSubscriptions()).toEqual(["BTCUSDT"]);
  });

  it("snapshot message populates the cache", async () => {
    const { factory, created } = makeFactory();
    const sched = new FakeScheduler();
    const client = createBybitWsClient({ transport: factory, scheduler: sched });
    await client.start();
    created[0]!.open();
    await client.subscribeTicker("BTCUSDT");
    created[0]!.emit(tickerSnapshot("BTCUSDT"));

    const cached = client.getCachedTicker("BTCUSDT");
    expect(cached).not.toBeNull();
    expect(cached!.lastPrice).toBe("100.0");
    expect(cached!.bid1Price).toBe("99.99");
  });

  it("delta merges into cached snapshot — changed field updates, untouched preserved", async () => {
    const { factory, created } = makeFactory();
    const sched = new FakeScheduler();
    const client = createBybitWsClient({ transport: factory, scheduler: sched });
    await client.start();
    created[0]!.open();
    await client.subscribeTicker("BTCUSDT");
    created[0]!.emit(tickerSnapshot("BTCUSDT"));
    created[0]!.emit({
      topic: "tickers.BTCUSDT",
      type: "delta",
      data: { symbol: "BTCUSDT", lastPrice: "101.5", ask1Price: "101.51" },
      ts: 1700000001000,
    });

    const t = client.getCachedTicker("BTCUSDT")!;
    expect(t.lastPrice).toBe("101.5");
    expect(t.ask1Price).toBe("101.51");
    // Untouched fields preserved from snapshot:
    expect(t.bid1Price).toBe("99.99");
    expect(t.fundingRate).toBe("0.0001");
  });

  it("getCachedTicker returns null for unsubscribed symbols", async () => {
    const { factory } = makeFactory();
    const sched = new FakeScheduler();
    const client = createBybitWsClient({ transport: factory, scheduler: sched });
    await client.start();
    expect(client.getCachedTicker("ETHUSDT")).toBeNull();
  });

  it("onTicker handler fires on both snapshot and delta", async () => {
    const { factory, created } = makeFactory();
    const sched = new FakeScheduler();
    const client = createBybitWsClient({ transport: factory, scheduler: sched });
    await client.start();
    created[0]!.open();
    await client.subscribeTicker("BTCUSDT");
    const seen: string[] = [];
    client.onTicker((t) => seen.push(t.lastPrice));

    created[0]!.emit(tickerSnapshot("BTCUSDT"));
    created[0]!.emit({
      topic: "tickers.BTCUSDT",
      type: "delta",
      data: { symbol: "BTCUSDT", lastPrice: "102.0" },
    });

    expect(seen).toEqual(["100.0", "102.0"]);
  });

  it("disconnect triggers reconnect attempt and re-subscribes to known topics", async () => {
    const { factory, created } = makeFactory();
    const sched = new FakeScheduler();
    const client = createBybitWsClient({
      transport: factory,
      scheduler: sched,
      reconnectInitialDelayMs: 100,
    });
    await client.start();
    created[0]!.open();
    await client.subscribeTicker("BTCUSDT");
    await client.subscribeTicker("ETHUSDT");

    // Simulate server-side close.
    created[0]!.close(1006, "abnormal");

    // Advance time past the reconnect backoff.
    sched.advance(200);

    expect(created.length).toBe(2);
    created[1]!.open();
    const resub = created[1]!.sent.find((s) => s.includes("subscribe"));
    expect(resub).toBeDefined();
    const parsed = JSON.parse(resub!);
    expect(parsed.op).toBe("subscribe");
    expect(parsed.args.sort()).toEqual(["tickers.BTCUSDT", "tickers.ETHUSDT"]);
    expect(client.getStats().reconnects).toBe(1);
  });

  it("stop() closes the connection cleanly and prevents reconnect", async () => {
    const { factory, created } = makeFactory();
    const sched = new FakeScheduler();
    const client = createBybitWsClient({
      transport: factory,
      scheduler: sched,
      reconnectInitialDelayMs: 100,
    });
    await client.start();
    created[0]!.open();
    await client.stop();
    expect(created[0]!.closed).toBe(true);
    sched.advance(5_000);
    expect(created.length).toBe(1); // no reconnect after stop
    expect(client.isConnected()).toBe(false);
  });

  it("heartbeat: sends ping every pingIntervalMs while open", async () => {
    const { factory, created } = makeFactory();
    const sched = new FakeScheduler();
    const client = createBybitWsClient({
      transport: factory,
      scheduler: sched,
      pingIntervalMs: 1000,
    });
    await client.start();
    created[0]!.open();
    sched.advance(2500);
    const pings = created[0]!.sent.filter((s) => s.includes('"op":"ping"'));
    expect(pings.length).toBeGreaterThanOrEqual(2);
  });

  it("exponential backoff: second reconnect waits longer than the first", async () => {
    const { factory, created } = makeFactory();
    const sched = new FakeScheduler();
    const client = createBybitWsClient({
      transport: factory,
      scheduler: sched,
      reconnectInitialDelayMs: 100,
      reconnectMaxDelayMs: 10_000,
    });
    await client.start();
    // Never open — close immediately to keep reconnectAttempt counter rising.
    created[0]!.close();
    sched.advance(99);
    expect(created.length).toBe(1);
    sched.advance(2);
    expect(created.length).toBe(2);
    // Second disconnect (still never opened) → next backoff should be 200ms.
    created[1]!.close();
    sched.advance(150);
    expect(created.length).toBe(2);
    sched.advance(100);
    expect(created.length).toBe(3);
  });

  it("ignores malformed JSON without crashing", async () => {
    const { factory, created } = makeFactory();
    const sched = new FakeScheduler();
    const client = createBybitWsClient({ transport: factory, scheduler: sched });
    await client.start();
    created[0]!.open();
    await client.subscribeTicker("BTCUSDT");
    // Bad payload
    created[0]!.onmessage?.call(created[0]!, { data: "not-json{{" });
    // Still operational
    created[0]!.emit(tickerSnapshot("BTCUSDT"));
    expect(client.getCachedTicker("BTCUSDT")).not.toBeNull();
  });
});
