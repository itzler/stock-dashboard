// Blockworks Analytics scraper for Prestocks spot volume by token
// This is a JavaScript-rendered dashboard, so we render with Puppeteer and also
// intercept any JSON API responses that carry per-token volume data.

import puppeteer from 'puppeteer';

const BLOCKWORKS_URL = 'https://blockworks.co/research';

// Convert a money string like "$1.2M", "3,400,000", "$950K" into a number
function parseMoney(str) {
  if (str == null) return null;
  if (typeof str === 'number') return isFinite(str) ? str : null;
  const m = String(str).match(/\$?\s*([\d,]+(?:\.\d+)?)\s*(t|b|m|k)?/i);
  if (!m) return null;
  const num = parseFloat(m[1].replace(/,/g, ''));
  if (isNaN(num)) return null;
  const s = (m[2] || '').toLowerCase();
  const mult = s === 't' ? 1e12 : s === 'b' ? 1e9 : s === 'm' ? 1e6 : s === 'k' ? 1e3 : 1;
  return num * mult;
}

// Pull {token, volume} pairs out of an arbitrary intercepted JSON payload
function extractVolumeFromJson(node, out, depth = 0) {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) {
    for (const item of node) extractVolumeFromJson(item, out, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    const keys = Object.keys(node);
    const tokenKey = keys.find(k => /^(token|symbol|name|asset|ticker)$/i.test(k));
    const volKey = keys.find(k => /vol(ume)?/i.test(k));
    if (tokenKey && volKey) {
      const vol = parseMoney(node[volKey]);
      const token = String(node[tokenKey]).trim();
      if (token && vol != null && vol > 0) {
        out.push({ token, volume: vol });
      }
    }
    for (const k of keys) extractVolumeFromJson(node[k], out, depth + 1);
  }
}

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
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Intercept JSON API responses that may carry per-token volume
    const jsonPayloads = [];
    page.on('response', async (response) => {
      const url = response.url();
      if (/api|data|analytics|volume|chart/i.test(url)) {
        try {
          const contentType = response.headers()['content-type'] || '';
          if (contentType.includes('json')) {
            jsonPayloads.push(await response.json());
          }
        } catch (e) {
          // Ignore non-JSON / unreadable responses
        }
      }
    });

    await page.goto(BLOCKWORKS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('body', { timeout: 10000 });

    // First choice: structured data from intercepted JSON
    let volumeByToken = [];
    for (const payload of jsonPayloads) {
      extractVolumeFromJson(payload, volumeByToken);
    }

    // Fallback: parse any table that looks like token + volume rows
    if (volumeByToken.length === 0) {
      const rows = await page.evaluate(() => {
        const out = [];
        for (const table of document.querySelectorAll('table')) {
          for (const row of table.querySelectorAll('tr')) {
            const cells = Array.from(row.querySelectorAll('td')).map(c => c.textContent.trim());
            if (cells.length >= 2) out.push(cells);
          }
        }
        return out;
      });

      for (const cells of rows) {
        const token = cells[0];
        // Find the first cell that parses as a dollar/volume figure
        const volCell = cells.slice(1).find(c => /[\d.]/.test(c));
        const volume = volCell ? volCell : null;
        if (token && volume) {
          volumeByToken.push({ token, volume });
        }
      }
      // Normalize string volumes to numbers
      volumeByToken = volumeByToken
        .map(({ token, volume }) => ({ token, volume: parseMoney(volume) }))
        .filter(v => v.volume != null && v.volume > 0);
    }

    // De-dupe by token (keep largest volume) and sort descending
    const byToken = new Map();
    for (const { token, volume } of volumeByToken) {
      if (!byToken.has(token) || volume > byToken.get(token)) {
        byToken.set(token, volume);
      }
    }
    const result = Array.from(byToken.entries())
      .map(([token, volume]) => ({ token, volume }))
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 20);

    console.log(`[Blockworks] Extracted ${result.length} token volume entries (${jsonPayloads.length} JSON payloads intercepted)`);

    return {
      volumeByToken: result,
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
