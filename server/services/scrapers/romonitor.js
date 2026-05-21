// RoMonitor Stats scraper for Roblox concurrent users
// This site is JavaScript-rendered, so we need Puppeteer

import puppeteer from 'puppeteer';

const ROMONITOR_URL = 'https://romonitorstats.com/';

export async function fetchRobloxCCU() {
  console.log('[RoMonitor] Fetching Roblox concurrent users...');
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

    // Set viewport and user agent
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Navigate to the page
    await page.goto(ROMONITOR_URL, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Wait for content to load
    await page.waitForSelector('body', { timeout: 10000 });

    // Try to find CCU data - look for charts or stats
    const data = await page.evaluate(() => {
      const bodyText = document.body.innerText || '';

      // Normalize a matched figure into an absolute user count.
      // Handles "5.2 million", "5.2M", and "5,234,123".
      const normalize = (numStr, suffix) => {
        const n = parseFloat(numStr.replace(/,/g, ''));
        if (isNaN(n)) return null;
        const s = (suffix || '').toLowerCase();
        if (s.startsWith('m')) return n * 1e6; // million / M
        if (s.startsWith('k')) return n * 1e3;
        return n;
      };

      const results = [];
      // Prefer figures explicitly tied to concurrent users / players online
      const ccuPattern = /(\d+(?:,\d+)*(?:\.\d+)?)\s*(million|thousand|m|k)?\s*(?:concurrent|players|users|online)/gi;
      let match;
      while ((match = ccuPattern.exec(bodyText)) !== null) {
        const value = normalize(match[1], match[2]);
        if (value && value >= 10000) {
          results.push({
            value,
            context: bodyText.substring(Math.max(0, match.index - 50), match.index + 100),
          });
        }
      }

      // Fallback: any "<n> million" figure on the page
      if (results.length === 0) {
        const millionPattern = /(\d+(?:\.\d+)?)\s*(million|m)\b/gi;
        let m2;
        while ((m2 = millionPattern.exec(bodyText)) !== null) {
          const value = normalize(m2[1], m2[2]);
          if (value && value >= 100000) results.push({ value });
        }
      }

      // The platform-wide CCU is the largest plausible figure on the page
      const best = results.reduce((max, r) => (r.value > (max?.value || 0) ? r : max), null);

      return {
        currentCCU: best ? best.value : null,
        rawMatches: results.slice(0, 5),
        pageTitle: document.title,
      };
    });

    console.log(`[RoMonitor] Page title: ${data.pageTitle}`);
    console.log(`[RoMonitor] Found CCU: ${data.currentCCU || 'Not found'}`);

    // For historical data, we may need to intercept API calls or navigate to specific charts
    // Return what we found
    return {
      currentCCU: data.currentCCU || null,
      historical: [], // Would need more specific scraping for historical chart data
      rawData: data,
      timestamp: Date.now(),
    };
  } catch (error) {
    console.error('[RoMonitor] Scrape error:', error.message);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
