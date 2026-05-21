import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, LineChart, Line } from 'recharts';

// Ticker -> CIK mapping (SEC uses CIK numbers)
const TICKERS = {
  'RBLX': '0001315098',
  'CPNG': '0001834584',
  'HOOD': '0001783879',
  'COIN': '0001679788',
  'UBER': '0001543151',
  'RDDT': '0001713445',
  'IBKR': '0001381197',
  'SPOT': '0001639920',
  'FIG': '0001579878',
};

// Manual shares override for companies with complex structures
// IBKR: Total membership interests in IBG LLC (~1.7B) vs public shares only
const SHARES_OVERRIDE = {
  'IBKR': 1695000000,
};


const formatNumber = (num) => {
  if (num === null || num === undefined || isNaN(num)) return 'N/A';
  const absNum = Math.abs(num);
  const sign = num < 0 ? '-' : '';
  if (absNum >= 1e9) return `${sign}$${(absNum / 1e9).toFixed(2)}B`;
  if (absNum >= 1e6) return `${sign}$${(absNum / 1e6).toFixed(2)}M`;
  if (absNum >= 1e3) return `${sign}$${(absNum / 1e3).toFixed(0)}K`;
  return `${sign}$${absNum.toFixed(0)}`;
};

const formatPercent = (num) => {
  if (num === null || num === undefined || isNaN(num)) return 'N/A';
  const sign = num >= 0 ? '+' : '';
  return `${sign}${(num * 100).toFixed(1)}%`;
};

// Calculate TTM (Trailing Twelve Months) from quarterly data
const calculateTTM = (quarters, index) => {
  if (index < 3 || !quarters[index]) return null;
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const val = quarters[index - i]?.value;
    if (val === null || val === undefined) return null;
    sum += val;
  }
  return sum;
};

// Calculate YoY quarterly growth (compare to same quarter last year by DATE, not index)
const calculateQuarterlyYoY = (quarters, index) => {
  if (!quarters[index]) return null;

  const current = quarters[index];
  const currentDate = new Date(current.endDate);

  // Calculate target date: same quarter last year (~365 days ago)
  const targetDate = new Date(currentDate);
  targetDate.setFullYear(targetDate.getFullYear() - 1);

  // Find the quarter closest to that date (within 15 days tolerance)
  const lastYearQ = quarters.find(q => {
    const qDate = new Date(q.endDate);
    const diffDays = Math.abs((qDate - targetDate) / (1000 * 60 * 60 * 24));
    return diffDays < 15;
  });

  if (!lastYearQ) return null;

  const currentVal = current.value;
  const lastYearVal = lastYearQ.value;

  if (lastYearVal === null || lastYearVal === undefined || lastYearVal === 0) return null;

  return (currentVal - lastYearVal) / Math.abs(lastYearVal);
};

// Data cache
const dataCache = {};
const priceCache = {};

// Finnhub API key
const FINNHUB_API_KEY = import.meta.env.VITE_FINNHUB_API_KEY;

// In a static (GitHub Pages) build all data is pre-generated into /data; in dev
// we hit the live proxies / scraper server.
const STATIC_BUILD = import.meta.env.PROD;
const DATA_BASE = import.meta.env.BASE_URL;

// Lazily load the baked current-price map (static build only)
let staticPricesPromise = null;
const loadStaticPrices = () => {
  if (!staticPricesPromise) {
    staticPricesPromise = fetch(`${DATA_BASE}data/prices.json`)
      .then(r => (r.ok ? r.json() : {}))
      .catch(() => ({}));
  }
  return staticPricesPromise;
};

