# The Ticker Times 📰

A newspaper-style investing app that tells you which stocks are **on the rise** and which are **on the downfall**, built mostly from what social media is saying, backed up by price data and the newswires.

## Run it

Needs [Node.js](https://nodejs.org) 18 or newer. No install step and no API keys.

```bash
npm start        # or: node server.js
```

Then open **http://localhost:3000**. The edition refreshes every 5 minutes, or hit **"Stop the presses ↻"** for a fresh one.

## What's on the page

| Section | What it shows |
|---|---|
| **Front page lead** | The top riser and biggest decliner, with a 20-day chart, bull/bear meter, quotes from traders and related headlines |
| **On the Rise / On the Downfall** | Up to 10 stocks each, ranked by the score below |
| **Word on the Street** | Most-mentioned tickers on Reddit in the last 24h, and how fast that's changing |
| **Trending on StockTwits** | What traders are talking about and why |
| **Letters from the Crowd** | Hot posts from Reddit and Hacker News |
| **The Newswire** | Latest headlines from MarketWatch, Nasdaq, Seeking Alpha and Google News |
| **Investigate** | Search any ticker to get a special report and a verdict |

## Where the info comes from

- **Social media (weighted the most):** StockTwits (trending list + bullish/bearish tagged posts), Reddit mention counts across r/wallstreetbets, r/stocks, r/investing and more (via ApeWisdom), Reddit hot posts, Hacker News
- **Prices:** Yahoo Finance (day gainers, losers, most active, charts, per-stock news)
- **News:** MarketWatch, Nasdaq, Seeking Alpha, Google News

If a source is down or rate-limited, the paper still prints. The footer shows which sources worked.

## How stocks get ranked

Each stock gets a score from:
- **45%** today's price move
- **35%** StockTwits sentiment (bullish vs bearish posts)
- **20%** how fast Reddit mentions are growing vs yesterday

Stocks with more social attention get pushed higher in the list. Stocks under $1 are left out because they're the easiest to pump on social media.

## ⚠️ Not financial advice

This is an automated digest of public data and online chatter. Social sentiment is noisy, easy to manipulate and often wrong. Do your own research.
