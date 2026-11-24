// The Ticker Times — a newspaper-style stock tracker.
// Zero dependencies: run with `node server.js` (Node 18+), then open http://localhost:3000
//
// Sources (all free, no API keys):
//   Social:  StockTwits (trending + bull/bear sentiment), ApeWisdom (Reddit mention counts
//            across r/wallstreetbets, r/stocks, r/investing ...), Reddit (direct, when reachable),
//            Hacker News
//   Market:  Yahoo Finance (gainers / losers / most active screeners, charts, per-ticker news)
//   News:    MarketWatch, Nasdaq, Seeking Alpha, Google News RSS

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const EDITION_TTL = 5 * 60 * 1000;
const SENTIMENT_TTL = 15 * 60 * 1000; // StockTwits allows ~200 anonymous requests/hour

// ---------- helpers ----------
const cache = new Map();
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

async function get(url, type = "json") {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: type === "json" ? "application/json" : "application/rss+xml, text/xml, */*" },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return type === "json" ? res.json() : res.text();
}

// Run a promise; record a failing source instead of crashing the edition.
async function safe(name, status, fn, fallback) {
  try {
    const v = await fn();
    status[name] = "ok";
    return v;
  } catch (e) {
    status[name] = "unavailable (" + e.message + ")";
    return fallback;
  }
}

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]).catch(() => null); }
  }));
  return out;
}

const decode = (s = "") => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/<[^>]+>/g, "")
  .replace(/&amp;/g, "&").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/\s+/g, " ").trim();

function parseRss(xml, source) {
  const items = [];
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/g)) {
    const tag = (t) => { const r = m[0].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`)); return r ? decode(r[1]) : ""; };
    const title = tag("title");
    if (!title) continue;
    items.push({ title, link: tag("link"), date: tag("pubDate") || tag("dc:date"), summary: tag("description").slice(0, 280), source });
  }
  return items;
}

// Net bull/bear tilt, shrunk toward neutral when only a handful of people have tagged a view.
const sentimentOf = (st) => (st.bull + st.bear >= 3 ? +((st.bull - st.bear) / (st.bull + st.bear + 4)).toFixed(2) : null);
const clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
const isTicker = (s) => /^[A-Z]{1,5}(\.[A-Z])?$/.test(s);

// ---------- sources ----------
async function yahooScreener(id) {
  const d = await get(`https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${id}&count=25`);
  return (d.finance?.result?.[0]?.quotes || []).map((q) => ({
    symbol: q.symbol,
    name: q.shortName || q.longName,
    price: q.regularMarketPrice,
    pct: q.regularMarketChangePercent,
    volume: q.regularMarketVolume,
    avgVolume: q.averageDailyVolume3Month,
    marketCap: q.marketCap,
  }));
}

async function yahooChart(sym) {
  return cached("chart:" + sym, EDITION_TTL, async () => {
    const d = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1mo&interval=1d`);
    const r = d.chart?.result?.[0];
    if (!r) throw new Error("no chart");
    const closes = (r.indicators?.quote?.[0]?.close || []).filter((x) => x != null);
    const price = r.meta.regularMarketPrice;
    const prev = closes.length > 1 ? closes[closes.length - 2] : r.meta.chartPreviousClose;
    return { symbol: sym, name: r.meta.shortName || r.meta.longName, price, pct: prev ? ((price - prev) / prev) * 100 : null, spark: closes.slice(-20) };
  });
}

