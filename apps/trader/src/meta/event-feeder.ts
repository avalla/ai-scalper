/**
 * Event Feeder — pure types + classification helpers. Pulls external "events"
 * (Bybit announcements, funding extremes, later RSS/Telegram) into a uniform
 * MarketEvent shape that downstream consumers (advisor, risk officer, strategy
 * gates) can read from Redis.
 *
 * MVP scope: 2 sources (bybit-announcement + funding-extreme). Rule-based
 * classification (no LLM cost). Extensible to RSS / Telegram later.
 */

export type EventSource = "bybit-announcement" | "funding-extreme" | "coindesk-rss" | "telegram";
export type EventSignal = "high" | "medium" | "low";
export type EventSentiment = "bullish" | "bearish" | "neutral";

export interface MarketEvent {
  source: EventSource;
  observedAt: string;
  publishedAt?: string;
  signal: EventSignal;
  sentiment: EventSentiment;
  /** Symbols directly affected by this event. Empty for macro events. */
  symbols: string[];
  /** Short human-readable headline. */
  title: string;
  url?: string;
  /** Source-specific raw payload for forensics. */
  raw?: Record<string, unknown>;
  /** Stable identifier used for dedup (channel:postId, url, fundingExtreme:sym:ts...). */
  externalId: string;
}

// ── Bybit announcement classification ───────────────────────────────────

interface BybitAnnouncementRaw {
  title: string;
  description?: string;
  type?: { title?: string };
  tags?: string[];
  url?: string;
  /** Unix ms or s — Bybit publishes ms strings. */
  dateTimestamp?: number | string;
  /** Stable id from Bybit. */
  description_url?: string;
}

const SYMBOL_PATTERN = /\b([A-Z]{2,10})USDT?\b/g;

function extractSymbols(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = SYMBOL_PATTERN.exec(text)) !== null) {
    out.add(`${m[1]}USDT`);
  }
  return [...out];
}

export function classifyBybitAnnouncement(a: BybitAnnouncementRaw, observedAt: string): MarketEvent | null {
  const title = a.title?.trim();
  if (!title) return null;
  const url = a.url ?? a.description_url;
  const externalId = url ?? `bybit-ann:${title}`;
  const haystack = `${title} ${a.description ?? ""}`.toLowerCase();
  const symbols = extractSymbols(title.toUpperCase() + " " + (a.description ?? "").toUpperCase());

  let signal: EventSignal = "low";
  let sentiment: EventSentiment = "neutral";

  if (/\bnew\b.*\b(listing|trading|launches?|live)/.test(haystack) || /\b(listing|listed)\b/.test(haystack)) {
    signal = "high"; sentiment = "bullish";
  } else if (/\b(delisting|delisted|removal|removed)\b/.test(haystack)) {
    signal = "high"; sentiment = "bearish";
  } else if (/\b(maintenance|upgrade|migration|downtime)\b/.test(haystack)) {
    signal = "medium"; sentiment = "neutral";
  } else if (/\b(perpetual|leveraged tokens?|spot trading)\b/.test(haystack)) {
    signal = "medium"; sentiment = "bullish";
  } else if (/\b(hack|exploit|security incident|breach)\b/.test(haystack)) {
    signal = "high"; sentiment = "bearish";
  } else {
    return null; // unclassifiable → skip
  }

  const publishedAt = typeof a.dateTimestamp === "number"
    ? new Date(a.dateTimestamp).toISOString()
    : (typeof a.dateTimestamp === "string" ? new Date(Number(a.dateTimestamp)).toISOString() : undefined);

  return {
    source: "bybit-announcement",
    observedAt,
    publishedAt,
    signal, sentiment, symbols,
    title,
    url,
    raw: a as unknown as Record<string, unknown>,
    externalId,
  };
}

// ── Funding rate extreme classification ─────────────────────────────────

interface FundingTickerLite {
  symbol: string;
  fundingRate: string;
  turnover24h?: string;
}

export interface FundingExtremeOpts {
  /** Absolute funding bps threshold. Default 30 bps (0.3%). */
  thresholdBps?: number;
  /** Top-N by turnover to consider. Default 20. */
  topN?: number;
}

/**
 * Scan tickers for extreme funding rates. Returns a MarketEvent per symbol
 * exceeding the threshold. Sentiment is CONTRARIAN to the funding sign:
 * very positive funding = crowded longs → bearish setup; very negative funding
 * = crowded shorts → bullish setup.
 */
export function detectFundingExtremes(
  tickers: ReadonlyArray<FundingTickerLite>,
  observedAt: string,
  opts: FundingExtremeOpts = {},
): MarketEvent[] {
  const threshold = (opts.thresholdBps ?? 30) / 10_000;
  const topN = opts.topN ?? 20;
  const sorted = [...tickers]
    .filter((t) => Number.isFinite(Number(t.fundingRate)))
    .sort((a, b) => Number(b.turnover24h || 0) - Number(a.turnover24h || 0))
    .slice(0, topN);

  const out: MarketEvent[] = [];
  for (const t of sorted) {
    const rate = Number(t.fundingRate);
    if (Math.abs(rate) < threshold) continue;
    const rateBps = rate * 10_000;
    const sentiment: EventSentiment = rate > 0 ? "bearish" : "bullish";
    const signal: EventSignal = Math.abs(rateBps) >= 50 ? "high" : "medium";
    out.push({
      source: "funding-extreme",
      observedAt,
      signal, sentiment,
      symbols: [t.symbol],
      title: `${t.symbol} funding ${rateBps >= 0 ? "+" : ""}${rateBps.toFixed(2)} bps (${sentiment} contrarian)`,
      raw: { symbol: t.symbol, fundingRate: rate, turnover24h: Number(t.turnover24h || 0) },
      // Bucket by 8h funding window so we don't emit duplicates every poll.
      externalId: `funding-extreme:${t.symbol}:${Math.floor(Date.parse(observedAt) / (8 * 3_600_000))}`,
    });
  }
  return out;
}

// ── Dedup helper ────────────────────────────────────────────────────────

/** Filter out events whose externalId is already in `seen`. Mutates `seen`. */
export function dedupEvents(events: ReadonlyArray<MarketEvent>, seen: Set<string>): MarketEvent[] {
  const out: MarketEvent[] = [];
  for (const e of events) {
    if (seen.has(e.externalId)) continue;
    seen.add(e.externalId);
    out.push(e);
  }
  return out;
}
