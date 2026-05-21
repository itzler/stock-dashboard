// CryptoPunks floor price scraper
// cryptopunks.app is a JavaScript-rendered SPA, so a plain HTML fetch returns
// no real floor price. We render it with Puppeteer and extract the floor.
import puppeteer from 'puppeteer';
import { fetchETHPrice } from './coingecko.js';

const CRYPTOPUNKS_URL = 'https://cryptopunks.app/cryptopunks/forsale';

export async function fetchCryptopunksPrice() {
  console.log('[CryptoPunks] Fetching floor price...');
  let browser = null;

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await page.goto(CRYPTOPUNKS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('body', { timeout: 10000 });

    const floorPriceETH = await page.evaluate(() => {
      const bodyText = document.body.innerText || '';

      // Prefer an explicitly labelled floor / lowest-ask figure
      const labelled = [
        /floor[:\s]*Ξ?\s*(\d+(?:\.\d+)?)\s*(?:eth|Ξ)/i,
        /(\d+(?:\.\d+)?)\s*(?:eth|Ξ)\s*floor/i,
        /lowest[^0-9]{0,20}(\d+(?:\.\d+)?)\s*(?:eth|Ξ)/i,
        /cheapest[^0-9]{0,20}(\d+(?:\.\d+)?)\s*(?:eth|Ξ)/i,
      ];
      for (const re of labelled) {
        const m = bodyText.match(re);
        if (m) {
          const v = parseFloat(m[1]);
          if (!isNaN(v) && v > 0) return v;
        }
      }

      // Fallback: collect every "<n> ETH" amount and take the smallest plausible
      // one (the floor is the lowest ask). Filter out tiny/huge noise values and
      // the "10,000" total-supply figure.
      const amounts = [];
      const re = /Ξ?\s*([\d,]+(?:\.\d+)?)\s*(?:eth|Ξ)/gi;
      let match;
      while ((match = re.exec(bodyText)) !== null) {
        const v = parseFloat(match[1].replace(/,/g, ''));
        if (!isNaN(v) && v >= 1 && v <= 100000) amounts.push(v);
      }
      const plausible = amounts.filter(v => v >= 5 && v <= 10000);
      if (plausible.length > 0) return Math.min(...plausible);
      return null;
    });

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
      floorPriceETH,
      floorPriceUSD,
      ethPrice,
      timestamp: Date.now(),
    };
  } catch (error) {
    console.error('[CryptoPunks] Scrape error:', error.message);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