async function yahooNews(sym) {
  return cached("ynews:" + sym, EDITION_TTL, async () =>
    parseRss(await get(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(sym)}&region=US&lang=en-US`, "text"), "Yahoo Finance").slice(0, 4));
}

async function stocktwitsTrending() {
  const d = await get("https://api.stocktwits.com/api/2/trending/symbols.json");
  return (d.symbols || [])
    .filter((s) => (s.instrument_class || "Stock") !== "Crypto" && isTicker(s.symbol))
    .map((s) => ({ symbol: s.symbol, name: s.title, rank: s.rank, score: s.trending_score, summary: s.trends?.summary || "", watchers: s.watchlist_count }));
}

async function stocktwitsSentiment(sym) {
  return cached("st:" + sym, SENTIMENT_TTL, async () => {
    const d = await get(`https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(sym)}.json`);
    let bull = 0, bear = 0;
    const posts = [];
    for (const m of d.messages || []) {
      const s = m.entities?.sentiment?.basic;
      if (s === "Bullish") bull++;
      if (s === "Bearish") bear++;
      if (posts.length < 4 && m.body && m.body.length > 25 && m.body.length < 320 && !/https?:\/\//.test(m.body))
        posts.push({ user: m.user?.username, body: decode(m.body), sentiment: s || null, at: m.created_at });
    }
    return { bull, bear, total: (d.messages || []).length, posts };
  });
}

async function apeWisdom() {
  const pages = await Promise.all([1, 2].map((p) => get(`https://apewisdom.io/api/v1.0/filter/all-stocks/page/${p}`)));
  const map = {};
  for (const r of pages.flatMap((p) => p.results || []))
    map[r.ticker] = { mentions: +r.mentions || 0, prev: +r.mentions_24h_ago || 0, upvotes: +r.upvotes || 0, rank: r.rank, name: decode(r.name) };
  return map;
}

async function redditHot() {
  const subs = ["wallstreetbets", "stocks", "investing", "StockMarket"];
  const out = [];
  for (const sub of subs) {
    const d = await get(`https://www.reddit.com/r/${sub}/hot.json?limit=12`);
    for (const c of d.data?.children || []) {
      const p = c.data;
      if (p.stickied) continue;
      out.push({ title: decode(p.title), link: "https://www.reddit.com" + p.permalink, score: p.ups, comments: p.num_comments, source: "r/" + sub });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 10);
}

async function hackerNews() {
  const d = await get("https://hn.algolia.com/api/v1/search_by_date?query=stocks%20OR%20market%20OR%20earnings&tags=story&numericFilters=points>20");
  return (d.hits || []).slice(0, 6).map((h) => ({ title: h.title, link: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, score: h.points, comments: h.num_comments, source: "Hacker News" }));
}

const NEWS_FEEDS = [
  ["MarketWatch", "https://feeds.content.dowjones.io/public/rss/mw_topstories"],
  ["Nasdaq", "https://www.nasdaq.com/feed/rssoutbound?category=Stocks"],
  ["Seeking Alpha", "https://seekingalpha.com/market_currents.xml"],
  ["Google News", "https://news.google.com/rss/search?q=stock+market+when:1d&hl=en-US&gl=US&ceid=US:en"],
];

// ---------- the editorial desk ----------
function cleanName(n) {
  if (!n) return "";
  n = n.replace(/\s+-\s+.*$/, "").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i++)
    n = n.replace(/,?\s+(Inc|Incorporated|Corp|Corporation|Comp|Company|Co|Ltd|Limited|plc|PBC|N\.?V|S\.?A|AG|SE|Holdings?|Group|Technologies Inc)\.?$/i, "").trim();
  if (n === n.toUpperCase() && n.length > 4) n = n.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  return n;
}

function headlineFor(s) {
  const p = s.pct ?? 0, a = Math.abs(p).toFixed(1);
  const up = [[12, "Rockets"], [6, "Soars"], [3, "Surges"], [1, "Climbs"], [0, "Edges Up"]];
  const down = [[12, "Craters"], [6, "Plunges"], [3, "Tumbles"], [1, "Slides"], [0, "Dips"]];
  const verb = (p >= 0 ? up : down).find(([t]) => Math.abs(p) >= t)[1];
  let angle = "";
  if (s.buzzX >= 2) angle = `as Reddit Chatter ${s.buzzX >= 3 ? "Explodes" : "Doubles"}`;
  else if (s.sentiment != null && s.sentiment >= 0.4) angle = "as Bulls Pile In";
  else if (s.sentiment != null && s.sentiment <= -0.3) angle = "as Bears Circle";
  else if (s.stRank) angle = "on StockTwits Trending List";
  else if (s.volRatio >= 2) angle = "on Heavy Volume";
  return `${cleanName(s.name) || s.symbol} ${verb} ${a}% ${angle}`.trim();
}

function scoreStock(s) {
  const price = s.pct != null ? clamp(s.pct / 8) : 0;
  const sentiment = s.sentiment ?? 0;
  // Buzz is direction-neutral attention; it amplifies whichever way the stock is already leaning.
  const buzz = s.buzzX ? clamp(Math.log2(s.buzzX) / 2, 0, 1) : 0;
  const lean = Math.sign(price * 0.6 + sentiment * 0.4) || 0;
  const social = clamp((s.mentions ? Math.log10(s.mentions + 1) / 3 : 0) + (s.stRank ? 0.35 : 0), 0, 1);
  // Social signals carry more weight than price alone.
  s.score = +(0.45 * price + 0.35 * sentiment + 0.2 * buzz * lean).toFixed(3);
  s.social = +social.toFixed(2);
  s.rank = s.score * (0.6 + 0.8 * social);
  return s;
}

async function buildEdition() {
  const status = {};
  const [gainers, losers, actives, trending, ape, reddit, hn, ...feeds] = await Promise.all([
    safe("Yahoo gainers", status, () => yahooScreener("day_gainers"), []),
    safe("Yahoo losers", status, () => yahooScreener("day_losers"), []),
    safe("Yahoo most active", status, () => yahooScreener("most_actives"), []),
    safe("StockTwits trending", status, stocktwitsTrending, []),
    safe("Reddit mentions (ApeWisdom)", status, apeWisdom, {}),
    safe("Reddit hot posts", status, redditHot, []),
    safe("Hacker News", status, hackerNews, []),
    ...NEWS_FEEDS.map(([name, url]) => safe(name, status, async () => parseRss(await get(url, "text"), name).slice(0, 8), [])),
  ]);

  // Merge everything into one universe keyed by ticker.
  const U = {};
  const touch = (sym) => (U[sym] ||= { symbol: sym, sources: new Set() });
  for (const q of [...gainers, ...losers, ...actives]) {
    if (!isTicker(q.symbol)) continue;
    const s = Object.assign(touch(q.symbol), q);
    s.volRatio = q.avgVolume ? q.volume / q.avgVolume : null;
    s.sources.add("Yahoo Finance");
  }
  for (const t of trending) {
    const s = touch(t.symbol);
    s.name ||= t.name; s.stRank = t.rank; s.stSummary = t.summary; s.watchers = t.watchers;
    s.sources.add("StockTwits");
  }
  for (const [sym, a] of Object.entries(ape).slice(0, 60)) {
    if (!isTicker(sym) || ["SPY", "QQQ", "IWM", "DIA", "VOO", "TQQQ", "SQQQ"].includes(sym)) continue;
    const s = touch(sym);
    s.name ||= a.name; s.mentions = a.mentions; s.mentionsPrev = a.prev; s.upvotes = a.upvotes;
    s.buzzX = a.prev ? +((a.mentions + 3) / (a.prev + 3)).toFixed(2) : a.mentions > 10 ? 3 : null;
    s.sources.add("Reddit");
  }
  // Fill Reddit stats for screener stocks that appear lower in the mention list.
  for (const s of Object.values(U)) if (s.mentions == null && ape[s.symbol]) {
    const a = ape[s.symbol]; s.mentions = a.mentions; s.mentionsPrev = a.prev;
    s.buzzX = a.prev ? +((a.mentions + 3) / (a.prev + 3)).toFixed(2) : null; s.sources.add("Reddit");
  }

  // Prices for social-only names.
  const needPrice = Object.values(U).filter((s) => s.pct == null).slice(0, 40);
  await pool(needPrice, 6, async (s) => Object.assign(s, { ...(await yahooChart(s.symbol)), name: s.name || undefined }));

  // Pick candidates with the strongest pre-sentiment signal, then ask StockTwits how people feel.
  // Skip sub-$1 penny stocks: they are the easiest to pump on social media.
  let list = Object.values(U).filter((s) => s.pct != null && s.price >= 1).map(scoreStock);
  const pre = [...list].sort((a, b) => Math.abs(b.rank) - Math.abs(a.rank));
  const cands = [...new Set([...pre.filter((s) => s.rank > 0).slice(0, 12), ...pre.filter((s) => s.rank < 0).slice(0, 12)])];
  let stOk = 0;
  await pool(cands, 4, async (s) => {
    const st = await stocktwitsSentiment(s.symbol);
    stOk++;
    s.bull = st.bull; s.bear = st.bear; s.posts = st.posts;
    s.sentiment = sentimentOf(st);
    s.sources.add("StockTwits");
  });
  status["StockTwits sentiment"] = stOk ? `ok (${stOk} tickers)` : "unavailable (rate limited?)";
  list = list.map(scoreStock);

  const rising = list.filter((s) => s.score > 0.05).sort((a, b) => b.rank - a.rank).slice(0, 10);
  const falling = list.filter((s) => s.score < -0.05).sort((a, b) => a.rank - b.rank).slice(0, 10);

  // Sparklines + per-ticker news for the front-page names.
  const featured = [...rising.slice(0, 6), ...falling.slice(0, 6)];
  await pool(featured, 6, async (s) => {
    if (!s.spark) s.spark = (await yahooChart(s.symbol).catch(() => ({}))).spark;
    s.news = await yahooNews(s.symbol).catch(() => []);
  });

  const market = (await pool(["^GSPC", "^IXIC", "^DJI", "^RUT", "^VIX", "BTC-USD"], 6, yahooChart)).filter(Boolean)
    .map((m) => ({ ...m, label: { "^GSPC": "S&P 500", "^IXIC": "Nasdaq", "^DJI": "Dow", "^RUT": "Russell 2000", "^VIX": "VIX", "BTC-USD": "Bitcoin" }[m.symbol] }));

  const chatter = Object.entries(ape).slice(0, 12).map(([sym, a]) => ({ symbol: sym, name: a.name, mentions: a.mentions, prev: a.prev, upvotes: a.upvotes }));

  const out = (s) => ({ ...s, sources: [...s.sources], headline: headlineFor(s) });
  return {
    generatedAt: new Date().toISOString(),
    market,
    rising: rising.map(out),
    falling: falling.map(out),
    trending: trending.slice(0, 12),
    chatter,
    socialPosts: [...reddit, ...hn],
    wire: feeds.flat().sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0)).slice(0, 24),
    status,
  };
}

