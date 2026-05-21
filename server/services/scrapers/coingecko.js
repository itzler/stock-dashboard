// CoinGecko API client for USDC marketcap
import fetch from 'node-fetch';

const COINGECKO_API = 'https://api.coingecko.com/api/v3';

// Only keep data points from this date onward
const USDC_START_DATE = '2019-01-01';

export async function fetchUSDCMarketcap() {
  console.log('[CoinGecko] Fetching USDC marketcap...');
  try {
    // Fetch full available history; we filter down to USDC_START_DATE below.
    // daily granularity is returned automatically for ranges > 90 days.
    const url = `${COINGECKO_API}/coins/usd-coin/market_chart?vs_currency=usd&days=max`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'StockDashboard/1.0',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const json = await response.json();

    // Extract market_caps array - [timestamp_ms, marketcap]
    const marketCaps = json.market_caps || [];

    // Sample to daily data and filter to start date
    const dailyData = [];
    let lastDate = '';

    for (const [timestamp, marketcap] of marketCaps) {
      const date = new Date(timestamp).toISOString().split('T')[0];
      if (date < USDC_START_DATE) continue;
      if (date !== lastDate) {
        dailyData.push({
          date: date,
          timestamp: Math.floor(timestamp / 1000),
          marketcap: marketcap,
        });
        lastDate = date;
      }
    }

    console.log(`[CoinGecko] USDC: Found ${dailyData.length} days of marketcap data since ${USDC_START_DATE}`);
    return dailyData;
  } catch (error) {
    console.error('[CoinGecko] USDC fetch error:', error.message);
    throw error;
  }
}

export async function fetchETHPrice() {
  console.log('[CoinGecko] Fetching ETH price...');
  try {
    const url = `${COINGECKO_API}/simple/price?ids=ethereum&vs_currencies=usd`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'StockDashboard/1.0',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const json = await response.json();
    return json.ethereum?.usd || null;
  } catch (error) {
    console.error('[CoinGecko] ETH price fetch error:', error.message);
    throw error;
  }
}
