// Blockworks Analytics scraper for Prestocks volume by token
// This is a JavaScript-rendered dashboard

import puppeteer from 'puppeteer';

const BLOCKWORKS_URL = 'https://blockworks.co/research';

export async function fetchPrestocksVolume() {
  console.log('[Blockworks] Fetching Prestocks volume by token...');
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

    // Intercept network requests to capture API data
    const apiData = [];
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('api') || url.includes('data') || url.includes('analytics')) {
        try {
          const contentType = response.headers()['content-type'] || '';
          if (contentType.includes('json')) {
            const json = await response.json();
            apiData.push({ url, data: json });
          }
        } catch (e) {
          // Ignore non-JSON responses
        }
      }
    });

    // Navigate to the page
    await page.goto(BLOCKWORKS_URL, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Wait for content to load
    await page.waitForSelector('body', { timeout: 10000 });

    // Try to extract volume data from the page
    const data = await page.evaluate(() => {
      const results = [];

      // Look for tables or lists with volume data
      const tables = document.querySelectorAll('table');
      for (const table of tables) {
        const rows = table.querySelectorAll('tr');
        for (const row of rows) {
          const cells = row.querySelectorAll('td, th');
          const rowData = Array.from(cells).map(c => c.textContent.trim());
          if (rowData.some(d => d.includes('volume') || d.includes('$') || d.match(/\d+[MBK]/))) {
            results.push(rowData);
          }
        }
      }

      // Look for card-like elements with token names and volumes
      const cards = document.querySelectorAll('[class*="card"], [class*="token"], [class*="asset"]');
      for (const card of cards) {
        const text = card.textContent;
        const volumeMatch = text.match(/\$?([\d,.]+)\s*[MBK]?/);
        if (volumeMatch) {
          results.push({
            text: text.substring(0, 200),
            volume: volumeMatch[0],
          });
        }
      }

      return {
        tables: results.slice(0, 20),
        pageTitle: document.title,
      };
    });

    console.log(`[Blockworks] Page title: ${data.pageTitle}`);
    console.log(`[Blockworks] Found ${data.tables.length} potential data rows`);
    console.log(`[Blockworks] Intercepted ${apiData.length} API responses`);

    // Process and return the data
    const volumeByToken = [];

    // Try to parse the captured data into structured format
    for (const row of data.tables) {
      if (Array.isArray(row) && row.length >= 2) {
        volumeByToken.push({
          token: row[0],
          volume: row[1],
        });
      } else if (row.text && row.volume) {
        volumeByToken.push({
          token: row.text.split(/\s/)[0], // First word as token name
          volume: row.volume,
        });
      }
    }

    return {
      volumeByToken: volumeByToken.slice(0, 20),
      apiData: apiData.slice(0, 5),
      rawData: data,
      timestamp: Date.now(),
    };
  } catch (error) {
    console.error('[Blockworks] Scrape error:', error.message);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
