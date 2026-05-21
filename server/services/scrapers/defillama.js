// DefiLlama API client for Kalshi volume and Hyperliquid revenue
import fetch from 'node-fetch';

const KALSHI_API = 'https://api.llama.fi/summary/dexs/kalshi';
const HYPERLIQUID_API = 'https://api.llama.fi/summary/fees/hyperliquid';

export async function fetchKalshiVolume() {
  console.log('[DefiLlama] Fetching Kalshi volume...');
  try {
    const response = await fetch(KALSHI_API, {
      headers: {
        'User-Agent': 'StockDashboard/1.0',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const json = await response.json();

    // Extract totalDataChart - array of [timestamp, volume]
    const chartData = json.totalDataChart || [];

    // Filter from September 2025 (timestamp: 1725148800 = Sept 1, 2025)
    const sept2025 = 1725148800;
    const filteredData = chartData
      .filter(([ts]) => ts >= sept2025)
      .map(([timestamp, volume]) => ({
        date: new Date(timestamp * 1000).toISOString().split('T')[0],
        timestamp: timestamp,
        volume: volume,
      }));

    console.log(`[DefiLlama] Kalshi: Found ${filteredData.length} days of data from Sept 2025`);
    return filteredData;
  } catch (error) {
    console.error('[DefiLlama] Kalshi fetch error:', error.message);
    throw error;
  }
}

export async function fetchHyperliquidRevenue() {
  console.log('[DefiLlama] Fetching Hyperliquid revenue...');
  try {
    const response = await fetch(HYPERLIQUID_API, {
      headers: {
        'User-Agent': 'StockDashboard/1.0',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const json = await response.json();

    // Extract totalDataChart for revenue/fees
    const chartData = json.totalDataChart || [];

    const data = chartData.map(([timestamp, revenue]) => ({
      date: new Date(timestamp * 1000).toISOString().split('T')[0],
      timestamp: timestamp,
      revenue: revenue,
    }));

    console.log(`[DefiLlama] Hyperliquid: Found ${data.length} days of revenue data`);
    return data;
  } catch (error) {
    console.error('[DefiLlama] Hyperliquid fetch error:', error.message);
    throw error;
  }
}