async function lookup(sym) {
  sym = sym.toUpperCase();
  const status = {};
  const [chart, st, news, ape] = await Promise.all([
    safe("Yahoo chart", status, () => yahooChart(sym), null),
    safe("StockTwits", status, () => stocktwitsSentiment(sym), null),
    safe("Yahoo news", status, () => yahooNews(sym), []),
    safe("Reddit mentions", status, () => cached("ape", EDITION_TTL, apeWisdom), {}),
  ]);
  if (!chart) return { error: `Couldn't find a price for ${sym}.`, status };
  const s = { ...chart, sources: new Set(["Yahoo Finance"]) };
  if (st) { s.bull = st.bull; s.bear = st.bear; s.posts = st.posts; s.sentiment = sentimentOf(st); s.sources.add("StockTwits"); }
  if (ape[sym]) { s.mentions = ape[sym].mentions; s.mentionsPrev = ape[sym].prev; s.buzzX = ape[sym].prev ? +((ape[sym].mentions + 3) / (ape[sym].prev + 3)).toFixed(2) : null; s.sources.add("Reddit"); }
  scoreStock(s);
  return { ...s, sources: [...s.sources], headline: headlineFor(s), news, status };
}

// ---------- http ----------
const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

let building = null;
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/edition") {
      if (url.searchParams.has("fresh")) cache.delete("edition");
      building ||= cached("edition", EDITION_TTL, buildEdition).finally(() => (building = null));
      return send(res, 200, await building);
    }
    const m = url.pathname.match(/^\/api\/stock\/([A-Za-z.\-^]{1,10})$/);
    if (m) return send(res, 200, await lookup(m[1]));
    if (url.pathname === "/" || url.pathname === "/index.html")
      return send(res, 200, fs.readFileSync(path.join(__dirname, "public", "index.html")), "text/html; charset=utf-8");
    send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`The Ticker Times is on the press: http://localhost:${PORT}`));
