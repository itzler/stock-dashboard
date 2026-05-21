import express from 'express';
import cors from 'cors';
import cron from 'node-cron';

import { readCache, writeCache, isCacheValid, getCacheStatus } from './services/cache.js';
import { fetchKalshiVolume, fetchHyperliquidRevenue } from './services/scrapers/defillama.js';
import { fetchUSDCMarketcap } from './services/scrapers/coingecko.js';
import { fetchPrestocksPrices } from './services/scrapers/prestocks.js';
import { fetchCryptopunksPrice } from './services/scrapers/cryptopunks.js';
import { fetchRobloxCCU } from './services/scrapers/romonitor.js';
import { fetchPrestocksVolume } from './services/scrapers/blockworks.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ============== Helper Functions ==============

// Timeout wrapper for fetch functions
function withTimeout(promise, ms, fallbackValue = null) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallbackValue), ms))
  ]);
}

async function getOrFetchData(cacheKey, fetchFn, timeout = 10000) {
  // Check if cache is valid
  if (isCacheValid(cacheKey)) {
    const cached = readCache(cacheKey);
    console.log(`[API] Serving ${cacheKey} from cache`);
    return { data: cached.data, timestamp: cached.timestamp, fromCache: true };
  }

  // Fetch fresh data
  try {
    console.log(`[API] Fetching fresh ${cacheKey}...`);
    const data = await fetchFn();
    writeCache(cacheKey, data);
    return { data, timestamp: Date.now(), fromCache: false };
  } catch (error) {
    // Try to return stale cache if fetch fails
    const staleCache = readCache(cacheKey);
    if (staleCache) {
      console.log(`[API] Fetch failed, returning stale cache for ${cacheKey}`);
      return { data: staleCache.data, timestamp: staleCache.timestamp, fromCache: true, stale: true };
    }
    throw error;
  }
}

// ============== API Routes ==============

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Cache status
app.get('/api/status', (req, res) => {
  res.json(getCacheStatus());
});

