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
      const results = [];

      // Look for any chart data in the page
      // Common patterns: canvas elements, SVG charts, data attributes
      const bodyText = document.body.innerText;

      // Extract any numbers that look like CCU (millions of users)
      const ccuPattern = /(\d+(?:,\d+)*(?:\.\d+)?)\s*(?:million|M|concurrent|players|users)/gi;
      let match;
      while ((match = ccuPattern.exec(bodyText)) !== null) {
        results.push({
          value: match[1].replace(/,/g, ''),
          context: bodyText.substring(Math.max(0, match.index - 50), match.index + 100),
        });
      }

      // Also try to find chart data objects
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const content = script.textContent || '';
        if (content.includes('chart') || content.includes('data')) {
          // Look for array-like data structures
          const dataMatch = content.match(/data\s*:\s*\[([\d,.\s\[\]]+)\]/);
          if (dataMatch) {
            results.push({ chartData: dataMatch[1].substring(0, 500) });
          }
        }
      }

      return {
        currentCCU: results[0]?.value || null,
        rawMatches: results.slice(0, 5),
        pageTitle: document.title,
      };
    });

    console.log(`[RoMonitor] Page title: ${data.pageTitle}`);
    console.log(`[RoMonitor] Found CCU: ${data.currentCCU || 'Not found'}`);

    // For historical data, we may need to intercept API calls or navigate to specific charts
    // Return what we found
    return {
      currentCCU: data.currentCCU ? parseFloat(data.currentCCU) : null,
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
