import { describe, expect, it } from "bun:test";
import {
  buildAuthSignature,
  createBybitWsPrivateClient,
} from "../src/ws-private";
import type { WsScheduler, WsTransport } from "../src/ws";

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
  send(data: string): void { this.sent.push(data); }
  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true; this.readyState = CLOSED;
    this.onclose?.call(this, { code, reason });
  }
  open(): void { this.readyState = OPEN; this.onopen?.call(this, {}); }
  emit(data: unknown): void {
    this.onmessage?.call(this, { data: typeof data === "string" ? data : JSON.stringify(data) });
  }
}

class FakeScheduler implements WsScheduler {
  current = 0;
  private nextHandle = 1;
  private timers: { fn: () => void; due: number; interval: number | null; handle: number }[] = [];
  setTimeout(fn: () => void, ms: number): unknown {
    const h = this.nextHandle++;
    this.timers.push({ fn, due: this.current + ms, interval: null, handle: h });
    return h;
  }
  clearTimeout(h: unknown): void { this.timers = this.timers.filter((t) => t.handle !== h); }
  setInterval(fn: () => void, ms: number): unknown {
    const h = this.nextHandle++;
    this.timers.push({ fn, due: this.current + ms, interval: ms, handle: h });
    return h;
  }
  clearInterval(h: unknown): void { this.timers = this.timers.filter((t) => t.handle !== h); }
  now(): number { return this.current; }
  async advanceAsync(ms: number): Promise<void> {
    this.current += ms;
    const due = this.timers.filter((t) => t.due <= this.current).sort((a, b) => a.due - b.due);
    for (const t of due) {
      t.fn();
      if (t.interval !== null) t.due = this.current + t.interval;
      else this.timers = this.timers.filter((x) => x.handle !== t.handle);
    }
    // Let microtasks (auth promise) resolve.
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("buildAuthSignature", () => {
  it("produces 64-char lowercase hex HMAC-SHA256", async () => {
    const sig = await buildAuthSignature("test-secret", 1_700_000_000_000);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same inputs", async () => {
    const a = await buildAuthSignature("s", 123);
    const b = await buildAuthSignature("s", 123);
    expect(a).toBe(b);
  });

  it("changes when the expiry changes", async () => {
    const a = await buildAuthSignature("s", 123);
    const b = await buildAuthSignature("s", 124);
    expect(a).not.toBe(b);
  });
});

describe("createBybitWsPrivateClient", () => {
  it("rejects construction without credentials", () => {
    expect(() => createBybitWsPrivateClient({ apiKey: "", apiSecret: "" }))
      .toThrow(/apiKey and apiSecret/);
  });

  it("sends auth on open, then subscribe after auth-success", async () => {
    let sock: FakeSocket | null = null;
    const sched = new FakeScheduler();
    const c = createBybitWsPrivateClient({
      apiKey: "k", apiSecret: "s",
      transport: (url) => { sock = new FakeSocket(url); return sock; },
      scheduler: sched,
    });
    await c.start();
    sock!.open();
    // Auth is sent via an awaited promise; give it a tick.
    await sched.advanceAsync(0);
    const authMsg = JSON.parse(sock!.sent[0]!);
    expect(authMsg.op).toBe("auth");
    expect(authMsg.args[0]).toBe("k");
    expect(typeof authMsg.args[1]).toBe("number");
    expect(authMsg.args[2]).toMatch(/^[0-9a-f]{64}$/);

    sock!.emit({ op: "auth", success: true });
    const subMsg = JSON.parse(sock!.sent[1]!);
    expect(subMsg.op).toBe("subscribe");
    expect(subMsg.args).toEqual(["position"]);
  });

  it("caches position updates and exposes them via getPosition", async () => {
    let sock: FakeSocket | null = null;
    const c = createBybitWsPrivateClient({
      apiKey: "k", apiSecret: "s",
      transport: (url) => { sock = new FakeSocket(url); return sock; },
      scheduler: new FakeScheduler(),
    });
    await c.start();
    sock!.open();
    await new Promise((r) => setTimeout(r, 0));
    sock!.emit({ op: "auth", success: true });
    sock!.emit({
      topic: "position.linear",
      data: [
        { symbol: "BTCUSDT", side: "Buy", size: "0.5", avgPrice: "60000", stopLoss: "", takeProfit: "" },
        { symbol: "ETHUSDT", side: "Sell", size: "1.0", avgPrice: "3000", stopLoss: "2900", takeProfit: "3200" },
      ],
    });
    expect(c.getPosition("BTCUSDT")?.size).toBe("0.5");
    expect(c.getPosition("ETHUSDT")?.side).toBe("Sell");
    expect(c.getPosition("SOLUSDT")).toBeNull();
  });

  it("fires onPositionUpdate handlers", async () => {
    let sock: FakeSocket | null = null;
    const c = createBybitWsPrivateClient({
      apiKey: "k", apiSecret: "s",
      transport: (url) => { sock = new FakeSocket(url); return sock; },
      scheduler: new FakeScheduler(),
    });
    const received: string[] = [];
    c.onPositionUpdate((p) => received.push(`${p.symbol}:${p.size}`));
    await c.start();
    sock!.open();
    await new Promise((r) => setTimeout(r, 0));
    sock!.emit({ op: "auth", success: true });
    sock!.emit({ topic: "position", data: [{ symbol: "BTCUSDT", size: "1.0" }] });
    expect(received).toEqual(["BTCUSDT:1.0"]);
  });

  it("counts auth failures separately from successes", async () => {
    let sock: FakeSocket | null = null;
    const c = createBybitWsPrivateClient({
      apiKey: "k", apiSecret: "wrong",
      transport: (url) => { sock = new FakeSocket(url); return sock; },
      scheduler: new FakeScheduler(),
    });
    await c.start();
    sock!.open();
    await new Promise((r) => setTimeout(r, 0));
    sock!.emit({ op: "auth", success: false, retCode: 10003, retMsg: "API key invalid" });
    expect(c.stats().authFailures).toBe(1);
    expect(c.stats().authSuccesses).toBe(0);
  });
});