// Prestocks prices (private company valuations)
app.get('/api/metrics/prestocks-prices', async (req, res) => {
  try {
    const result = await getOrFetchData('prestocks-prices', fetchPrestocksPrices);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Roblox concurrent users
app.get('/api/metrics/roblox-ccu', async (req, res) => {
  try {
    const result = await getOrFetchData('roblox-ccu', fetchRobloxCCU);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Kalshi daily volume
app.get('/api/metrics/kalshi-volume', async (req, res) => {
  try {
    const result = await getOrFetchData('kalshi-volume', fetchKalshiVolume);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Hyperliquid daily revenue
app.get('/api/metrics/hyperliquid-revenue', async (req, res) => {
  try {
    const result = await getOrFetchData('hyperliquid-revenue', fetchHyperliquidRevenue);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// USDC marketcap
app.get('/api/metrics/usdc-marketcap', async (req, res) => {
  try {
    const result = await getOrFetchData('usdc-marketcap', fetchUSDCMarketcap);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CryptoPunks price
app.get('/api/metrics/cryptopunks-price', async (req, res) => {
  try {
    const result = await getOrFetchData('cryptopunks-price', fetchCryptopunksPrice);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Prestocks volume by token
app.get('/api/metrics/prestocks-volume', async (req, res) => {
  try {
    const result = await getOrFetchData('prestocks-volume', fetchPrestocksVolume);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch all metrics at once (with fast timeouts for non-critical scrapers)
app.get('/api/metrics/all', async (req, res) => {
  try {
    // API-based fetches are fast (8s). Puppeteer-rendered scrapes (Roblox CCU,
    // CryptoPunks, Prestocks volume) need much longer to launch a browser, render
    // the page, and extract data - give them 25s so they can populate the cache.
    const API_TIMEOUT = 8000;
    const PUPPETEER_TIMEOUT = 25000;
    const [
      prestocksPrices,
      robloxCCU,
      kalshiVolume,
      hyperliquidRevenue,
      usdcMarketcap,
      cryptopunksPrice,
      prestocksVolume,
    ] = await Promise.allSettled([
      withTimeout(getOrFetchData('prestocks-prices', fetchPrestocksPrices), API_TIMEOUT, { data: null, error: 'timeout' }),
      withTimeout(getOrFetchData('roblox-ccu', fetchRobloxCCU), PUPPETEER_TIMEOUT, { data: null, error: 'timeout' }),
      withTimeout(getOrFetchData('kalshi-volume', fetchKalshiVolume), API_TIMEOUT, { data: null, error: 'timeout' }),
      withTimeout(getOrFetchData('hyperliquid-revenue', fetchHyperliquidRevenue), API_TIMEOUT, { data: null, error: 'timeout' }),
      withTimeout(getOrFetchData('usdc-marketcap', fetchUSDCMarketcap), API_TIMEOUT, { data: null, error: 'timeout' }),
      withTimeout(getOrFetchData('cryptopunks-price', fetchCryptopunksPrice), PUPPETEER_TIMEOUT, { data: null, error: 'timeout' }),
      withTimeout(getOrFetchData('prestocks-volume', fetchPrestocksVolume), PUPPETEER_TIMEOUT, { data: null, error: 'timeout' }),
    ]);

    res.json({
      prestocksPrices: prestocksPrices.status === 'fulfilled' ? prestocksPrices.value : { error: prestocksPrices.reason?.message },
      robloxCCU: robloxCCU.status === 'fulfilled' ? robloxCCU.value : { error: robloxCCU.reason?.message },
      kalshiVolume: kalshiVolume.status === 'fulfilled' ? kalshiVolume.value : { error: kalshiVolume.reason?.message },
      hyperliquidRevenue: hyperliquidRevenue.status === 'fulfilled' ? hyperliquidRevenue.value : { error: hyperliquidRevenue.reason?.message },
      usdcMarketcap: usdcMarketcap.status === 'fulfilled' ? usdcMarketcap.value : { error: usdcMarketcap.reason?.message },
      cryptopunksPrice: cryptopunksPrice.status === 'fulfilled' ? cryptopunksPrice.value : { error: cryptopunksPrice.reason?.message },
      prestocksVolume: prestocksVolume.status === 'fulfilled' ? prestocksVolume.value : { error: prestocksVolume.reason?.message },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Manual refresh endpoint
app.post('/api/refresh/:source', async (req, res) => {
  const { source } = req.params;

  const scrapers = {
    'prestocks-prices': fetchPrestocksPrices,
    'roblox-ccu': fetchRobloxCCU,
    'kalshi-volume': fetchKalshiVolume,
    'hyperliquid-revenue': fetchHyperliquidRevenue,
    'usdc-marketcap': fetchUSDCMarketcap,
    'cryptopunks-price': fetchCryptopunksPrice,
    'prestocks-volume': fetchPrestocksVolume,
  };

  if (!scrapers[source]) {
    return res.status(400).json({ error: `Unknown source: ${source}` });
  }

  try {
    console.log(`[API] Manual refresh triggered for ${source}`);
    const data = await scrapers[source]();
    writeCache(source, data);
    res.json({ success: true, data, timestamp: Date.now() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Refresh all sources
app.post('/api/refresh/all', async (req, res) => {
  console.log('[API] Manual refresh triggered for all sources');

  const results = {};
  const scrapers = {
    'kalshi-volume': fetchKalshiVolume,
    'hyperliquid-revenue': fetchHyperliquidRevenue,
    'usdc-marketcap': fetchUSDCMarketcap,
    'prestocks-prices': fetchPrestocksPrices,
    'cryptopunks-price': fetchCryptopunksPrice,
    'roblox-ccu': fetchRobloxCCU,
    'prestocks-volume': fetchPrestocksVolume,
  };

  for (const [key, scraper] of Object.entries(scrapers)) {
    try {
      const data = await scraper();
      writeCache(key, data);
      results[key] = { success: true };
    } catch (error) {
      results[key] = { success: false, error: error.message };
    }
  }

  res.json({ results, timestamp: Date.now() });
});

// ============== Scheduled Jobs ==============

// Refresh API sources every 12 hours (0:00, 12:00)
cron.schedule('0 0,12 * * *', async () => {
  console.log('[Scheduler] Running 12-hour API refresh...');

  try {
    const kalshi = await fetchKalshiVolume();
    writeCache('kalshi-volume', kalshi);
  } catch (e) {
    console.error('[Scheduler] Kalshi refresh failed:', e.message);
  }

  try {
    const hyperliquid = await fetchHyperliquidRevenue();
    writeCache('hyperliquid-revenue', hyperliquid);
  } catch (e) {
    console.error('[Scheduler] Hyperliquid refresh failed:', e.message);
  }

  try {
    const usdc = await fetchUSDCMarketcap();
    writeCache('usdc-marketcap', usdc);
  } catch (e) {
    console.error('[Scheduler] USDC refresh failed:', e.message);
  }
});

// Refresh scraping sources every 6 hours (0:00, 6:00, 12:00, 18:00)
cron.schedule('0 0,6,12,18 * * *', async () => {
  console.log('[Scheduler] Running 6-hour scraper refresh...');

  try {
    const prestocks = await fetchPrestocksPrices();
    writeCache('prestocks-prices', prestocks);
  } catch (e) {
    console.error('[Scheduler] Prestocks prices refresh failed:', e.message);
  }

  try {
    const cryptopunks = await fetchCryptopunksPrice();
    writeCache('cryptopunks-price', cryptopunks);
  } catch (e) {
    console.error('[Scheduler] CryptoPunks refresh failed:', e.message);
  }

  try {
    const roblox = await fetchRobloxCCU();
    writeCache('roblox-ccu', roblox);
  } catch (e) {
    console.error('[Scheduler] Roblox CCU refresh failed:', e.message);
  }

  try {
    const volume = await fetchPrestocksVolume();
    writeCache('prestocks-volume', volume);
  } catch (e) {
    console.error('[Scheduler] Prestocks volume refresh failed:', e.message);
  }
});

// ============== Start Server ==============

app.listen(PORT, () => {
  console.log(`[Server] Alternative Metrics API running on port ${PORT}`);
  console.log(`[Server] Endpoints:`);
  console.log(`  GET  /api/health`);
  console.log(`  GET  /api/status`);
  console.log(`  GET  /api/metrics/all`);
  console.log(`  GET  /api/metrics/prestocks-prices`);
  console.log(`  GET  /api/metrics/roblox-ccu`);
  console.log(`  GET  /api/metrics/kalshi-volume`);
  console.log(`  GET  /api/metrics/hyperliquid-revenue`);
  console.log(`  GET  /api/metrics/usdc-marketcap`);
  console.log(`  GET  /api/metrics/cryptopunks-price`);
  console.log(`  GET  /api/metrics/prestocks-volume`);
  console.log(`  POST /api/refresh/:source`);
  console.log(`  POST /api/refresh/all`);
});