// Fetch current stock price (baked map in static build, Finnhub in dev)
const fetchStockPrice = async (ticker) => {
  if (priceCache[ticker] !== undefined) return priceCache[ticker];

  if (STATIC_BUILD) {
    const prices = await loadStaticPrices();
    const price = prices?.[ticker] ?? null;
    priceCache[ticker] = price;
    return price;
  }

  try {
    const response = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_API_KEY}`
    );
    if (!response.ok) throw new Error('Price fetch failed');
    const data = await response.json();
    const price = data?.c; // 'c' is current price
    if (price) {
      priceCache[ticker] = price;
      return price;
    }
  } catch (err) {
    console.error(`Error fetching price for ${ticker}:`, err);
  }
  return null;
};

// Fetch historical monthly prices from Yahoo Finance
const historicalPriceCache = {};
const fetchHistoricalPrices = async (ticker) => {
  if (historicalPriceCache[ticker]) return historicalPriceCache[ticker];

  try {
    const url = STATIC_BUILD
      ? `${DATA_BASE}data/yahoo/${ticker}.json`
      : `/yahoo-api/v8/finance/chart/${ticker}?interval=1mo&range=5y`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Historical price fetch failed');
    const data = await response.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];

    // Build a map of YYYY-MM -> price
    const priceMap = {};
    timestamps.forEach((ts, idx) => {
      const date = new Date(ts * 1000);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      if (closes[idx]) {
        priceMap[key] = closes[idx];
      }
    });

    historicalPriceCache[ticker] = priceMap;
    return priceMap;
  } catch (err) {
    console.error(`Error fetching historical prices for ${ticker}:`, err);
  }
  return null;
};

// Extract shares outstanding from SEC data - try multiple concepts
const extractSharesOutstanding = (facts, ticker, isIFRS = false) => {
  // Check for manual override first (for complex structures like IBKR)
  if (ticker && SHARES_OVERRIDE[ticker]) {
    return SHARES_OVERRIDE[ticker];
  }

  // Try multiple share concepts in order of preference
  const shareConceptsUS = [
    'WeightedAverageNumberOfSharesOutstandingBasic',
    'WeightedAverageNumberOfDilutedSharesOutstanding',
    'CommonStockSharesOutstanding',
  ];
  const shareConceptsIFRS = [
    'NumberOfSharesOutstanding',
    'AdjustedWeightedAverageShares',
    'NumberOfSharesIssued',
  ];
  const shareConcepts = isIFRS ? shareConceptsIFRS : shareConceptsUS;

  for (const concept of shareConcepts) {
    const sharesData = facts?.[concept]?.units?.shares;
    if (sharesData && sharesData.length > 0) {
      // Get the most recent value
      const val = sharesData[sharesData.length - 1]?.val;
      if (val) return val;
    }
  }
  return null;
};

// Extract historical shares outstanding from SEC data
const extractHistoricalShares = (facts, ticker, isIFRS = false) => {
  const shareConceptsUS = [
    'WeightedAverageNumberOfSharesOutstandingBasic',
    'WeightedAverageNumberOfDilutedSharesOutstanding',
    'CommonStockSharesOutstanding',
  ];
  const shareConceptsIFRS = [
    'NumberOfSharesOutstanding',
    'AdjustedWeightedAverageShares',
    'NumberOfSharesIssued',
  ];
  const shareConcepts = isIFRS ? shareConceptsIFRS : shareConceptsUS;

  // For tickers with manual override, use the override value for all dates
  if (ticker && SHARES_OVERRIDE[ticker]) {
    // Still build a map from actual dates but use override value
    for (const concept of shareConcepts) {
      const sharesData = facts?.[concept]?.units?.shares;
      if (sharesData && sharesData.length > 0) {
        const sharesMap = {};
        sharesData.forEach(entry => {
          if (entry.end) {
            sharesMap[entry.end] = SHARES_OVERRIDE[ticker];
          }
        });
        if (Object.keys(sharesMap).length > 0) return sharesMap;
      }
    }
    return {};
  }

  // Try multiple share concepts
  for (const concept of shareConcepts) {
    const sharesData = facts?.[concept]?.units?.shares;
    if (sharesData && sharesData.length > 0) {
      // Build a map of end date -> shares
      const sharesMap = {};
      sharesData.forEach(entry => {
        if (entry.end && entry.val) {
          sharesMap[entry.end] = entry.val;
        }
      });
      if (Object.keys(sharesMap).length > 0) return sharesMap;
    }
  }
  return {};
};

// Extract quarterly values from SEC EDGAR data
const extractQuarterly = (facts, conceptNames) => {
  let bestResult = [];

  for (const concept of conceptNames) {
    const data = facts?.[concept];
    if (!data) continue;

    const usd = data.units?.USD || [];
    if (usd.length === 0) continue;

    // Get quarterly (3-month) data
    const seen = new Set();
    const quarterly = usd
      .filter(r => {
        if (!r.start || !r.end) return false;
        const start = new Date(r.start);
        const end = new Date(r.end);
        const months = (end - start) / (1000 * 60 * 60 * 24 * 30);
        return months >= 2.5 && months <= 3.5; // ~3 months
      })
      .filter(r => {
        const key = r.end;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => new Date(a.end) - new Date(b.end))
      .map(r => ({
        period: r.end.slice(0, 7).replace('-', ' Q') + getQuarter(r.end),
        endDate: r.end,
        value: r.val,
        fy: r.fy,
        fp: r.fp,
      }));

    // Calculate Q4 from annual 10-K reports (annual - Q3 cumulative)
    const annualData = usd.filter(r => {
      if (!r.start || !r.end) return false;
      const start = new Date(r.start);
      const end = new Date(r.end);
      const months = (end - start) / (1000 * 60 * 60 * 24 * 30);
      return months >= 11 && months <= 13 && r.end.endsWith('-12-31');
    });

    const q3Cumulative = usd.filter(r => {
      if (!r.start || !r.end) return false;
      const start = new Date(r.start);
      const end = new Date(r.end);
      const months = (end - start) / (1000 * 60 * 60 * 24 * 30);
      return months >= 8 && months <= 10 && r.end.endsWith('-09-30');
    });

    // Add Q4 values
    const seenQ4 = new Set();
    annualData.forEach(annual => {
      const year = annual.end.slice(0, 4);
      const q4EndDate = `${year}-12-31`;
      if (seenQ4.has(q4EndDate)) return;

      // Find matching Q3 cumulative for same year
      const q3 = q3Cumulative.find(r => r.end === `${year}-09-30` && r.start.startsWith(`${year}-01`));
      if (q3) {
        const q4Value = annual.val - q3.val;
        quarterly.push({
          period: `${year} Q4`,
          endDate: q4EndDate,
          value: q4Value,
          fy: annual.fy,
          fp: 'Q4',
        });
        seenQ4.add(q4EndDate);
      }
    });

    // Re-sort after adding Q4
    quarterly.sort((a, b) => new Date(a.endDate) - new Date(b.endDate));

    // Keep the result with the most data points
    if (quarterly.length > bestResult.length) {
      bestResult = quarterly;
    }
  }
  return bestResult;
};

const getQuarter = (dateStr) => {
  const month = parseInt(dateStr.slice(5, 7));
  if (month <= 3) return '1';
  if (month <= 6) return '2';
  if (month <= 9) return '3';
  return '4';
};

// Extract cash flow data (which is YTD cumulative) and convert to quarterly values
const extractCashFlowQuarterly = (facts, conceptNames) => {
  let bestResult = [];

  for (const concept of conceptNames) {
    const data = facts?.[concept];
    if (!data) continue;

    const usd = data.units?.USD || [];
    if (usd.length === 0) continue;

    // Get all entries from 10-Q and 10-K forms, sorted by end date
    const entries = usd
      .filter(r => r.form === '10-Q' || r.form === '10-K')
      .sort((a, b) => new Date(a.end) - new Date(b.end));

    // Group by fiscal year and convert YTD to quarterly
    const quarterlyValues = [];
    const seenEndDates = new Set();

    for (const entry of entries) {
      if (seenEndDates.has(entry.end)) continue;
      seenEndDates.add(entry.end);

      const endDate = entry.end;
      const startDate = entry.start;
      const year = endDate.slice(0, 4);
      const quarter = getQuarter(endDate);

      // Determine if this is Q1 (starts Jan 1) or cumulative
      const startMonth = parseInt(startDate.slice(5, 7));
      const endMonth = parseInt(endDate.slice(5, 7));

      let quarterlyValue = entry.val;

      // If start is Jan 1 and end is not Mar 31, it's cumulative YTD
      if (startMonth === 1 && endMonth > 3) {
        // Find the previous quarter's cumulative value in same fiscal year
        const prevQuarterEnd = getPreviousQuarterEnd(endDate);
        const prevEntry = entries.find(e => e.end === prevQuarterEnd && e.start.slice(5, 7) === '01');

        if (prevEntry) {
          quarterlyValue = entry.val - prevEntry.val;
        }
      }

      // For Q4 (annual reports), we need special handling
      if (entry.form === '10-K' && entry.fp === 'FY') {
        // Find Q3 cumulative to calculate Q4
        const q3End = `${year}-09-30`;
        const q3Entry = entries.find(e => e.end === q3End && e.start.slice(5, 7) === '01');
        if (q3Entry) {
          quarterlyValue = entry.val - q3Entry.val;
        }
      }

      quarterlyValues.push({
        period: endDate.slice(0, 7).replace('-', ' Q') + quarter,
        endDate: endDate,
        value: quarterlyValue,
        fy: entry.fy,
        fp: entry.fp,
      });
    }

    // Dedupe and sort
    const seen = new Set();
    const deduped = quarterlyValues
      .filter(q => {
        if (seen.has(q.endDate)) return false;
        seen.add(q.endDate);
        return true;
      })
      .sort((a, b) => new Date(a.endDate) - new Date(b.endDate));

    if (deduped.length > bestResult.length) {
      bestResult = deduped;
    }
  }
  return bestResult;
};

const getPreviousQuarterEnd = (endDate) => {
  const year = parseInt(endDate.slice(0, 4));
  const month = parseInt(endDate.slice(5, 7));

  if (month <= 3) return `${year - 1}-12-31`;
  if (month <= 6) return `${year}-03-31`;
  if (month <= 9) return `${year}-06-30`;
  return `${year}-09-30`;
};

const fetchTickerData = async (ticker, cik) => {
  const cacheKey = ticker;
  if (dataCache[cacheKey]) return dataCache[cacheKey];

  try {
    // Static build: read pre-fetched companyfacts. Dev: SEC EDGAR via Vite proxy.
    const url = STATIC_BUILD
      ? `${DATA_BASE}data/sec/CIK${cik}.json`
      : `/sec-api/api/xbrl/companyfacts/CIK${cik}.json`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to fetch ${ticker}: ${response.status}`);
    }

    const data = await response.json();
    const usGaapFacts = data.facts?.['us-gaap'] || {};
    const ifrsFacts = data.facts?.['ifrs-full'] || {};
    const isIFRS = Object.keys(ifrsFacts).length > Object.keys(usGaapFacts).length;
    const facts = isIFRS ? ifrsFacts : usGaapFacts;

    // Extract quarterly data for each metric - check multiple concept names
    const revenueConceptsUS = [
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'RevenueFromContractWithCustomerIncludingAssessedTax',
      'Revenues',
      'RevenuesNetOfInterestExpense', // IBKR and financial services
      'SalesRevenueNet',
      'NetRevenues',
      'TotalRevenues',
      'Revenue',
    ];
    const revenueConceptsIFRS = [
      'Revenue',
      'RevenueFromContractsWithCustomers',
    ];
    const revenue = extractQuarterly(facts, isIFRS ? revenueConceptsIFRS : revenueConceptsUS);

    let grossProfit;
    if (isIFRS) {
      // IFRS companies report GrossProfit directly
      grossProfit = extractQuarterly(facts, ['GrossProfit']);
    } else {
      const costOfRevenue = extractQuarterly(facts, [
        'CostOfRevenue',
        'CostOfGoodsAndServicesSold',
        'CostOfGoodsSold',
        'CostOfServices',
        'CostOfGoodsAndServiceExcludingDepreciationDepletionAndAmortization', // Uber uses this
        'OtherCostAndExpenseOperating', // HOOD uses this
        'NoninterestExpense', // IBKR and other financial services companies use this
      ]);

      // Calculate Gross Profit = Revenue - Cost of Revenue
      grossProfit = revenue.map((rev) => {
        const costItem = costOfRevenue.find(c => c.endDate === rev.endDate);
        const costVal = costItem?.value || 0;
        return {
          ...rev,
          value: rev.value - costVal,
        };
      });
    }

    const operatingIncomeConceptsUS = [
      'OperatingIncomeLoss',
      'IncomeLossFromOperations',
      'OperatingIncome',
      'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
    ];
    const operatingIncomeConceptsIFRS = [
      'ProfitLossFromOperatingActivities',
    ];
    const operatingIncome = extractQuarterly(facts, isIFRS ? operatingIncomeConceptsIFRS : operatingIncomeConceptsUS);

    const netIncomeConceptsUS = [
      'NetIncomeLoss',
      'NetIncomeLossAvailableToCommonStockholdersBasic',
      'ProfitLoss',
      'NetIncomeLossAttributableToParent',
    ];
    const netIncomeConceptsIFRS = [
      'ProfitLoss',
      'ProfitLossAttributableToOwnersOfParent',
    ];
    const netIncome = extractQuarterly(facts, isIFRS ? netIncomeConceptsIFRS : netIncomeConceptsUS);

    const operatingCashFlowConceptsUS = [
      'NetCashProvidedByUsedInOperatingActivities',
      'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
      'CashFlowsFromUsedInOperatingActivities',
    ];
    const operatingCashFlowConceptsIFRS = [
      'CashFlowsFromUsedInOperatingActivities',
    ];
    const operatingCashFlow = extractCashFlowQuarterly(facts, isIFRS ? operatingCashFlowConceptsIFRS : operatingCashFlowConceptsUS);

    const capexConceptsUS = [
      'PaymentsToAcquirePropertyPlantAndEquipment',
      'PurchaseOfPropertyPlantAndEquipment',
      'PaymentsForCapitalImprovements',
      'CapitalExpenditures',
      'PaymentsToAcquireProductiveAssets',
    ];
    const capexConceptsIFRS = [
      'PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities',
    ];
    const capex = extractCashFlowQuarterly(facts, isIFRS ? capexConceptsIFRS : capexConceptsUS);

    // Calculate Free Cash Flow = Operating Cash Flow - CapEx
    const freeCashFlow = operatingCashFlow.map((ocf, idx) => {
      const capexItem = capex.find(c => c.endDate === ocf.endDate);
      const capexVal = capexItem?.value || 0;
      return {
        ...ocf,
        value: ocf.value - Math.abs(capexVal),
      };
    });

    // Extract stock-based compensation (for UBER valuation calculation)
    const sbcConceptsUS = [
      'ShareBasedCompensation',
      'AllocatedShareBasedCompensationExpense',
      'ShareBasedCompensationExpense',
    ];
    const sbcConceptsIFRS = [
      'ExpenseFromSharebasedPaymentTransactionsWithEmployees',
      'AdjustmentsForSharebasedPayments',
    ];
    const stockBasedComp = extractQuarterly(facts, isIFRS ? sbcConceptsIFRS : sbcConceptsUS);

    // Extract shares outstanding for market cap calculation
    const sharesOutstanding = extractSharesOutstanding(facts, ticker, isIFRS);
    const historicalShares = extractHistoricalShares(facts, ticker, isIFRS);

    const result = {
      ticker,
      name: data.entityName || ticker,
      revenue,
      grossProfit,
      operatingIncome,
      netIncome,
      freeCashFlow,
      stockBasedComp,
      sharesOutstanding,
      historicalShares,
    };

    dataCache[cacheKey] = result;
    return result;
  } catch (err) {
    console.error(`Error fetching ${ticker}:`, err);
    return { ticker, name: ticker, revenue: [], grossProfit: [], operatingIncome: [], netIncome: [], freeCashFlow: [], stockBasedComp: [], sharesOutstanding: null, historicalShares: {} };
  }
};

// Process data into TTM and YoY quarterly growth
const processMetricData = (quarterlyData) => {
  if (!quarterlyData || quarterlyData.length < 4) return [];

  // Build chart data with TTM and quarterly YoY growth
  return quarterlyData.map((q, idx) => {
    const ttm = calculateTTM(quarterlyData, idx);
    const growth = calculateQuarterlyYoY(quarterlyData, idx);
    return {
      period: q.endDate.slice(0, 7),
      endDate: q.endDate,
      quarterly: q.value,
      ttm,
      growth,
    };
  }).filter(d => d.ttm !== null);
};

