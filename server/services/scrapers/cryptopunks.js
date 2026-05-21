// CryptoPunks floor price scraper
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { fetchETHPrice } from './coingecko.js';

const CRYPTOPUNKS_URL = 'https://cryptopunks.app';

export async function fetchCryptopunksPrice() {
  console.log('[CryptoPunks] Fetching floor price...');
  try {
    const response = await fetch(CRYPTOPUNKS_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    let floorPriceETH = null;

    // Look for floor price in various common locations
    // Common patterns: "Floor: 33.98 ETH", "floor price", etc.
    const bodyText = $('body').text();

    // Try multiple regex patterns
    const patterns = [
      /floor[:\s]*(\d+\.?\d*)\s*eth/i,
      /(\d+\.?\d*)\s*eth\s*floor/i,
      /floor\s*price[:\s]*(\d+\.?\d*)/i,
      /lowest[:\s]*(\d+\.?\d*)\s*eth/i,
    ];

    for (const pattern of patterns) {
      const match = bodyText.match(pattern);
      if (match) {
        floorPriceETH = parseFloat(match[1]);
        break;
      }
    }

    // Also try looking for specific elements
    if (!floorPriceETH) {
      $('[class*="floor"], [class*="price"], [class*="stat"]').each((_, el) => {
        const text = $(el).text();
        const match = text.match(/(\d+\.?\d*)\s*eth/i);
        if (match && !floorPriceETH) {
          floorPriceETH = parseFloat(match[1]);
        }
      });
    }

    // Fetch current ETH price for USD conversion
    let ethPrice = null;
    let floorPriceUSD = null;

    try {
      ethPrice = await fetchETHPrice();
      if (floorPriceETH && ethPrice) {
        floorPriceUSD = floorPriceETH * ethPrice;
      }
    } catch (e) {
      console.log('[CryptoPunks] Could not fetch ETH price for USD conversion');
    }

    console.log(`[CryptoPunks] Floor price: ${floorPriceETH} ETH ($${floorPriceUSD?.toFixed(2)})`);

    return {
      floorPriceETH: floorPriceETH,
      floorPriceUSD: floorPriceUSD,
      ethPrice: ethPrice,
      timestamp: Date.now(),
    };
  } catch (error) {
    console.error('[CryptoPunks] Fetch error:', error.message);
    throw error;
  }
}
