// Prestocks.com scraper for private company valuations
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

const PRESTOCKS_BASE = 'https://prestocks.com';
// Shopify storefronts expose a structured products feed at /products.json
const PRESTOCKS_PRODUCTS_JSON = `${PRESTOCKS_BASE}/products.json?limit=250`;
const PRESTOCKS_PRODUCTS_HTML = `${PRESTOCKS_BASE}/products`;

// Companies we want to track
const TARGET_COMPANIES = [
  'SpaceX',
  'Anthropic',
  'OpenAI',
  'Kalshi',
  'Anduril',
  'Neuralink',
];

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
};

// Convert a dollar string like "$1.9T", "$350B", "$150M" into a number for comparison
function parseDollarMagnitude(str) {
  if (!str) return 0;
  const m = str.match(/\$?\s*([\d,.]+)\s*(t|b|m|k|trillion|billion|million|thousand)?/i);
  if (!m) return 0;
  const num = parseFloat(m[1].replace(/,/g, ''));
  if (isNaN(num)) return 0;
  const suffix = (m[2] || '').toLowerCase();
  const mult = suffix.startsWith('t') ? 1e12
    : suffix.startsWith('b') ? 1e9
    : suffix.startsWith('m') ? 1e6
    : suffix.startsWith('k') || suffix.startsWith('thousand') ? 1e3
    : 1;
  return num * mult;
}

// Pick the most likely "valuation" string from a blob of text.
// Valuations are large headline figures, so prefer the biggest amount that
// carries a magnitude suffix (T/B/M) and ignore small per-share dollar prices.
function extractValuation(text) {
  if (!text) return null;
  const matches = text.match(/\$\s?[\d,.]+\s*(?:T|B|M|trillion|billion|million)\b/gi) || [];
  if (matches.length === 0) return null;
  let best = matches[0];
  let bestVal = parseDollarMagnitude(best);
  for (const candidate of matches) {
    const val = parseDollarMagnitude(candidate);
    if (val > bestVal) {
      best = candidate;
      bestVal = val;
    }
  }
  // Normalize "$1.4 trillion" -> "$1.4T" for clean display
  return best
    .replace(/\s+/g, '')
    .replace(/trillion/i, 'T')
    .replace(/billion/i, 'B')
    .replace(/million/i, 'M');
}

// Parse the Shopify products.json feed
async function fetchFromProductsJson() {
  const response = await fetch(PRESTOCKS_PRODUCTS_JSON, { headers: BROWSER_HEADERS });
  if (!response.ok) {
    throw new Error(`products.json HTTP ${response.status}`);
  }
  const json = await response.json();
  const products = json.products || [];
  if (products.length === 0) return [];

  const companies = [];
  for (const company of TARGET_COMPANIES) {
    const needle = company.toLowerCase();
    const product = products.find(p =>
      (p.title || '').toLowerCase().includes(needle) ||
      (p.handle || '').toLowerCase().includes(needle) ||
      (p.tags || []).some(t => String(t).toLowerCase().includes(needle))
    );

    if (!product) {
      companies.push({ company, valuation: null, pricePerShare: null, found: false });
      continue;
    }

    // Strip HTML from the description so the valuation regex sees plain text
    const bodyText = cheerio.load(product.body_html || '').text();
    const haystack = `${product.title || ''} ${bodyText} ${(product.tags || []).join(' ')}`;
    const valuation = extractValuation(haystack);

    // Shopify variant prices are strings in major currency units (e.g. "12.50")
    const variant = (product.variants || [])[0];
    const priceNum = variant ? parseFloat(variant.price) : NaN;
    const pricePerShare = !isNaN(priceNum) ? `$${priceNum.toFixed(2)}` : null;

    companies.push({
      company,
      valuation,
      pricePerShare,
      found: true,
    });
  }

  return companies;
}

// Fallback: scrape the rendered products HTML page
async function fetchFromHtml() {
  const response = await fetch(PRESTOCKS_PRODUCTS_HTML, { headers: BROWSER_HEADERS });
  if (!response.ok) {
    throw new Error(`products HTML HTTP ${response.status}`);
  }
  const html = await response.text();
  const $ = cheerio.load(html);
  const bodyText = $('body').text();

  const companies = [];
  for (const company of TARGET_COMPANIES) {
    // Grab a window of text around the company name and pull the valuation from it
    const idx = bodyText.toLowerCase().indexOf(company.toLowerCase());
    let valuation = null;
    if (idx !== -1) {
      const window = bodyText.slice(idx, idx + 400);
      valuation = extractValuation(window);
    }
    companies.push({
      company,
      valuation,
      pricePerShare: null,
      found: idx !== -1,
    });
  }
  return companies;
}

export async function fetchPrestocksPrices() {
  console.log('[Prestocks] Fetching private company prices...');

  let companies = [];
  try {
    companies = await fetchFromProductsJson();
    console.log(`[Prestocks] products.json: ${companies.filter(c => c.valuation).length}/${TARGET_COMPANIES.length} valuations`);
  } catch (error) {
    console.log(`[Prestocks] products.json failed (${error.message}), falling back to HTML scrape`);
  }

  // Fall back to HTML if the JSON feed produced nothing useful
  if (!companies.some(c => c.valuation)) {
    try {
      companies = await fetchFromHtml();
      console.log(`[Prestocks] HTML scrape: ${companies.filter(c => c.valuation).length}/${TARGET_COMPANIES.length} valuations`);
    } catch (error) {
      console.error('[Prestocks] Fetch error:', error.message);
      if (companies.length === 0) throw error;
    }
  }

  return companies;
}
