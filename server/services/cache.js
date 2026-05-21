import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '../data/cache');

// Cache TTL in milliseconds
const CACHE_TTL = {
  'prestocks-prices': 6 * 60 * 60 * 1000,      // 6 hours
  'roblox-ccu': 6 * 60 * 60 * 1000,            // 6 hours
  'kalshi-volume': 12 * 60 * 60 * 1000,        // 12 hours
  'hyperliquid-revenue': 12 * 60 * 60 * 1000,  // 12 hours
  'usdc-marketcap': 12 * 60 * 60 * 1000,       // 12 hours
  'cryptopunks-price': 6 * 60 * 60 * 1000,     // 6 hours
  'prestocks-volume': 6 * 60 * 60 * 1000,      // 6 hours
};

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

export function readCache(key) {
  const filePath = path.join(CACHE_DIR, `${key}.json`);
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.error(`[Cache] Error reading ${key}:`, error.message);
  }
  return null;
}

export function writeCache(key, data) {
  const filePath = path.join(CACHE_DIR, `${key}.json`);
  try {
    const cacheData = {
      timestamp: Date.now(),
      data: data,
    };
    fs.writeFileSync(filePath, JSON.stringify(cacheData, null, 2));
    console.log(`[Cache] Wrote ${key} at ${new Date().toISOString()}`);
    return true;
  } catch (error) {
    console.error(`[Cache] Error writing ${key}:`, error.message);
    return false;
  }
}

export function isCacheValid(key) {
  const cached = readCache(key);
  if (!cached) return false;

  const ttl = CACHE_TTL[key] || 6 * 60 * 60 * 1000; // Default 6 hours
  const age = Date.now() - cached.timestamp;
  return age < ttl;
}

export function getCacheStatus() {
  const status = {};
  for (const key of Object.keys(CACHE_TTL)) {
    const cached = readCache(key);
    if (cached) {
      const age = Date.now() - cached.timestamp;
      const ttl = CACHE_TTL[key];
      status[key] = {
        lastUpdated: new Date(cached.timestamp).toISOString(),
        ageMinutes: Math.round(age / 60000),
        valid: age < ttl,
        expiresIn: Math.max(0, Math.round((ttl - age) / 60000)) + ' minutes',
      };
    } else {
      status[key] = { lastUpdated: null, valid: false };
    }
  }
  return status;
}

export function getCacheAge(key) {
  const cached = readCache(key);
  if (!cached) return null;
  return Date.now() - cached.timestamp;
}
