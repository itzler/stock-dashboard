// Prestocks.com scraper for private company valuations
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

const PRESTOCKS_URL = 'https://prestocks.com/products';

// Companies we want to track
const TARGET_COMPANIES = [
  'SpaceX',
  'Anthropic',
  'OpenAI',
  'Kalshi',
  'Anduril',
  'Neuralink',
];

export async function fetchPrestocksPrices() {
  console.log('[Prestocks] Fetching private company prices...');
  try {
    const response = await fetch(PRESTOCKS_URL, {
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

    const companies = [];

    // Parse company cards - structure may vary, need to inspect actual HTML
    // Common patterns: product cards with name, price, valuation
    $('[class*="product"], [class*="card"], [class*="item"]').each((_, el) => {
      const card = $(el);
      const text = card.text().toLowerCase();

      for (const company of TARGET_COMPANIES) {
        if (text.includes(company.toLowerCase())) {
          // Try to extract valuation/price from card
          const cardText = card.text();

          // Look for dollar amounts (e.g., "$350B", "$60.5B", "$150M")
          const valuationMatch = cardText.match(/\$[\d,.]+\s*[BMK]?(?:illion)?/gi);
          const priceMatch = cardText.match(/\$[\d,.]+(?:\.\d{2})?(?!\s*[BMK])/gi);

          companies.push({
            company: company,
            valuation: valuationMatch ? valuationMatch[0] : null,
            pricePerShare: priceMatch ? priceMatch[0] : null,
            raw: cardText.substring(0, 200), // Store raw text for debugging
          });
          break;
        }
      }
    });

    // If structured parsing fails, try a more generic approach
    if (companies.length === 0) {
      console.log('[Prestocks] Structured parsing failed, trying generic approach...');

      // Look for any text containing company names
      const bodyText = $('body').text();

      for (const company of TARGET_COMPANIES) {
        const regex = new RegExp(`${company}[^]*?\\$[\\d,.]+\\s*[BMK]?`, 'i');
        const match = bodyText.match(regex);

        companies.push({
          company: company,
          valuation: match ? match[0].match(/\$[\d,.]+\s*[BMK]?/i)?.[0] : null,
          pricePerShare: null,
          found: !!match,
        });
      }
    }

    console.log(`[Prestocks] Found data for ${companies.filter(c => c.valuation).length}/${TARGET_COMPANIES.length} companies`);
    return companies;
  } catch (error) {
    console.error('[Prestocks] Fetch error:', error.message);
    throw error;
  }
}