// Chart component for a single ticker - shows main metric + growth chart below
function TickerChart({ ticker, data, title, color, showGrowthOnly = false, showQuarterly = false }) {
  const chartData = processMetricData(data);

  if (!chartData || chartData.length === 0) {
    return (
      <div style={styles.chartCard}>
        <h3 style={styles.chartHeader}>{ticker}</h3>
        <div style={styles.noData}>No data available</div>
      </div>
    );
  }

  const latestValue = chartData[chartData.length - 1]?.ttm;
  const latestGrowth = chartData[chartData.length - 1]?.growth;
  const growthData = chartData.filter(d => d.growth !== null);
  const xAxisInterval = Math.max(1, Math.floor(chartData.length / 6));

  // If showGrowthOnly, just show the growth chart (for dedicated growth pages)
  if (showGrowthOnly) {
    return (
      <div style={styles.chartCard}>
        <div style={styles.chartHeaderRow}>
          <h3 style={styles.chartHeader}>{ticker}</h3>
          {latestGrowth !== null && (
            <span style={{
              ...styles.growthBadge,
              color: latestGrowth >= 0 ? '#16a34a' : '#dc2626',
              backgroundColor: latestGrowth >= 0 ? '#dcfce7' : '#fee2e2',
            }}>
              {formatPercent(latestGrowth)} YoY
            </span>
          )}
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={growthData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <XAxis
              dataKey="period"
              tick={{ fontSize: 10, fill: '#666' }}
              tickLine={false}
              axisLine={{ stroke: '#e5e7eb' }}
              interval={xAxisInterval}
            />
            <YAxis
              tick={{ fontSize: 10, fill: '#666' }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(val) => `${(val * 100).toFixed(0)}%`}
            />
            <Tooltip
              contentStyle={styles.tooltip}
              formatter={(val) => [formatPercent(val), 'YoY Growth']}
              labelFormatter={(label) => `Quarter: ${label}`}
            />
            <ReferenceLine y={0} stroke="#94a3b8" />
            <Bar dataKey="growth" fill="#6366f1" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // Main view: TTM chart + Growth chart stacked
  return (
    <div style={styles.chartCard}>
      {/* Header */}
      <div style={styles.chartHeaderRow}>
        <h3 style={styles.chartHeader}>{ticker}</h3>
        <div style={styles.chartMeta}>
          <span style={styles.latestValue}>{formatNumber(latestValue)}</span>
          {latestGrowth !== null && (
            <span style={{
              ...styles.growthBadge,
              color: latestGrowth >= 0 ? '#16a34a' : '#dc2626',
              backgroundColor: latestGrowth >= 0 ? '#dcfce7' : '#fee2e2',
            }}>
              {formatPercent(latestGrowth)} YoY
            </span>
          )}
        </div>
      </div>

      {/* Main TTM Chart */}
      <div style={styles.chartLabel}>TTM {title}</div>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
          <XAxis
            dataKey="period"
            tick={{ fontSize: 9, fill: '#999' }}
            tickLine={false}
            axisLine={{ stroke: '#e5e7eb' }}
            interval={xAxisInterval}
          />
          <YAxis
            tick={{ fontSize: 9, fill: '#999' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(val) => {
              if (Math.abs(val) >= 1e9) return `${(val / 1e9).toFixed(1)}B`;
              if (Math.abs(val) >= 1e6) return `${(val / 1e6).toFixed(0)}M`;
              return val;
            }}
          />
          <Tooltip
            contentStyle={styles.tooltip}
            formatter={(val) => [formatNumber(val), 'TTM ' + title]}
            labelFormatter={(label) => `Quarter: ${label}`}
          />
          <ReferenceLine y={0} stroke="#e5e7eb" />
          <Bar dataKey="ttm" fill={color} radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>

      {/* Quarterly Values Chart - only shown when showQuarterly is true */}
      {showQuarterly && (
        <>
          <div style={{ ...styles.chartLabel, marginTop: '12px' }}>Quarterly {title}</div>
          <ResponsiveContainer width="100%" height={140}>
            <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <XAxis
                dataKey="period"
                tick={{ fontSize: 9, fill: '#999' }}
                tickLine={false}
                axisLine={{ stroke: '#e5e7eb' }}
                interval={xAxisInterval}
              />
              <YAxis
                tick={{ fontSize: 9, fill: '#999' }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(val) => {
                  if (Math.abs(val) >= 1e9) return `${(val / 1e9).toFixed(1)}B`;
                  if (Math.abs(val) >= 1e6) return `${(val / 1e6).toFixed(0)}M`;
                  return val;
                }}
              />
              <Tooltip
                contentStyle={styles.tooltip}
                formatter={(val) => [formatNumber(val), 'Quarterly ' + title]}
                labelFormatter={(label) => `Quarter: ${label}`}
              />
              <ReferenceLine y={0} stroke="#e5e7eb" />
              <Bar dataKey="quarterly" fill={color} opacity={0.7} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </>
      )}

      {/* YoY Growth Chart - aligned below */}
      <div style={{ ...styles.chartLabel, marginTop: '12px' }}>YoY Growth Rate</div>
      <ResponsiveContainer width="100%" height={120}>
        <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
          <XAxis
            dataKey="period"
            tick={{ fontSize: 9, fill: '#999' }}
            tickLine={false}
            axisLine={{ stroke: '#e5e7eb' }}
            interval={xAxisInterval}
          />
          <YAxis
            tick={{ fontSize: 9, fill: '#999' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(val) => `${(val * 100).toFixed(0)}%`}
          />
          <Tooltip
            contentStyle={styles.tooltip}
            formatter={(val) => val !== null ? [formatPercent(val), 'YoY Growth'] : ['N/A', 'YoY Growth']}
            labelFormatter={(label) => `Quarter: ${label}`}
          />
          <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="3 3" />
          <Bar
            dataKey="growth"
            fill="#6366f1"
            radius={[2, 2, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Page component for a metric
function MetricPage({ allData, loading, metric, title, color, showGrowthOnly = false, showQuarterly = false }) {
  if (loading) {
    return (
      <div style={styles.loadingContainer}>
        <div style={styles.spinner} />
        <p>Loading data from SEC EDGAR...</p>
      </div>
    );
  }

  const pageTitle = showGrowthOnly ? `${title} Growth Rate (YoY)` : title;
  const pageSubtitle = showGrowthOnly
    ? 'Year-over-year growth based on trailing twelve months'
    : showQuarterly
      ? 'TTM, Quarterly values, and YoY growth rate'
      : 'Quarterly TTM with YoY growth rate';

  return (
    <div style={styles.pageContent}>
      <h1 style={styles.pageTitle}>{pageTitle}</h1>
      <p style={styles.pageSubtitle}>{pageSubtitle}</p>

      <div style={styles.chartsGrid}>
        {Object.keys(TICKERS).map(ticker => (
          <TickerChart
            key={ticker}
            ticker={ticker}
            data={allData[ticker]?.[metric] || []}
            title={title}
            color={color}
            showGrowthOnly={showGrowthOnly}
            showQuarterly={showQuarterly}
          />
        ))}
      </div>
    </div>
  );
}

// Shares override for complex ownership structures
const VALUATION_SHARES = {
  'IBKR': 1695000000, // Total membership interests in IBG LLC (~1.7B)
};

// Valuation Multiples Chart Component
function ValuationChart({ ticker, allData, price }) {
  const tickerData = allData[ticker];
  const shares = VALUATION_SHARES[ticker] || tickerData?.sharesOutstanding;
  const marketCap = price && shares ? price * shares : null;

  let multiple = null;
  let metricLabel = '';

  if (tickerData && marketCap) {
    let ttmValue = null;

    if (ticker === 'UBER') {
      // Uber: Price / (TTM FCF - TTM Stock Based Comp)
      const fcfData = tickerData.freeCashFlow || [];
      const sbcData = tickerData.stockBasedComp || [];
      if (fcfData.length >= 4 && sbcData.length >= 4) {
        const ttmFCF = fcfData.slice(-4).reduce((sum, q) => sum + (q.value || 0), 0);
        const ttmSBC = sbcData.slice(-4).reduce((sum, q) => sum + (q.value || 0), 0);
        ttmValue = ttmFCF - ttmSBC;
      }
      metricLabel = 'Price / (TTM FCF - SBC)';
    } else if (ticker === 'RBLX' || ticker === 'RDDT') {
      // Roblox & Reddit: Price / TTM Free Cash Flow
      const fcfData = tickerData.freeCashFlow || [];
      if (fcfData.length >= 4) {
        ttmValue = fcfData.slice(-4).reduce((sum, q) => sum + (q.value || 0), 0);
      }
      metricLabel = 'Price / TTM FCF';
    } else if (ticker === 'CPNG') {
      // Coupang: Price / (5% of TTM Revenue)
      const revenueData = tickerData.revenue || [];
      if (revenueData.length >= 4) {
        const ttmRevenue = revenueData.slice(-4).reduce((sum, q) => sum + (q.value || 0), 0);
        ttmValue = ttmRevenue * 0.05;
      }
      metricLabel = 'Price / 5% TTM Revenue';
    } else {
      // Default: Price / TTM Operating Income
      const opIncomeData = tickerData.operatingIncome || [];
      if (opIncomeData.length >= 4) {
        ttmValue = opIncomeData.slice(-4).reduce((sum, q) => sum + (q.value || 0), 0);
      }
      metricLabel = 'Price / TTM Op. Income';
    }

    if (ttmValue && ttmValue !== 0) {
      multiple = marketCap / ttmValue;
    }
  }

  const formatMultiple = (val) => {
    if (val === null || val === undefined || !isFinite(val)) return 'N/A';
    if (val < 0) return `${val.toFixed(1)}x (neg)`;
    return `${val.toFixed(1)}x`;
  };

  return (
    <div style={styles.chartCard}>
      <div style={styles.chartHeaderRow}>
        <h3 style={styles.chartHeader}>{ticker}</h3>
        <span style={{
          ...styles.growthBadge,
          color: '#4338ca',
          backgroundColor: '#e0e7ff',
        }}>
          {metricLabel}
        </span>
      </div>
      <div style={styles.valuationDisplay}>
        <span style={styles.valuationNumber}>{formatMultiple(multiple)}</span>
        <span style={styles.valuationSubtext}>
          Stock: ${price?.toFixed(2) || 'N/A'} | Mkt Cap: {marketCap ? `$${(marketCap / 1e9).toFixed(1)}B` : 'N/A'}
        </span>
      </div>
    </div>
  );
}

// Valuation Multiples Page
function ValuationMultiplesPage({ allData, loading }) {
  const [prices, setPrices] = useState({});
  const [priceLoading, setPriceLoading] = useState(true);

  useEffect(() => {
    const fetchPrices = async () => {
      const tickers = Object.keys(TICKERS);
      const priceResults = {};

      // Fetch prices sequentially to avoid rate limits
      for (const ticker of tickers) {
        const price = await fetchStockPrice(ticker);
        priceResults[ticker] = price;
        // Small delay between requests to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      setPrices(priceResults);
      setPriceLoading(false);
    };

    if (!loading) {
      fetchPrices();
    }
  }, [loading]);

  if (loading || priceLoading) {
    return (
      <div style={styles.loadingContainer}>
        <div style={styles.spinner} />
        <p>Loading valuation data...</p>
      </div>
    );
  }

  return (
    <div style={styles.pageContent}>
      <h1 style={styles.pageTitle}>Valuation Multiples</h1>
      <p style={styles.pageSubtitle}>
        Price / TTM Operating Income (RBLX: Price / TTM FCF, CPNG: Price / 5% TTM Revenue)
      </p>

      <div style={styles.chartsGrid}>
        {Object.keys(TICKERS).map(ticker => (
          <ValuationChart
            key={ticker}
            ticker={ticker}
            allData={allData}
            price={prices[ticker]}
          />
        ))}
      </div>
    </div>
  );
}

// Valuation History Chart Component - shows historical multiples as line chart
function ValuationHistoryChart({ ticker, allData, historicalPrices, currentPrice }) {
  const tickerData = allData[ticker];
  const priceMap = historicalPrices || {};
  const sharesMap = tickerData?.historicalShares || {};

  if (!tickerData) {
    return (
      <div style={styles.chartCard}>
        <h3 style={styles.chartHeader}>{ticker}</h3>
        <div style={styles.noData}>No data available</div>
      </div>
    );
  }

  // Determine which metric to use based on ticker
  let metricData = [];
  let metricLabel = '';
  let sbcData = [];

  if (ticker === 'UBER') {
    metricData = tickerData.freeCashFlow || [];
    sbcData = tickerData.stockBasedComp || [];
    metricLabel = 'Price / (TTM FCF - SBC)';
  } else if (ticker === 'RBLX' || ticker === 'RDDT') {
    metricData = tickerData.freeCashFlow || [];
    metricLabel = 'Price / TTM FCF';
  } else if (ticker === 'CPNG') {
    metricData = tickerData.revenue || [];
    metricLabel = 'Price / 5% TTM Revenue';
  } else {
    metricData = tickerData.operatingIncome || [];
    metricLabel = 'Price / TTM Op. Income';
  }

  // Calculate historical multiples using TTM values and historical prices
  const historyData = [];
  const lastIndex = metricData.length - 1;

  for (let i = 3; i < metricData.length; i++) {
    let ttmValue = 0;
    for (let j = 0; j < 4; j++) {
      ttmValue += metricData[i - j]?.value || 0;
    }

    // For UBER, subtract TTM stock-based compensation
    if (ticker === 'UBER' && sbcData.length >= 4) {
      let ttmSBC = 0;
      for (let j = 0; j < 4; j++) {
        const sbcIndex = i - j;
        if (sbcIndex >= 0 && sbcIndex < sbcData.length) {
          ttmSBC += sbcData[sbcIndex]?.value || 0;
        }
      }
      ttmValue = ttmValue - ttmSBC;
    }

    // For CPNG, use 5% of revenue
    if (ticker === 'CPNG') {
      ttmValue = ttmValue * 0.05;
    }

    const endDate = metricData[i].endDate;
    const period = endDate.slice(0, 7); // YYYY-MM
    const isLatest = i === lastIndex;

    // Use current price for the most recent quarter, historical for others
    const price = isLatest && currentPrice ? currentPrice : priceMap[period];

    // Get shares - use override first for complex structures like IBKR
    let shares = SHARES_OVERRIDE[ticker];
    if (!shares) {
      const sharesEntries = Object.entries(sharesMap).sort((a, b) => new Date(b[0]) - new Date(a[0]));
      for (const [date, val] of sharesEntries) {
        if (date <= endDate) {
          shares = val;
          break;
        }
      }
      // Fallback to latest shares if no historical data
      if (!shares) shares = tickerData.sharesOutstanding;
    }

    if (price && shares) {
      const marketCap = price * shares;
      // Include data point even if TTM is negative or zero (will show as null/gap)
      let multiple = null;
      if (ttmValue && ttmValue !== 0) {
        multiple = marketCap / ttmValue;
        // Filter out extreme positive multiples, but keep negative ones as null
        if (multiple < 0 || multiple > 500) {
          multiple = null;
        }
      }
      historyData.push({
        period: isLatest ? 'Current' : period,
        multiple: multiple,
        price: price,
      });
    }
  }

  if (historyData.length === 0) {
    return (
      <div style={styles.chartCard}>
        <h3 style={styles.chartHeader}>{ticker}</h3>
        <div style={styles.noData}>Insufficient data for history</div>
      </div>
    );
  }

  const latestMultiple = historyData[historyData.length - 1]?.multiple;
  const latestPrice = historyData[historyData.length - 1]?.price;
  const xAxisInterval = Math.max(1, Math.floor(historyData.length / 6));

  return (
    <div style={styles.chartCard}>
      <div style={styles.chartHeaderRow}>
        <h3 style={styles.chartHeader}>{ticker}</h3>
        <span style={{
          ...styles.growthBadge,
          color: '#4338ca',
          backgroundColor: '#e0e7ff',
        }}>
          {metricLabel}
        </span>
      </div>
      <div style={{ ...styles.chartMeta, marginBottom: '12px' }}>
        <span style={styles.latestValue}>{latestMultiple?.toFixed(1)}x</span>
        <span style={{ fontSize: '11px', color: '#64748b', marginLeft: '8px' }}>@ ${latestPrice?.toFixed(2)}</span>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={historyData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
          <XAxis
            dataKey="period"
            tick={{ fontSize: 9, fill: '#999' }}
            tickLine={false}
            axisLine={{ stroke: '#e5e7eb' }}
            interval={xAxisInterval}
          />
          <YAxis
            tick={{ fontSize: 9, fill: '#999' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(val) => `${val.toFixed(0)}x`}
          />
          <Tooltip
            contentStyle={styles.tooltip}
            formatter={(val, name, props) => [`${val.toFixed(1)}x @ $${props.payload.price?.toFixed(2)}`, metricLabel]}
            labelFormatter={(label) => `Quarter: ${label}`}
          />
          <Line
            type="linear"
            dataKey="multiple"
            stroke="#6366f1"
            strokeWidth={2}
            dot={{ fill: '#6366f1', strokeWidth: 0, r: 3 }}
            activeDot={{ r: 5, fill: '#4f46e5' }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// Margins Chart Component - shows TTM margins as 3 separate line charts
function MarginsChart({ ticker, allData }) {
  const tickerData = allData[ticker];

  if (!tickerData) {
    return (
      <div style={styles.chartCard}>
        <h3 style={styles.chartHeader}>{ticker}</h3>
        <div style={styles.noData}>No data available</div>
      </div>
    );
  }

  const revenue = tickerData.revenue || [];
  const grossProfit = tickerData.grossProfit || [];
  const operatingIncome = tickerData.operatingIncome || [];
  const freeCashFlow = tickerData.freeCashFlow || [];

  // Calculate TTM margins for each quarter
  const marginsData = [];

  for (let i = 3; i < revenue.length; i++) {
    const endDate = revenue[i].endDate;
    const period = endDate.slice(0, 7);

    // Calculate TTM values
    let ttmRevenue = 0;
    let ttmGrossProfit = 0;
    let ttmOpIncome = 0;
    let ttmFCF = 0;

    for (let j = 0; j < 4; j++) {
      ttmRevenue += revenue[i - j]?.value || 0;

      const gpItem = grossProfit.find(g => g.endDate === revenue[i - j]?.endDate);
      ttmGrossProfit += gpItem?.value || 0;

      const opItem = operatingIncome.find(o => o.endDate === revenue[i - j]?.endDate);
      ttmOpIncome += opItem?.value || 0;

      const fcfItem = freeCashFlow.find(f => f.endDate === revenue[i - j]?.endDate);
      ttmFCF += fcfItem?.value || 0;
    }

    if (ttmRevenue > 0) {
      marginsData.push({
        period,
        grossMargin: (ttmGrossProfit / ttmRevenue) * 100,
        opMargin: (ttmOpIncome / ttmRevenue) * 100,
        fcfMargin: (ttmFCF / ttmRevenue) * 100,
      });
    }
  }

  if (marginsData.length === 0) {
    return (
      <div style={styles.chartCard}>
        <h3 style={styles.chartHeader}>{ticker}</h3>
        <div style={styles.noData}>Insufficient data for margins</div>
      </div>
    );
  }

  const latest = marginsData[marginsData.length - 1];
  const xAxisInterval = Math.max(1, Math.floor(marginsData.length / 6));

  return (
    <div style={styles.chartCard}>
      <div style={styles.chartHeaderRow}>
        <h3 style={styles.chartHeader}>{ticker}</h3>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '11px', color: '#14b8a6', fontWeight: '600' }}>Gross: {latest.grossMargin.toFixed(1)}%</span>
          <span style={{ fontSize: '11px', color: '#8b5cf6', fontWeight: '600' }}>Op: {latest.opMargin.toFixed(1)}%</span>
          <span style={{ fontSize: '11px', color: '#f59e0b', fontWeight: '600' }}>FCF: {latest.fcfMargin.toFixed(1)}%</span>
        </div>
      </div>

      {/* Gross Margin Chart */}
      <div style={{ ...styles.chartLabel, marginTop: '8px' }}>TTM Gross Margin</div>
      <ResponsiveContainer width="100%" height={120}>
        <LineChart data={marginsData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
          <XAxis
            dataKey="period"
            tick={{ fontSize: 9, fill: '#999' }}
            tickLine={false}
            axisLine={{ stroke: '#e5e7eb' }}
            interval={xAxisInterval}
          />
          <YAxis
            tick={{ fontSize: 9, fill: '#999' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(val) => `${val.toFixed(0)}%`}
          />
          <Tooltip
            contentStyle={styles.tooltip}
            formatter={(val) => [`${val.toFixed(1)}%`, 'Gross Margin']}
            labelFormatter={(label) => `Quarter: ${label}`}
          />
          <ReferenceLine y={0} stroke="#e5e7eb" />
          <Line type="linear" dataKey="grossMargin" stroke="#14b8a6" strokeWidth={2} dot={{ r: 2 }} />
        </LineChart>
      </ResponsiveContainer>

      {/* Operating Margin Chart */}
      <div style={{ ...styles.chartLabel, marginTop: '16px' }}>TTM Operating Margin</div>
      <ResponsiveContainer width="100%" height={120}>
        <LineChart data={marginsData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
          <XAxis
            dataKey="period"
            tick={{ fontSize: 9, fill: '#999' }}
            tickLine={false}
            axisLine={{ stroke: '#e5e7eb' }}
            interval={xAxisInterval}
          />
          <YAxis
            tick={{ fontSize: 9, fill: '#999' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(val) => `${val.toFixed(0)}%`}
          />
          <Tooltip
            contentStyle={styles.tooltip}
            formatter={(val) => [`${val.toFixed(1)}%`, 'Operating Margin']}
            labelFormatter={(label) => `Quarter: ${label}`}
          />
          <ReferenceLine y={0} stroke="#e5e7eb" />
          <Line type="linear" dataKey="opMargin" stroke="#8b5cf6" strokeWidth={2} dot={{ r: 2 }} />
        </LineChart>
      </ResponsiveContainer>

      {/* FCF Margin Chart */}
      <div style={{ ...styles.chartLabel, marginTop: '16px' }}>TTM FCF Margin</div>
      <ResponsiveContainer width="100%" height={120}>
        <LineChart data={marginsData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
          <XAxis
            dataKey="period"
            tick={{ fontSize: 9, fill: '#999' }}
            tickLine={false}
            axisLine={{ stroke: '#e5e7eb' }}
            interval={xAxisInterval}
          />
          <YAxis
            tick={{ fontSize: 9, fill: '#999' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(val) => `${val.toFixed(0)}%`}
          />
          <Tooltip
            contentStyle={styles.tooltip}
            formatter={(val) => [`${val.toFixed(1)}%`, 'FCF Margin']}
            labelFormatter={(label) => `Quarter: ${label}`}
          />
          <ReferenceLine y={0} stroke="#e5e7eb" />
          <Line type="linear" dataKey="fcfMargin" stroke="#f59e0b" strokeWidth={2} dot={{ r: 2 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// Margins Page
function MarginsPage({ allData, loading }) {
  if (loading) {
    return (
      <div style={styles.loadingContainer}>
        <div style={styles.spinner} />
        <p>Loading margins data...</p>
      </div>
    );
  }

  return (
    <div style={styles.pageContent}>
      <h1 style={styles.pageTitle}>TTM Margins</h1>
      <p style={styles.pageSubtitle}>
        Gross Margin, Operating Margin, and FCF Margin (trailing twelve months)
      </p>

      <div style={styles.chartsGrid}>
        {Object.keys(TICKERS).map(ticker => (
          <MarginsChart
            key={ticker}
            ticker={ticker}
            allData={allData}
          />
        ))}
      </div>
    </div>
  );
}

// Valuation Multiple History Page
function ValuationHistoryPage({ allData, loading }) {
  const [historicalPrices, setHistoricalPrices] = useState({});
  const [currentPrices, setCurrentPrices] = useState({});
  const [priceLoading, setPriceLoading] = useState(true);

  useEffect(() => {
    const fetchAllPrices = async () => {
      const tickers = Object.keys(TICKERS);
      const histPriceResults = {};
      const currPriceResults = {};

      for (const ticker of tickers) {
        // Fetch both historical and current prices
        const [histPrices, currPrice] = await Promise.all([
          fetchHistoricalPrices(ticker),
          fetchStockPrice(ticker),
        ]);
        histPriceResults[ticker] = histPrices;
        currPriceResults[ticker] = currPrice;
        await new Promise(resolve => setTimeout(resolve, 150));
      }

      setHistoricalPrices(histPriceResults);
      setCurrentPrices(currPriceResults);
      setPriceLoading(false);
    };

    if (!loading) {
      fetchAllPrices();
    }
  }, [loading]);

  if (loading || priceLoading) {
    return (
      <div style={styles.loadingContainer}>
        <div style={styles.spinner} />
        <p>Loading historical prices...</p>
      </div>
    );
  }

  return (
    <div style={styles.pageContent}>
      <h1 style={styles.pageTitle}>Valuation Multiple History</h1>
      <p style={styles.pageSubtitle}>
        Historical multiples using actual stock prices by quarter (current price for latest)
      </p>

      <div style={styles.chartsGrid}>
        {Object.keys(TICKERS).map(ticker => (
          <ValuationHistoryChart
            key={ticker}
            ticker={ticker}
            allData={allData}
            historicalPrices={historicalPrices[ticker]}
            currentPrice={currentPrices[ticker]}
          />
        ))}
      </div>
    </div>
  );
}

// Market Cap History Chart Component - shows historical market cap as line chart
function MarketCapHistoryChart({ ticker, allData, historicalPrices, currentPrice }) {
  const tickerData = allData[ticker];
  const priceMap = historicalPrices || {};
  const sharesMap = tickerData?.historicalShares || {};

  if (!tickerData) {
    return (
      <div style={styles.chartCard}>
        <h3 style={styles.chartHeader}>{ticker}</h3>
        <div style={styles.noData}>No data available</div>
      </div>
    );
  }

  // Use revenue data to get quarterly end dates
  const revenue = tickerData.revenue || [];
  if (revenue.length === 0) {
    return (
      <div style={styles.chartCard}>
        <h3 style={styles.chartHeader}>{ticker}</h3>
        <div style={styles.noData}>No quarterly data available</div>
      </div>
    );
  }

  // Calculate historical market cap for each quarter
  const historyData = [];
  const lastIndex = revenue.length - 1;

  for (let i = 0; i < revenue.length; i++) {
    const endDate = revenue[i].endDate;
    const period = endDate.slice(0, 7); // YYYY-MM
    const isLatest = i === lastIndex;

    // Use current price for the most recent quarter, historical for others
    const price = isLatest && currentPrice ? currentPrice : priceMap[period];

    // Get shares - use override first for complex structures like IBKR
    let shares = SHARES_OVERRIDE[ticker];
    if (!shares) {
      const sharesEntries = Object.entries(sharesMap).sort((a, b) => new Date(b[0]) - new Date(a[0]));
      for (const [date, val] of sharesEntries) {
        if (date <= endDate) {
          shares = val;
          break;
        }
      }
      // Fallback to latest shares if no historical data
      if (!shares) shares = tickerData.sharesOutstanding;
    }

    if (price && shares) {
      const marketCap = price * shares;
      historyData.push({
        period: isLatest ? 'Current' : period,
        marketCap: marketCap,
        price: price,
        shares: shares,
      });
    }
  }

  if (historyData.length === 0) {
    return (
      <div style={styles.chartCard}>
        <h3 style={styles.chartHeader}>{ticker}</h3>
        <div style={styles.noData}>Insufficient data for history</div>
      </div>
    );
  }

  const latestMarketCap = historyData[historyData.length - 1]?.marketCap;
  const latestPrice = historyData[historyData.length - 1]?.price;
  const xAxisInterval = Math.max(1, Math.floor(historyData.length / 6));

  return (
    <div style={styles.chartCard}>
      <div style={styles.chartHeaderRow}>
        <h3 style={styles.chartHeader}>{ticker}</h3>
      </div>
      <div style={{ ...styles.chartMeta, marginBottom: '12px' }}>
        <span style={styles.latestValue}>${(latestMarketCap / 1e9).toFixed(1)}B</span>
        <span style={{ fontSize: '11px', color: '#64748b', marginLeft: '8px' }}>@ ${latestPrice?.toFixed(2)}</span>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={historyData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
          <XAxis
            dataKey="period"
            tick={{ fontSize: 9, fill: '#999' }}
            tickLine={false}
            axisLine={{ stroke: '#e5e7eb' }}
            interval={xAxisInterval}
          />
          <YAxis
            tick={{ fontSize: 9, fill: '#999' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(val) => `$${(val / 1e9).toFixed(0)}B`}
          />
          <Tooltip
            contentStyle={styles.tooltip}
            formatter={(val, name, props) => [`$${(val / 1e9).toFixed(1)}B @ $${props.payload.price?.toFixed(2)}`, 'Market Cap']}
            labelFormatter={(label) => `Quarter: ${label}`}
          />
          <Line
            type="linear"
            dataKey="marketCap"
            stroke="#0ea5e9"
            strokeWidth={2}
            dot={{ fill: '#0ea5e9', strokeWidth: 0, r: 3 }}
            activeDot={{ r: 5, fill: '#0284c7' }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// Market Cap History Page
function MarketCapHistoryPage({ allData, loading }) {
  const [historicalPrices, setHistoricalPrices] = useState({});
  const [currentPrices, setCurrentPrices] = useState({});
  const [priceLoading, setPriceLoading] = useState(true);

  useEffect(() => {
    const fetchAllPrices = async () => {
      const tickers = Object.keys(TICKERS);
      const histPriceResults = {};
      const currPriceResults = {};

      for (const ticker of tickers) {
        const [histPrices, currPrice] = await Promise.all([
          fetchHistoricalPrices(ticker),
          fetchStockPrice(ticker),
        ]);
        histPriceResults[ticker] = histPrices;
        currPriceResults[ticker] = currPrice;
        await new Promise(resolve => setTimeout(resolve, 150));
      }

      setHistoricalPrices(histPriceResults);
      setCurrentPrices(currPriceResults);
      setPriceLoading(false);
    };

    if (!loading) {
      fetchAllPrices();
    }
  }, [loading]);

  if (loading || priceLoading) {
    return (
      <div style={styles.loadingContainer}>
        <div style={styles.spinner} />
        <p>Loading historical prices...</p>
      </div>
    );
  }

  return (
    <div style={styles.pageContent}>
      <h1 style={styles.pageTitle}>Market Cap History</h1>
      <p style={styles.pageSubtitle}>
        Historical market capitalization by quarter (stock price x shares outstanding)
      </p>

      <div style={styles.chartsGrid}>
        {Object.keys(TICKERS).map(ticker => (
          <MarketCapHistoryChart
            key={ticker}
            ticker={ticker}
            allData={allData}
            historicalPrices={historicalPrices[ticker]}
            currentPrice={currentPrices[ticker]}
          />
        ))}
      </div>
    </div>
  );
}

// Price/Sales History Chart Component - shows historical P/S ratio as line chart
function PriceSalesHistoryChart({ ticker, allData, historicalPrices, currentPrice }) {
  const tickerData = allData[ticker];
  const priceMap = historicalPrices || {};
  const sharesMap = tickerData?.historicalShares || {};

  if (!tickerData) {
    return (
      <div style={styles.chartCard}>
        <h3 style={styles.chartHeader}>{ticker}</h3>
        <div style={styles.noData}>No data available</div>
      </div>
    );
  }

  const revenue = tickerData.revenue || [];
  if (revenue.length < 4) {
    return (
      <div style={styles.chartCard}>
        <h3 style={styles.chartHeader}>{ticker}</h3>
        <div style={styles.noData}>Insufficient revenue data</div>
      </div>
    );
  }

  // Calculate historical P/S ratio for each quarter using TTM revenue
  const historyData = [];
  const lastIndex = revenue.length - 1;

  for (let i = 3; i < revenue.length; i++) {
    // Calculate TTM revenue
    let ttmRevenue = 0;
    for (let j = 0; j < 4; j++) {
      ttmRevenue += revenue[i - j]?.value || 0;
    }

    const endDate = revenue[i].endDate;
    const period = endDate.slice(0, 7); // YYYY-MM
    const isLatest = i === lastIndex;

    // Use current price for the most recent quarter, historical for others
    const price = isLatest && currentPrice ? currentPrice : priceMap[period];

    // Get shares - use override first for complex structures like IBKR
    let shares = SHARES_OVERRIDE[ticker];
    if (!shares) {
      const sharesEntries = Object.entries(sharesMap).sort((a, b) => new Date(b[0]) - new Date(a[0]));
      for (const [date, val] of sharesEntries) {
        if (date <= endDate) {
          shares = val;
          break;
        }
      }
      // Fallback to latest shares if no historical data
      if (!shares) shares = tickerData.sharesOutstanding;
    }

    if (price && shares && ttmRevenue > 0) {
      const marketCap = price * shares;
      const psRatio = marketCap / ttmRevenue;
      historyData.push({
        period: isLatest ? 'Current' : period,
        psRatio: psRatio,
        price: price,
        ttmRevenue: ttmRevenue,
      });
    }
  }

  if (historyData.length === 0) {
    return (
      <div style={styles.chartCard}>
        <h3 style={styles.chartHeader}>{ticker}</h3>
        <div style={styles.noData}>Insufficient data for P/S history</div>
      </div>
    );
  }

  const latestPS = historyData[historyData.length - 1]?.psRatio;
  const latestPrice = historyData[historyData.length - 1]?.price;
  const xAxisInterval = Math.max(1, Math.floor(historyData.length / 6));

  return (
    <div style={styles.chartCard}>
      <div style={styles.chartHeaderRow}>
        <h3 style={styles.chartHeader}>{ticker}</h3>
      </div>
      <div style={{ ...styles.chartMeta, marginBottom: '12px' }}>
        <span style={styles.latestValue}>{latestPS?.toFixed(1)}x</span>
        <span style={{ fontSize: '11px', color: '#64748b', marginLeft: '8px' }}>@ ${latestPrice?.toFixed(2)}</span>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={historyData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
          <XAxis
            dataKey="period"
            tick={{ fontSize: 9, fill: '#999' }}
            tickLine={false}
            axisLine={{ stroke: '#e5e7eb' }}
            interval={xAxisInterval}
          />
          <YAxis
            tick={{ fontSize: 9, fill: '#999' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(val) => `${val.toFixed(1)}x`}
          />
          <Tooltip
            contentStyle={styles.tooltip}
            formatter={(val, name, props) => [`${val.toFixed(2)}x @ $${props.payload.price?.toFixed(2)}`, 'P/S Ratio']}
            labelFormatter={(label) => `Quarter: ${label}`}
          />
          <Line
            type="linear"
            dataKey="psRatio"
            stroke="#ec4899"
            strokeWidth={2}
            dot={{ fill: '#ec4899', strokeWidth: 0, r: 3 }}
            activeDot={{ r: 5, fill: '#db2777' }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// Price/Sales History Page
function PriceSalesHistoryPage({ allData, loading }) {
  const [historicalPrices, setHistoricalPrices] = useState({});
  const [currentPrices, setCurrentPrices] = useState({});
  const [priceLoading, setPriceLoading] = useState(true);

  useEffect(() => {
    const fetchAllPrices = async () => {
      const tickers = Object.keys(TICKERS);
      const histPriceResults = {};
      const currPriceResults = {};

      for (const ticker of tickers) {
        const [histPrices, currPrice] = await Promise.all([
          fetchHistoricalPrices(ticker),
          fetchStockPrice(ticker),
        ]);
        histPriceResults[ticker] = histPrices;
        currPriceResults[ticker] = currPrice;
        await new Promise(resolve => setTimeout(resolve, 150));
      }

      setHistoricalPrices(histPriceResults);
      setCurrentPrices(currPriceResults);
      setPriceLoading(false);
    };

    if (!loading) {
      fetchAllPrices();
    }
  }, [loading]);

  if (loading || priceLoading) {
    return (
      <div style={styles.loadingContainer}>
        <div style={styles.spinner} />
        <p>Loading historical prices...</p>
      </div>
    );
  }

  return (
    <div style={styles.pageContent}>
      <h1 style={styles.pageTitle}>Price/Sales History</h1>
      <p style={styles.pageSubtitle}>
        Historical Price to TTM Sales ratio by quarter
      </p>

      <div style={styles.chartsGrid}>
        {Object.keys(TICKERS).map(ticker => (
          <PriceSalesHistoryChart
            key={ticker}
            ticker={ticker}
            allData={allData}
            historicalPrices={historicalPrices[ticker]}
            currentPrice={currentPrices[ticker]}
          />
        ))}
      </div>
    </div>
  );
}

// FCF Multiple Chart Component - Market Cap / TTM FCF for every stock
function FCFMultipleChart({ ticker, allData, price }) {
  const tickerData = allData[ticker];
  const shares = VALUATION_SHARES[ticker] || tickerData?.sharesOutstanding;
  const marketCap = price && shares ? price * shares : null;

  let multiple = null;
  const fcfData = tickerData?.freeCashFlow || [];
  let ttmFCF = null;

  if (tickerData && marketCap && fcfData.length >= 4) {
    ttmFCF = fcfData.slice(-4).reduce((sum, q) => sum + (q.value || 0), 0);
    if (ttmFCF && ttmFCF > 0) {
      multiple = marketCap / ttmFCF;
    }
  }

  const formatMultiple = (val) => {
    if (val === null || val === undefined || !isFinite(val)) return '—';
    if (val < 0) return `${val.toFixed(1)}x`;
    return `${val.toFixed(1)}x`;
  };

  return (
    <div style={styles.chartCard}>
      <div style={styles.chartHeaderRow}>
        <h3 style={styles.chartHeader}>{ticker}</h3>
        <span style={{
          ...styles.growthBadge,
          color: '#4338ca',
          backgroundColor: '#e0e7ff',
        }}>
          Mkt Cap / TTM FCF
        </span>
      </div>
      <div style={styles.valuationDisplay}>
        <span style={styles.valuationNumber}>{formatMultiple(multiple)}</span>
        <span style={styles.valuationSubtext}>
          Stock: ${price?.toFixed(2) || 'N/A'} | Mkt Cap: {marketCap ? `$${(marketCap / 1e9).toFixed(1)}B` : 'N/A'}
          {ttmFCF !== null && <> | TTM FCF: {formatNumber(ttmFCF)}</>}
        </span>
        {ttmFCF !== null && ttmFCF <= 0 && (
          <span style={{ fontSize: '11px', color: '#dc2626', marginTop: '4px' }}>
            Negative TTM FCF
          </span>
        )}
      </div>
    </div>
  );
}

// FCF Multiple Page
function FCFMultiplePage({ allData, loading }) {
  const [prices, setPrices] = useState({});
  const [priceLoading, setPriceLoading] = useState(true);

  useEffect(() => {
    const fetchPrices = async () => {
      const tickers = Object.keys(TICKERS);
      const priceResults = {};
      for (const ticker of tickers) {
        const price = await fetchStockPrice(ticker);
        priceResults[ticker] = price;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      setPrices(priceResults);
      setPriceLoading(false);
    };
    if (!loading) fetchPrices();
  }, [loading]);

  if (loading || priceLoading) {
    return (
      <div style={styles.loadingContainer}>
        <div style={styles.spinner} />
        <p>Loading FCF multiple data...</p>
      </div>
    );
  }

  return (
    <div style={styles.pageContent}>
      <h1 style={styles.pageTitle}>FCF Multiple</h1>
      <p style={styles.pageSubtitle}>
        Market Cap / TTM Free Cash Flow for all companies
      </p>
      <div style={styles.chartsGrid}>
        {Object.keys(TICKERS).map(ticker => (
          <FCFMultipleChart
            key={ticker}
            ticker={ticker}
            allData={allData}
            price={prices[ticker]}
          />
        ))}
      </div>
    </div>
  );
}

// FCF Multiple History Chart Component - historical market cap / TTM FCF as line chart
function FCFMultipleHistoryChart({ ticker, allData, historicalPrices, currentPrice }) {
  const tickerData = allData[ticker];
  const priceMap = historicalPrices || {};
  const sharesMap = tickerData?.historicalShares || {};

  if (!tickerData) {
    return (
      <div style={styles.chartCard}>
        <h3 style={styles.chartHeader}>{ticker}</h3>
        <div style={styles.noData}>No data available</div>
      </div>
    );
  }

  const fcfData = tickerData.freeCashFlow || [];
  if (fcfData.length < 4) {
    return (
      <div style={styles.chartCard}>
        <h3 style={styles.chartHeader}>{ticker}</h3>
        <div style={styles.noData}>Insufficient FCF data</div>
      </div>
    );
  }

  const historyData = [];
  const lastIndex = fcfData.length - 1;

  for (let i = 3; i < fcfData.length; i++) {
    let ttmFCF = 0;
    for (let j = 0; j < 4; j++) {
      ttmFCF += fcfData[i - j]?.value || 0;
    }

    const endDate = fcfData[i].endDate;
    const period = endDate.slice(0, 7);
    const isLatest = i === lastIndex;

    const price = isLatest && currentPrice ? currentPrice : priceMap[period];

    // Get shares - use override first for complex structures like IBKR
    let shares = SHARES_OVERRIDE[ticker];
    if (!shares) {
      const sharesEntries = Object.entries(sharesMap).sort((a, b) => new Date(b[0]) - new Date(a[0]));
      for (const [date, val] of sharesEntries) {
        if (date <= endDate) {
          shares = val;
          break;
        }
      }
      if (!shares) shares = tickerData.sharesOutstanding;
    }

    if (price && shares) {
      const marketCap = price * shares;
      let fcfMultiple = null;
      if (ttmFCF > 0) {
        fcfMultiple = marketCap / ttmFCF;
        if (fcfMultiple > 500) fcfMultiple = null;
      }
      historyData.push({
        period: isLatest ? 'Current' : period,
        fcfMultiple: fcfMultiple,
        price: price,
        ttmFCF: ttmFCF,
      });
    }
  }

  if (historyData.length === 0) {
    return (
      <div style={styles.chartCard}>
        <h3 style={styles.chartHeader}>{ticker}</h3>
        <div style={styles.noData}>Insufficient data for FCF multiple history</div>
      </div>
    );
  }

  const latest = historyData[historyData.length - 1];
  const latestMultiple = latest?.fcfMultiple;
  const latestPrice = latest?.price;
  const xAxisInterval = Math.max(1, Math.floor(historyData.length / 6));

  return (
    <div style={styles.chartCard}>
      <div style={styles.chartHeaderRow}>
        <h3 style={styles.chartHeader}>{ticker}</h3>
      </div>
      <div style={{ ...styles.chartMeta, marginBottom: '12px' }}>
        <span style={styles.latestValue}>{latestMultiple ? `${latestMultiple.toFixed(1)}x` : '—'}</span>
        <span style={{ fontSize: '11px', color: '#64748b', marginLeft: '8px' }}>@ ${latestPrice?.toFixed(2)}</span>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={historyData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
          <XAxis
            dataKey="period"
            tick={{ fontSize: 9, fill: '#999' }}
            tickLine={false}
            axisLine={{ stroke: '#e5e7eb' }}
            interval={xAxisInterval}
          />
          <YAxis
            tick={{ fontSize: 9, fill: '#999' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(val) => val ? `${val.toFixed(0)}x` : ''}
          />
          <Tooltip
            contentStyle={styles.tooltip}
            formatter={(val, name, props) => {
              if (val) return [`${val.toFixed(1)}x`, 'FCF Multiple'];
              return ['Negative FCF', 'TTM FCF'];
            }}
            labelFormatter={(label) => `Quarter: ${label}`}
          />
          <Line
            type="linear"
            dataKey="fcfMultiple"
            stroke="#059669"
            strokeWidth={2}
            dot={{ fill: '#059669', strokeWidth: 0, r: 3 }}
            activeDot={{ r: 5, fill: '#047857' }}
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// FCF Multiple History Page
function FCFMultipleHistoryPage({ allData, loading }) {
  const [historicalPrices, setHistoricalPrices] = useState({});
  const [currentPrices, setCurrentPrices] = useState({});
  const [priceLoading, setPriceLoading] = useState(true);

  useEffect(() => {
    const fetchAllPrices = async () => {
      const tickers = Object.keys(TICKERS);
      const histPriceResults = {};
      const currPriceResults = {};
      for (const ticker of tickers) {
        const [histPrices, currPrice] = await Promise.all([
          fetchHistoricalPrices(ticker),
          fetchStockPrice(ticker),
        ]);
        histPriceResults[ticker] = histPrices;
        currPriceResults[ticker] = currPrice;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      setHistoricalPrices(histPriceResults);
      setCurrentPrices(currPriceResults);
      setPriceLoading(false);
    };
    if (!loading) fetchAllPrices();
  }, [loading]);

  if (loading || priceLoading) {
    return (
      <div style={styles.loadingContainer}>
        <div style={styles.spinner} />
        <p>Loading historical prices...</p>
      </div>
    );
  }

  return (
    <div style={styles.pageContent}>
      <h1 style={styles.pageTitle}>FCF Multiple History</h1>
      <p style={styles.pageSubtitle}>
        Historical Market Cap / TTM Free Cash Flow by quarter (gaps indicate negative FCF)
      </p>
      <div style={styles.chartsGrid}>
        {Object.keys(TICKERS).map(ticker => (
          <FCFMultipleHistoryChart
            key={ticker}
            ticker={ticker}
            allData={allData}
            historicalPrices={historicalPrices[ticker]}
            currentPrice={currentPrices[ticker]}
          />
        ))}
      </div>
    </div>
  );
}

// ============== ALTERNATIVE METRICS COMPONENTS ==============

// Top Tab Navigation for switching between Stock Analysis and Alternative Metrics
function TopTabNav({ activeTab, setActiveTab }) {
  return (
    <div style={styles.topTabNav}>
      <button
        style={{
          ...styles.topTab,
          ...(activeTab === 'stock' ? styles.topTabActive : {}),
        }}
        onClick={() => setActiveTab('stock')}
      >
        Stock Analysis
      </button>
      <button
        style={{
          ...styles.topTab,
          ...(activeTab === 'alternative' ? styles.topTabActive : {}),
        }}
        onClick={() => setActiveTab('alternative')}
      >
        Alternative Metrics
      </button>
    </div>
  );
}

// Format large numbers for alternative metrics
const formatMetricNumber = (num) => {
  if (num === null || num === undefined || isNaN(num)) return 'N/A';
  const absNum = Math.abs(num);
  if (absNum >= 1e12) return `$${(absNum / 1e12).toFixed(2)}T`;
  if (absNum >= 1e9) return `$${(absNum / 1e9).toFixed(2)}B`;
  if (absNum >= 1e6) return `$${(absNum / 1e6).toFixed(2)}M`;
  if (absNum >= 1e3) return `$${(absNum / 1e3).toFixed(0)}K`;
  return `$${absNum.toFixed(2)}`;
};

// Prestocks Prices Grid - displays private company valuations
function PrestocksPricesGrid({ data }) {
  if (!data || !Array.isArray(data)) {
    return <div style={styles.noData}>Loading Prestocks data...</div>;
  }

  return (
    <div style={styles.altSection}>
      <h2 style={styles.altSectionTitle}>PRESTOCKS PRICES</h2>
      <p style={styles.altSectionSubtitle}>Private company valuations</p>
      <div style={styles.prestocksGrid}>
        {data.map((company, idx) => (
          <div key={idx} style={styles.prestocksCard}>
            <div style={styles.prestocksCompany}>{company.company}</div>
            <div style={styles.prestocksValuation}>
              {company.valuation || 'N/A'}
            </div>
            {company.pricePerShare && (
              <div style={styles.prestocksPrice}>
                Per share: {company.pricePerShare}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Generic Time Series Chart for metrics with date/value data
function TimeSeriesChart({ data, title, subtitle, yAxisLabel, color, dataKey, formatValue, chartType = 'line' }) {
  if (!data || !Array.isArray(data) || data.length === 0) {
    return (
      <div style={styles.altChartCard}>
        <h3 style={styles.altChartTitle}>{title}</h3>
        <div style={styles.noData}>No data available</div>
      </div>
    );
  }

  const formatter = formatValue || formatMetricNumber;
  const key = dataKey || 'value';

  const xAxis = (
    <XAxis
      dataKey="date"
      tick={{ fontSize: 9, fill: '#999' }}
      tickLine={false}
      axisLine={{ stroke: '#e5e7eb' }}
      tickFormatter={(val) => {
        const d = new Date(val);
        return `${d.getMonth() + 1}/${d.getFullYear().toString().slice(2)}`;
      }}
      interval="preserveStartEnd"
      minTickGap={24}
    />
  );
  const yAxis = (
    <YAxis
      tick={{ fontSize: 9, fill: '#999' }}
      tickLine={false}
      axisLine={false}
      tickFormatter={formatter}
      width={60}
    />
  );
  const tooltip = (
    <Tooltip
      contentStyle={styles.tooltip}
      formatter={(val) => [formatter(val), yAxisLabel || 'Value']}
      labelFormatter={(label) => new Date(label).toLocaleDateString()}
    />
  );

  return (
    <div style={styles.altChartCard}>
      <h3 style={styles.altChartTitle}>{title}</h3>
      {subtitle && <p style={styles.altChartSubtitle}>{subtitle}</p>}
      <ResponsiveContainer width="100%" height={200}>
        {chartType === 'bar' ? (
          <BarChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
            {xAxis}
            {yAxis}
            {tooltip}
            <Bar dataKey={key} fill={color || '#6366f1'} radius={[2, 2, 0, 0]} />
          </BarChart>
        ) : (
          <LineChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
            {xAxis}
            {yAxis}
            {tooltip}
            <Line
              type="monotone"
              dataKey={key}
              stroke={color || '#6366f1'}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

// CryptoPunks Price Card
function CryptoPunksCard({ data }) {
  if (!data) {
    return (
      <div style={styles.altChartCard}>
        <h3 style={styles.altChartTitle}>CRYPTOPUNKS FLOOR PRICE</h3>
        <div style={styles.noData}>Loading...</div>
      </div>
    );
  }

  return (
    <div style={styles.altChartCard}>
      <h3 style={styles.altChartTitle}>CRYPTOPUNKS FLOOR PRICE</h3>
      <p style={styles.altChartSubtitle}>Current floor price</p>
      <div style={styles.cryptopunksDisplay}>
        <div style={styles.cryptopunksETH}>
          {data.floorPriceETH ? `${data.floorPriceETH.toFixed(2)} ETH` : 'N/A'}
        </div>
        <div style={styles.cryptopunksUSD}>
          {data.floorPriceUSD ? `$${data.floorPriceUSD.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : ''}
        </div>
        {data.ethPrice && (
          <div style={styles.cryptopunksRate}>
            ETH Price: ${data.ethPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </div>
        )}
      </div>
    </div>
  );
}

// Prestocks Volume Chart (bar chart by token)
function PrestocksVolumeChart({ data }) {
  if (!data || !data.volumeByToken || data.volumeByToken.length === 0) {
    return (
      <div style={styles.altChartCard}>
        <h3 style={styles.altChartTitle}>PRESTOCKS SPOT VOLUME BY TOKEN</h3>
        <div style={styles.noData}>No volume data available</div>
      </div>
    );
  }

  return (
    <div style={{ ...styles.altChartCard, gridColumn: '1 / -1' }}>
      <h3 style={styles.altChartTitle}>PRESTOCKS SPOT VOLUME BY TOKEN</h3>
      <p style={styles.altChartSubtitle}>Trading volume by token</p>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data.volumeByToken} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
          <XAxis
            dataKey="token"
            tick={{ fontSize: 9, fill: '#999' }}
            tickLine={false}
            axisLine={{ stroke: '#e5e7eb' }}
          />
          <YAxis
            tick={{ fontSize: 9, fill: '#999' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={formatMetricNumber}
          />
          <Tooltip
            contentStyle={styles.tooltip}
            formatter={(val) => [formatMetricNumber(val), 'Volume']}
          />
          <Bar dataKey="volume" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Roblox CCU Card (current concurrent users)
function RobloxCCUCard({ data }) {
  if (!data) {
    return (
      <div style={styles.altChartCard}>
        <h3 style={styles.altChartTitle}>ROBLOX CONCURRENT USERS</h3>
        <div style={styles.noData}>Loading...</div>
      </div>
    );
  }

  return (
    <div style={styles.altChartCard}>
      <h3 style={styles.altChartTitle}>ROBLOX CONCURRENT USERS</h3>
      <p style={styles.altChartSubtitle}>Current concurrent players</p>
      <div style={styles.cryptopunksDisplay}>
        <div style={styles.cryptopunksETH}>
          {data.currentCCU ? `${(data.currentCCU / 1e6).toFixed(2)}M` : 'N/A'}
        </div>
        <div style={styles.cryptopunksRate}>
          Live concurrent users on Roblox platform
        </div>
      </div>
    </div>
  );
}

// Main Alternative Metrics Page
function AlternativeMetricsPage() {
  const [metricsData, setMetricsData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  // Static (GitHub Pages) build reads pre-generated data; dev hits the live server
  const metricsUrl = STATIC_BUILD ? `${DATA_BASE}data/metrics.json` : '/api/metrics/all';

  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        const response = await fetch(metricsUrl);
        if (!response.ok) throw new Error('Failed to fetch metrics');
        const data = await response.json();
        setMetricsData(data);
        setLastUpdated(new Date());
        setLoading(false);
      } catch (err) {
        console.error('Error fetching metrics:', err);
        setError(err.message);
        setLoading(false);
      }
    };

    fetchMetrics();
  }, []);

  const handleRefresh = async () => {
    setLoading(true);
    try {
      // No scraper server in a static build - just re-read the baked data
      if (!STATIC_BUILD) {
        await fetch('/api/refresh/all', { method: 'POST' });
      }
      const response = await fetch(metricsUrl);
      const data = await response.json();
      setMetricsData(data);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  if (loading && !metricsData) {
    return (
      <div style={styles.loadingContainer}>
        <div style={styles.spinner}></div>
        <p>Loading alternative metrics...</p>
      </div>
    );
  }

  if (error && !metricsData) {
    return (
      <div style={styles.altErrorBox}>
        <h3>Error Loading Metrics</h3>
        <p>{error}</p>
        <button onClick={handleRefresh} style={styles.retryButton}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div style={styles.altPageContent}>
      <div style={styles.altPageHeader}>
        <div>
          <h1 style={styles.pageTitle}>Alternative Metrics</h1>
          <p style={styles.pageSubtitle}>
            Scraped data from various sources
            {lastUpdated && ` • Last updated: ${lastUpdated.toLocaleTimeString()}`}
          </p>
        </div>
        {!STATIC_BUILD && (
          <button onClick={handleRefresh} style={styles.refreshButton} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh Data'}
          </button>
        )}
      </div>

      {/* Prestocks Prices */}
      <PrestocksPricesGrid data={metricsData?.prestocksPrices?.data} />

      {/* Charts Grid */}
      <div style={styles.altChartsGrid}>
        {/* Roblox CCU */}
        <RobloxCCUCard data={metricsData?.robloxCCU?.data} />

        {/* CryptoPunks Price */}
        <CryptoPunksCard data={metricsData?.cryptopunksPrice?.data} />

        {/* Kalshi Daily Volume */}
        <TimeSeriesChart
          data={metricsData?.kalshiVolume?.data}
          title="KALSHI DAILY VOLUME"
          subtitle="Prediction market trading volume (from Sept 2025)"
          yAxisLabel="Volume"
          color="#0ea5e9"
          dataKey="volume"
          chartType="bar"
        />

        {/* Hyperliquid Revenue */}
        <TimeSeriesChart
          data={metricsData?.hyperliquidRevenue?.data}
          title="HYPERLIQUID DAILY REVENUE"
          subtitle="Daily protocol revenue"
          yAxisLabel="Revenue"
          color="#10b981"
          dataKey="revenue"
          chartType="bar"
        />

        {/* USDC Marketcap */}
        <TimeSeriesChart
          data={metricsData?.usdcMarketcap?.data}
          title="USDC TOTAL MARKETCAP"
          subtitle="Market cap history since 2019"
          yAxisLabel="Market Cap"
          color="#6366f1"
          dataKey="marketcap"
        />

        {/* Prestocks Volume */}
        <PrestocksVolumeChart data={metricsData?.prestocksVolume?.data} />
      </div>
    </div>
  );
}

// Navigation Sidebar
function Sidebar() {
  const navItems = [
    { path: '/', label: 'Revenue', icon: '📊' },
    { path: '/gross-profit', label: 'Gross Profit', icon: '📊' },
    { path: '/revenue-growth', label: 'Revenue Growth', icon: '📈' },
    { path: '/operating-income', label: 'Operating Income', icon: '💼' },
    { path: '/net-income', label: 'Net Income', icon: '💰' },
    { path: '/free-cash-flow', label: 'Free Cash Flow', icon: '💵' },
    { path: '/margins', label: 'Margins', icon: '📊' },
    { path: '/market-cap-history', label: 'Market Cap History', icon: '📈' },
    { path: '/price-sales-history', label: 'Price/Sales History', icon: '📉' },
    { path: '/valuation-multiples', label: 'Valuation Multiples', icon: '💹' },
    { path: '/valuation-history', label: 'Valuation History', icon: '📉' },
    { path: '/fcf-multiple', label: 'FCF Multiple', icon: '💵' },
    { path: '/fcf-multiple-history', label: 'FCF Multiple History', icon: '📉' },
  ];

  return (
    <nav style={styles.sidebar}>
      <div style={styles.logo}>
        <h1 style={styles.logoText}>Stock Dashboard</h1>
        <p style={styles.logoSubtext}>Fundamental Analysis</p>
      </div>

      <div style={styles.navSection}>
        <p style={styles.navLabel}>METRICS</p>
        {navItems.map(item => (
          <NavLink
            key={item.path}
            to={item.path}
            style={({ isActive }) => ({
              ...styles.navItem,
              backgroundColor: isActive ? '#e0e7ff' : 'transparent',
              color: isActive ? '#4338ca' : '#374151',
              fontWeight: isActive ? '600' : '400',
            })}
          >
            <span style={styles.navIcon}>{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </div>

      <div style={styles.tickerSection}>
        <p style={styles.navLabel}>TICKERS</p>
        <div style={styles.tickerList}>
          {Object.keys(TICKERS).map(t => (
            <span key={t} style={styles.tickerBadge}>{t}</span>
          ))}
        </div>
      </div>

      <div style={styles.dataSource}>
        <p style={styles.dataSourceText}>Data: SEC EDGAR</p>
      </div>
    </nav>
  );
}

export default function App() {
  const [allData, setAllData] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('stock');

  useEffect(() => {
    const fetchAllData = async () => {
      try {
        const entries = Object.entries(TICKERS);
        const results = await Promise.all(
          entries.map(([ticker, cik]) => fetchTickerData(ticker, cik))
        );

        const dataMap = {};
        results.forEach(r => {
          dataMap[r.ticker] = r;
        });

        setAllData(dataMap);
        setLoading(false);
      } catch (err) {
        console.error('Fetch error:', err);
        setError(err.message);
        setLoading(false);
      }
    };

    fetchAllData();
  }, []);

  if (error && activeTab === 'stock') {
    return (
      <div style={styles.errorContainer}>
        <div style={styles.errorBox}>
          <h2>Error Loading Data</h2>
          <p>{error}</p>
          <button onClick={() => window.location.reload()} style={styles.retryButton}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '') || '/'}>
      <div style={styles.appContainer}>
        <TopTabNav activeTab={activeTab} setActiveTab={setActiveTab} />
        <div style={styles.container}>
          {activeTab === 'stock' ? (
            <>
              <Sidebar />
              <main style={styles.main}>
                <Routes>
            <Route path="/" element={
              <MetricPage allData={allData} loading={loading} metric="revenue" title="Revenue" color="#0ea5e9" showQuarterly />
            } />
            <Route path="/gross-profit" element={
              <MetricPage allData={allData} loading={loading} metric="grossProfit" title="Gross Profit" color="#14b8a6" />
            } />
            <Route path="/revenue-growth" element={
              <MetricPage allData={allData} loading={loading} metric="revenue" title="Revenue" color="#0ea5e9" showGrowthOnly />
            } />
            <Route path="/operating-income" element={
              <MetricPage allData={allData} loading={loading} metric="operatingIncome" title="Operating Income" color="#8b5cf6" />
            } />
            <Route path="/net-income" element={
              <MetricPage allData={allData} loading={loading} metric="netIncome" title="Net Income" color="#10b981" />
            } />
            <Route path="/free-cash-flow" element={
              <MetricPage allData={allData} loading={loading} metric="freeCashFlow" title="Free Cash Flow" color="#f59e0b" showQuarterly />
            } />
            <Route path="/margins" element={
              <MarginsPage allData={allData} loading={loading} />
            } />
            <Route path="/market-cap-history" element={
              <MarketCapHistoryPage allData={allData} loading={loading} />
            } />
            <Route path="/price-sales-history" element={
              <PriceSalesHistoryPage allData={allData} loading={loading} />
            } />
            <Route path="/valuation-multiples" element={
              <ValuationMultiplesPage allData={allData} loading={loading} />
            } />
            <Route path="/valuation-history" element={
              <ValuationHistoryPage allData={allData} loading={loading} />
            } />
            <Route path="/fcf-multiple" element={
              <FCFMultiplePage allData={allData} loading={loading} />
            } />
            <Route path="/fcf-multiple-history" element={
              <FCFMultipleHistoryPage allData={allData} loading={loading} />
            } />
          </Routes>
        </main>
            </>
          ) : (
            <main style={styles.mainAlt}>
              <AlternativeMetricsPage />
            </main>
          )}
        </div>
      </div>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
        a { text-decoration: none; }
      `}</style>
    </BrowserRouter>
  );
}

const styles = {
  appContainer: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: '100vh',
  },
  topTabNav: {
    display: 'flex',
    gap: '0',
    backgroundColor: '#1e293b',
    padding: '0 20px',
    height: '48px',
    alignItems: 'stretch',
  },
  topTab: {
    padding: '0 24px',
    border: 'none',
    backgroundColor: 'transparent',
    color: '#94a3b8',
    fontSize: '14px',
    fontWeight: '500',
    cursor: 'pointer',
    borderBottom: '2px solid transparent',
    transition: 'all 0.2s',
  },
  topTabActive: {
    color: '#ffffff',
    borderBottomColor: '#6366f1',
    backgroundColor: 'rgba(99, 102, 241, 0.1)',
  },
  container: {
    display: 'flex',
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  sidebar: {
    width: '220px',
    backgroundColor: '#ffffff',
    borderRight: '1px solid #e2e8f0',
    padding: '20px 0',
    position: 'fixed',
    height: '100vh',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
  },
  logo: {
    padding: '0 20px 20px',
    borderBottom: '1px solid #e2e8f0',
  },
  logoText: {
    fontSize: '17px',
    fontWeight: '700',
    color: '#1e293b',
  },
  logoSubtext: {
    fontSize: '11px',
    color: '#64748b',
    marginTop: '2px',
  },
  navSection: {
    padding: '16px 12px',
    flex: 1,
  },
  navLabel: {
    fontSize: '10px',
    fontWeight: '600',
    color: '#94a3b8',
    letterSpacing: '0.5px',
    padding: '0 8px',
    marginBottom: '8px',
  },
  navItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '9px 12px',
    borderRadius: '6px',
    fontSize: '13px',
    marginBottom: '2px',
    transition: 'all 0.15s',
  },
  navIcon: {
    fontSize: '14px',
  },
  tickerSection: {
    padding: '16px 12px',
    borderTop: '1px solid #e2e8f0',
  },
  tickerList: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
    padding: '0 8px',
  },
  tickerBadge: {
    fontSize: '10px',
    fontWeight: '600',
    color: '#475569',
    backgroundColor: '#f1f5f9',
    padding: '4px 8px',
    borderRadius: '4px',
  },
  dataSource: {
    padding: '12px 20px',
    borderTop: '1px solid #e2e8f0',
  },
  dataSourceText: {
    fontSize: '10px',
    color: '#94a3b8',
  },
  main: {
    flex: 1,
    marginLeft: '220px',
    padding: '24px 32px',
  },
  pageContent: {
    maxWidth: '1400px',
  },
  pageTitle: {
    fontSize: '24px',
    fontWeight: '700',
    color: '#1e293b',
    marginBottom: '4px',
  },
  pageSubtitle: {
    fontSize: '13px',
    color: '#64748b',
    marginBottom: '24px',
  },
  chartsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: '20px',
  },
  chartCard: {
    backgroundColor: '#ffffff',
    borderRadius: '8px',
    border: '1px solid #e2e8f0',
    padding: '20px',
  },
  chartHeaderRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '16px',
  },
  chartHeader: {
    fontSize: '15px',
    fontWeight: '600',
    color: '#1e293b',
  },
  chartLabel: {
    fontSize: '11px',
    fontWeight: '500',
    color: '#64748b',
    marginBottom: '4px',
    textTransform: 'uppercase',
    letterSpacing: '0.3px',
  },
  chartMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  latestValue: {
    fontSize: '16px',
    fontWeight: '700',
    color: '#1e293b',
  },
  growthBadge: {
    fontSize: '11px',
    fontWeight: '600',
    padding: '3px 8px',
    borderRadius: '4px',
  },
  noData: {
    height: '260px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#94a3b8',
    fontSize: '13px',
  },
  valuationDisplay: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '200px',
    gap: '12px',
  },
  valuationNumber: {
    fontSize: '48px',
    fontWeight: '700',
    color: '#1e293b',
  },
  valuationSubtext: {
    fontSize: '13px',
    color: '#64748b',
  },
  tooltip: {
    backgroundColor: '#ffffff',
    border: '1px solid #e2e8f0',
    borderRadius: '6px',
    boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)',
    fontSize: '12px',
  },
  loadingContainer: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '400px',
    color: '#64748b',
  },
  spinner: {
    width: '36px',
    height: '36px',
    border: '3px solid #e2e8f0',
    borderTop: '3px solid #6366f1',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
    marginBottom: '16px',
  },
  errorContainer: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f8fafc',
  },
  errorBox: {
    backgroundColor: '#ffffff',
    border: '1px solid #fecaca',
    borderRadius: '8px',
    padding: '30px',
    textAlign: 'center',
    maxWidth: '400px',
  },
  retryButton: {
    marginTop: '16px',
    padding: '10px 20px',
    backgroundColor: '#6366f1',
    color: '#ffffff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '14px',
    fontWeight: '500',
    cursor: 'pointer',
  },
  // Alternative Metrics Styles
  mainAlt: {
    flex: 1,
    padding: '24px 32px',
    backgroundColor: '#f8fafc',
  },
  altPageContent: {
    maxWidth: '1400px',
  },
  altPageHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: '24px',
  },
  refreshButton: {
    padding: '10px 20px',
    backgroundColor: '#6366f1',
    color: '#ffffff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '14px',
    fontWeight: '500',
    cursor: 'pointer',
    transition: 'background-color 0.2s',
  },
  altSection: {
    marginBottom: '32px',
  },
  altSectionTitle: {
    fontSize: '12px',
    fontWeight: '600',
    color: '#64748b',
    letterSpacing: '0.5px',
    marginBottom: '4px',
  },
  altSectionSubtitle: {
    fontSize: '13px',
    color: '#94a3b8',
    marginBottom: '16px',
  },
  prestocksGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '16px',
  },
  prestocksCard: {
    backgroundColor: '#ffffff',
    borderRadius: '8px',
    border: '1px solid #e2e8f0',
    padding: '20px',
    textAlign: 'center',
  },
  prestocksCompany: {
    fontSize: '14px',
    fontWeight: '600',
    color: '#1e293b',
    marginBottom: '8px',
  },
  prestocksValuation: {
    fontSize: '24px',
    fontWeight: '700',
    color: '#6366f1',
    marginBottom: '4px',
  },
  prestocksPrice: {
    fontSize: '12px',
    color: '#64748b',
  },
  altChartsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: '20px',
  },
  altChartCard: {
    backgroundColor: '#ffffff',
    borderRadius: '8px',
    border: '1px solid #e2e8f0',
    padding: '20px',
  },
  altChartTitle: {
    fontSize: '12px',
    fontWeight: '600',
    color: '#64748b',
    letterSpacing: '0.5px',
    marginBottom: '4px',
  },
  altChartSubtitle: {
    fontSize: '12px',
    color: '#94a3b8',
    marginBottom: '16px',
  },
  cryptopunksDisplay: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '150px',
    gap: '8px',
  },
  cryptopunksETH: {
    fontSize: '32px',
    fontWeight: '700',
    color: '#1e293b',
  },
  cryptopunksUSD: {
    fontSize: '20px',
    fontWeight: '600',
    color: '#6366f1',
  },
  cryptopunksRate: {
    fontSize: '12px',
    color: '#94a3b8',
    marginTop: '8px',
  },
  altErrorBox: {
    backgroundColor: '#ffffff',
    border: '1px solid #fecaca',
    borderRadius: '8px',
    padding: '30px',
    textAlign: 'center',
    maxWidth: '400px',
    margin: '60px auto',
  },
};
