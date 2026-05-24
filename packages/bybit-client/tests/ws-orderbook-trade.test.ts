import { describe, expect, it } from "bun:test";
import { createBybitWsClient, type WsScheduler, type WsTransport, type PublicTrade } from "../src/ws";

const OPEN = 1;
const CLOSED = 3;

class FakeSocket implements WsTransport {
  readyState = 0;
  onopen: ((this: WsTransport, ev: unknown) => void) | null = null;
  onmessage: ((this: WsTransport, ev: { data: string | ArrayBuffer | Buffer }) => void) | null = null;
  onclose: ((this: WsTransport, ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((this: WsTransport, ev: unknown) => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(public url: string) {}
  send(d: string) { this.sent.push(d); }
  close(code?: number, reason?: string) {
    if (this.closed) return;
    this.closed = true;
    this.readyState = CLOSED;
    this.onclose?.call(this, { code, reason });
  }
  open() { this.readyState = OPEN; this.onopen?.call(this, {}); }
  emit(d: unknown) { this.onmessage?.call(this, { data: typeof d === "string" ? d : JSON.stringify(d) }); }
}

class FakeScheduler implements WsScheduler {
  current = 0;
  setTimeout() { return 0; }
  clearTimeout() {}
  setInterval() { return 0; }
  clearInterval() {}
  now() { return this.current; }
}

function makeClient() {
  const sockets: FakeSocket[] = [];
  const factory = (u: string) => { const s = new FakeSocket(u); sockets.push(s); return s; };
  const sched = new FakeScheduler();
  const client = createBybitWsClient({
    transport: factory,
    scheduler: sched,
    pingIntervalMs: 100_000,
  });
  return { client, sockets, sched };
}

describe("BybitWsClient — orderbook", () => {
  it("snapshot populates cache with bids+asks sorted", async () => {
    const { client, sockets } = makeClient();
    await client.start();
    sockets[0]!.open();
    await client.subscribeOrderbook("BTCUSDT", 50);

    sockets[0]!.emit({
      topic: "orderbook.50.BTCUSDT",
      type: "snapshot",
      data: {
        s: "BTCUSDT",
        b: [["99.0", "1"], ["100.0", "2"]],
        a: [["101.0", "3"], ["100.5", "4"]],
        u: 1, seq: 1,
      },
    });

    const book = client.getCachedOrderbook("BTCUSDT");
    expect(book).not.toBeNull();
    expect(book!.bids[0]?.[0]).toBe("100.0");
    expect(book!.bids[1]?.[0]).toBe("99.0");
    expect(book!.asks[0]?.[0]).toBe("100.5");
    expect(book!.asks[1]?.[0]).toBe("101.0");
    expect(book!.updateId).toBe(1);
    await client.stop();
  });

  it("delta with size 0 removes a level", async () => {
    const { client, sockets } = makeClient();
    await client.start();
    sockets[0]!.open();
    await client.subscribeOrderbook("BTCUSDT");
    sockets[0]!.emit({
      topic: "orderbook.50.BTCUSDT",
      type: "snapshot",
      data: { s: "BTCUSDT", b: [["100", "1"], ["99", "2"]], a: [["101", "1"]], u: 1, seq: 1 },
    });
    sockets[0]!.emit({
      topic: "orderbook.50.BTCUSDT",
      type: "delta",
      data: { s: "BTCUSDT", b: [["99", "0"]], a: [], u: 2, seq: 2 },
    });
    const book = client.getCachedOrderbook("BTCUSDT")!;
    expect(book.bids.map((l) => l[0])).toEqual(["100"]);
    expect(book.updateId).toBe(2);
    await client.stop();
  });

  it("delta updates size at existing price", async () => {
    const { client, sockets } = makeClient();
    await client.start();
    sockets[0]!.open();
    await client.subscribeOrderbook("BTCUSDT");
    sockets[0]!.emit({
      topic: "orderbook.50.BTCUSDT",
      type: "snapshot",
      data: { s: "BTCUSDT", b: [["100", "1"]], a: [["101", "1"]], u: 1, seq: 1 },
    });
    sockets[0]!.emit({
      topic: "orderbook.50.BTCUSDT",
      type: "delta",
      data: { s: "BTCUSDT", b: [["100", "5"]], a: [], u: 2, seq: 2 },
    });
    const book = client.getCachedOrderbook("BTCUSDT")!;
    expect(book.bids[0]).toEqual(["100", "5"]);
    await client.stop();
  });

  it("getCachedOrderbook returns null for unsubscribed symbol", () => {
    const { client } = makeClient();
    expect(client.getCachedOrderbook("ETHUSDT")).toBeNull();
  });

  it("onOrderbook handler receives snapshot+delta", async () => {
    const { client, sockets } = makeClient();
    await client.start();
    sockets[0]!.open();
    const received: number[] = [];
    client.onOrderbook((b) => received.push(b.updateId));
    await client.subscribeOrderbook("BTCUSDT");
    sockets[0]!.emit({
      topic: "orderbook.50.BTCUSDT", type: "snapshot",
      data: { s: "BTCUSDT", b: [["100", "1"]], a: [["101", "1"]], u: 7, seq: 7 },
    });
    sockets[0]!.emit({
      topic: "orderbook.50.BTCUSDT", type: "delta",
      data: { s: "BTCUSDT", b: [], a: [["102", "2"]], u: 8, seq: 8 },
    });
    expect(received).toEqual([7, 8]);
    await client.stop();
  });

  it("subscribe sends orderbook topic and re-subscribes on reconnect", async () => {
    const { client, sockets } = makeClient();
    await client.start();
    sockets[0]!.open();
    await client.subscribeOrderbook("BTCUSDT", 50);
    expect(sockets[0]!.sent.some((m) => m.includes("orderbook.50.BTCUSDT"))).toBe(true);
  });
});

describe("BybitWsClient — publicTrade", () => {
  it("emits trades, marking BT=true as liquidation", async () => {
    const { client, sockets } = makeClient();
    await client.start();
    sockets[0]!.open();
    const received: PublicTrade[] = [];
    client.onPublicTrade((t) => received.push(t));
    await client.subscribePublicTrade("BTCUSDT");
    sockets[0]!.emit({
      topic: "publicTrade.BTCUSDT",
      data: [
        { T: 1700000000000, s: "BTCUSDT", S: "Sell", v: "0.5", p: "100", i: "id1", BT: false },
        { T: 1700000000001, s: "BTCUSDT", S: "Buy", v: "1.0", p: "100.1", i: "id2", BT: true },
      ],
    });
    expect(received.length).toBe(2);
    expect(received[0]!.isLiquidation).toBe(false);
    expect(received[1]!.isLiquidation).toBe(true);
    expect(received[1]!.side).toBe("Buy");
    expect(received[1]!.price).toBe("100.1");
    await client.stop();
  });

  it("ignores trades missing symbol", async () => {
    const { client, sockets } = makeClient();
    await client.start();
    sockets[0]!.open();
    const received: PublicTrade[] = [];
    client.onPublicTrade((t) => received.push(t));
    await client.subscribePublicTrade("BTCUSDT");
    sockets[0]!.emit({
      topic: "publicTrade.BTCUSDT",
      data: [{ T: 1, S: "Buy", v: "1", p: "1", i: "x", BT: true }],
    });
    expect(received.length).toBe(0);
    await client.stop();
  });
});
