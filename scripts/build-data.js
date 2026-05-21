// Generates all the static JSON the dashboard needs for a backend-less
// (GitHub Pages) deploy. Runs in CI before `vite build`, writing into public/data
// which Vite then copies into dist/. Tolerant of individual failures: a source
// that errors just produces null/empty data rather than failing the whole build.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

import { fetchKalshiVolume, fetchHyperliquidRevenue } from '../server/services/scrapers/defillama.js';
import { fetchUSDCMarketcap } from '../server/services/scrapers/coingecko.js';
import { fetchPrestocksPrices } from '../server/services/scrapers/prestocks.js';
import { fetchCryptopunksPrice } from '../server/services/scrapers/cryptopunks.js';
import { fetchRobloxCCU } from '../server/services/scrapers/romonitor.js';
import { fetchPrestocksVolume } from '../server/services/scrapers/blockworks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../public/data');
const SEC_DIR = path.join(DATA_DIR, 'sec');
const YAHOO_DIR = path.join(DATA_DIR, 'yahoo');

// Ticker -> CIK (must match the map in src/App.jsx)
const TICKERS = {
  RBLX: '0001315098',
  CPNG: '0001834584',
  HOOD: '0001783879',
  COIN: '0001679788',
  UBER: '0001543151',
  RDDT: '0001713445',
  IBKR: '0001381197',
  SPOT: '0001639920',
  FIG: '0001579878',
};

const SEC_HEADERS = { 'User-Agent': 'StockDashboard/1.0 (dashboard@example.com)', 'Accept': 'application/json' };
const YAHOO_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDirs() {
  for (const dir of [DATA_DIR, SEC_DIR, YAHOO_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data));
}

async function runSafe(label, fn) {
  try {
    const data = await fn();
    console.log(`[build-data] ${label}: ok`);
    return data;
  } catch (err) {
    console.error(`[build-data] ${label}: FAILED - ${err.message}`);
    return null;
  }
}

// ---- Stock data (SEC + Yahoo) ----

async function bakeSecFacts() {
  for (const [ticker, cik] of Object.entries(TICKERS)) {
    await runSafe(`SEC ${ticker}`, async () => {
      const res = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers: SEC_HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      fs.writeFileSync(path.join(SEC_DIR, `CIK${cik}.json`), text);
    });
    await sleep(250); // be polite to SEC (max ~10 req/s)
  }
}

async function fetchYahooChart(ticker, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`;
  const res = await fetch(url, { headers: YAHOO_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function bakeYahooHistory() {
  for (const ticker of Object.keys(TICKERS)) {
    await runSafe(`Yahoo history ${ticker}`, async () => {
      const json = await fetchYahooChart(ticker, '5y', '1mo');
      writeJson(path.join(YAHOO_DIR, `${ticker}.json`), json);
    });
    await sleep(200);
  }
}

async function bakeCurrentPrices() {
  const prices = {};
  for (const ticker of Object.keys(TICKERS)) {
    await runSafe(`Yahoo price ${ticker}`, async () => {
      const json = await fetchYahooChart(ticker, '5d', '1d');
      const result = json?.chart?.result?.[0];
      const closes = result?.indicators?.quote?.[0]?.close || [];
      const last = [...closes].reverse().find((c) => c != null);
      const meta = result?.meta?.regularMarketPrice;
      const price = meta ?? last ?? null;
      if (price != null) prices[ticker] = price;
    });
    await sleep(150);
  }
  writeJson(path.join(DATA_DIR, 'prices.json'), prices);
}

// ---- Alternative metrics ----

async function bakeMetrics() {
  const [kalshi, hyperliquid, usdc, prestocksPrices, cryptopunks, roblox, prestocksVolume] = await Promise.all([
    runSafe('Kalshi volume', fetchKalshiVolume),
    runSafe('Hyperliquid revenue', fetchHyperliquidRevenue),
    runSafe('USDC marketcap', fetchUSDCMarketcap),
    runSafe('Prestocks prices', fetchPrestocksPrices),
    runSafe('CryptoPunks floor', fetchCryptopunksPrice),
    runSafe('Roblox CCU', fetchRobloxCCU),
    runSafe('Prestocks volume', fetchPrestocksVolume),
  ]);

  const metrics = {
    kalshiVolume: { data: kalshi },
    hyperliquidRevenue: { data: hyperliquid },
    usdcMarketcap: { data: usdc },
    prestocksPrices: { data: prestocksPrices },
    cryptopunksPrice: { data: cryptopunks },
    robloxCCU: { data: roblox },
    prestocksVolume: { data: prestocksVolume },
    generatedAt: Date.now(),
  };
  writeJson(path.join(DATA_DIR, 'metrics.json'), metrics);
}

async function main() {
  ensureDirs();
  console.log('[build-data] Generating static data...');
  // SEC and Yahoo are politeness-rate-limited, so run sequentially; metrics in parallel.
  await bakeSecFacts();
  await bakeYahooHistory();
  await bakeCurrentPrices();
  await bakeMetrics();
  console.log('[build-data] Done.');
}

main().catch((err) => {
  // Never fail the deploy because of a data hiccup - ship with whatever we have.
  console.error('[build-data] Unexpected error:', err);
  process.exit(0);
});
