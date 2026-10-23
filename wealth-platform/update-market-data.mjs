import fs from "node:fs/promises";
import path from "node:path";

const dataPath = path.resolve(process.env.VW_DATA_PATH || "data/portfolio.json");
const data = JSON.parse(await fs.readFile(dataPath, "utf8"));
const now = new Date();
const warnings = [];
let updated = 0;

const isoDate = date => date.toISOString().slice(0, 10);
const finite = value => value !== null && value !== undefined && String(value).trim() !== "" && Number.isFinite(Number(value));
const positive = value => finite(value) && Number(value) > 0;
const percentReturn = (end, start) => finite(end) && finite(start) && Number(start) !== 0 ? (Number(end) / Number(start) - 1) * 100 : null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function pointOnOrBefore(points, timestamp) {
  let candidate = null;
  for (const point of points) {
    if (point.timestamp <= timestamp) candidate = point;
    else break;
  }
  return candidate;
}

async function yahooHistory(symbol, expectedCurrency) {
  const start = new Date(Date.UTC(now.getUTCFullYear() - 1, 11, 1));
  const end = new Date(now.getTime() + 86400000);
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set("period1", String(Math.floor(start.getTime() / 1000)));
  url.searchParams.set("period2", String(Math.floor(end.getTime() / 1000)));
  url.searchParams.set("interval", "1d");
  url.searchParams.set("events", "div,splits");
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 Virtual-Wealth-Demo/1.0", "Accept": "application/json" }, signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  if (!result) throw new Error(payload?.chart?.error?.description || "No chart data");
  const currency = result.meta?.currency;
  if (expectedCurrency && currency && currency !== expectedCurrency) throw new Error(`Currency ${currency}, expected ${expectedCurrency}`);
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const adjusted = result.indicators?.adjclose?.[0]?.adjclose || closes;
  const points = timestamps.map((timestamp, index) => ({
    timestamp: timestamp * 1000,
    date: isoDate(new Date(timestamp * 1000)),
    close: Number(closes[index]),
    adjusted: Number(adjusted[index] ?? closes[index]),
  })).filter(point => positive(point.close) && positive(point.adjusted)).sort((a, b) => a.timestamp - b.timestamp);
  if (!points.length) throw new Error("No usable closing prices");
  // Before the scheduled after-close run, exclude every point timestamped on
  // the current UTC date. Some feeds can expose more than one forming point.
  const completedPoints = now.getUTCHours() < 18
    ? points.filter(point => point.date < isoDate(now))
    : points;
  if (!completedPoints.length) throw new Error("No completed daily session available yet");
  const latest = completedPoints.at(-1);
  const oneMonthDate = new Date(latest.timestamp);
  oneMonthDate.setUTCMonth(oneMonthDate.getUTCMonth() - 1);
  const ytdDate = Date.UTC(new Date(latest.timestamp).getUTCFullYear(), 0, 1) - 1;
  const oneMonth = pointOnOrBefore(points, oneMonthDate.getTime());
  const ytd = pointOnOrBefore(points, ytdDate);
  return {
    symbol,
    currency,
    date: latest.date,
    timestamp: new Date(latest.timestamp).toISOString(),
    price: latest.close,
    adjusted: latest.adjusted,
    oneMonth,
    ytd,
    performance1M: percentReturn(latest.adjusted, oneMonth?.adjusted),
    performanceYTD: percentReturn(latest.adjusted, ytd?.adjusted),
  };
}

const fxCache = new Map();
async function fxHistory(priceCurrency) {
  if (!priceCurrency || priceCurrency === "EUR") {
    return { price: 1, adjusted: 1, oneMonth: { adjusted: 1 }, ytd: { adjusted: 1 }, timestamp: now.toISOString() };
  }
  if (priceCurrency !== "USD") throw new Error(`No FX feed configured for ${priceCurrency}/EUR`);
  if (!fxCache.has(priceCurrency)) {
    fxCache.set(priceCurrency, yahooHistory("EURUSD=X", "USD").then(quote => ({
      ...quote,
      price: 1 / quote.price,
      adjusted: 1 / quote.adjusted,
      oneMonth: quote.oneMonth ? { ...quote.oneMonth, adjusted: 1 / quote.oneMonth.adjusted } : null,
      ytd: quote.ytd ? { ...quote.ytd, adjusted: 1 / quote.ytd.adjusted } : null,
    })));
  }
  return fxCache.get(priceCurrency);
}

function baseMarketValue(row, price, fxRate) {
  if (!finite(row.quantity)) return Number(row.marketValue || 0);
  const accrued = Number(row.currentAccruedPer100 || 0);
  return row.quoteConvention === "per100"
    ? Number(row.quantity) / 100 * (Number(price) + accrued) * fxRate
    : Number(row.quantity) * Number(price) * fxRate;
}

function basePerformance(endPrice, endFx, startPrice, startFx) {
  return percentReturn(Number(endPrice) * Number(endFx), Number(startPrice) * Number(startFx));
}

async function updateExchangeTraded(row) {
  if (row.updateMode !== "automatic") return null;
  const symbols = [...new Set([...(Array.isArray(row.priceSymbols) ? row.priceSymbols : []), row.priceSymbol].filter(Boolean))];
  if (!symbols.length) {
    warnings.push(`${row.ticker || row.asset}: no price symbol configured`);
    return null;
  }
  let lastError;
  for (const symbol of symbols) {
    try {
      const quote = await yahooHistory(symbol, row.priceCurrency || row.currency);
      const fx = await fxHistory(row.priceCurrency || row.currency);
      row.price = quote.price;
      row.priceSymbol = quote.symbol;
      row.priceTimestamp = quote.timestamp;
      row.priceSource = "Yahoo Finance chart feed · indicative/delayed";
      row.currentFxRateToBase = fx.price;
      row.performance1M = quote.oneMonth && fx.oneMonth ? basePerformance(quote.adjusted, fx.adjusted, quote.oneMonth.adjusted, fx.oneMonth.adjusted) : null;
      row.performanceYTD = quote.ytd && fx.ytd ? basePerformance(quote.adjusted, fx.adjusted, quote.ytd.adjusted, fx.ytd.adjusted) : null;
      if (finite(row.quantity)) row.marketValue = baseMarketValue(row, quote.price, fx.price);
      if (finite(row.initialCost)) row.totalPL = row.marketValue - Number(row.initialCost);
      if (finite(row.purchasePrice)) row.performanceSincePurchase = basePerformance(quote.price, fx.price, row.purchasePrice, Number(row.purchaseFxRateToBase || 1));
      row.stale = false;
      row.status = "Updated";
      updated += 1;
      return quote.date;
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  row.stale = true;
  warnings.push(`${row.ticker || row.asset}: ${lastError?.message || "update failed"}`);
  return null;
}

async function refreshManualRow(row) {
  const fx = await fxHistory(row.priceCurrency || row.currency);
  row.currentFxRateToBase = fx.price;
  row.marketValue = baseMarketValue(row, row.price, fx.price);
  if (finite(row.initialCost)) row.totalPL = row.marketValue - Number(row.initialCost);
  if (finite(row.purchasePrice)) row.performanceSincePurchase = basePerformance(row.price, fx.price, row.purchasePrice, Number(row.purchaseFxRateToBase || 1));
}

function rateForBalance(schedule, date, balance) {
  const day = isoDate(date);
  const period = schedule.find(item => day >= item.from && day <= item.to);
  if (!period) return null;
  let remaining = balance;
  let previousCap = 0;
  let annualInterest = 0;
  for (const band of period.bands || []) {
    const cap = Number(band.upTo);
    const amount = Math.max(0, Math.min(remaining, cap - previousCap));
    annualInterest += amount * Number(band.rate);
    remaining -= amount;
    previousCap = cap;
    if (remaining <= 0) break;
  }
  return balance ? annualInterest / balance : 0;
}

function updateDeposit(row, valuationDate) {
  if (row.updateMode !== "rate-schedule" || !finite(row.openingBalance) || !row.purchaseDate) return;
  const schedule = Array.isArray(row.rateSchedule) ? row.rateSchedule : [];
  let balance = Number(row.openingBalance);
  let cursor = new Date(`${row.purchaseDate}T00:00:00Z`);
  const end = new Date(`${valuationDate}T00:00:00Z`);
  let lastRate = null;
  while (cursor < end) {
    const rate = rateForBalance(schedule, cursor, balance);
    if (rate === null) {
      row.stale = true;
      warnings.push(`${row.asset}: rate schedule expired on ${isoDate(cursor)}`);
      break;
    }
    lastRate = rate;
    balance += balance * rate / 365;
    cursor = new Date(cursor.getTime() + 86400000);
  }
  row.marketValue = balance;
  row.interestEarned = balance - Number(row.openingBalance);
  row.performanceSincePurchase = percentReturn(balance, row.openingBalance);
  row.annualRate = lastRate === null ? row.annualRate : lastRate * 100;
  row.priceTimestamp = `${valuationDate}T00:00:00.000Z`;
}

async function updateInPool(rows, concurrency = 3) {
  const results = new Array(rows.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < rows.length) {
      const index = nextIndex++;
      results[index] = await updateExchangeTraded(rows[index]);
      await sleep(250);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  return results;
}

const automaticRows = [...data.positions, ...data.liquidity].filter(row => row.updateMode === "automatic");
const datedUpdates = (await updateInPool(automaticRows)).filter(Boolean);

if (!updated) throw new Error(`No market prices updated. ${warnings.join(" | ")}`);
const valuationDate = datedUpdates.sort().at(-1);
await Promise.all(data.positions.filter(row => row.updateMode === "manual").map(refreshManualRow));
for (const row of data.liquidity) updateDeposit(row, valuationDate);

for (const client of data.clients) {
  const positions = data.positions.filter(row => row.clientId === client.id);
  const alternatives = data.alternatives.filter(row => row.clientId === client.id);
  const liquidity = data.liquidity.filter(row => row.clientId === client.id);
  const portfolioValue = positions.reduce((sum, row) => sum + Number(row.marketValue || 0), 0);
  const portfolioCash = Number(data._meta?.portfolioCash || 0);
  const capitalAvailable = Number(data._meta?.capitalAvailable || 5_000_000);
  const nav = portfolioValue + portfolioCash;
  const totalPL = nav - capitalAvailable;
  positions.forEach(row => { row.actualWeight = portfolioValue ? Number(row.marketValue) / portfolioValue * 100 : 0; });
  client.cash_value = liquidity.reduce((sum, row) => sum + Number(row.marketValue || 0), 0);
  client.cash_weight = Number(client.investable_assets) ? client.cash_value / Number(client.investable_assets) * 100 : 0;
  client.current_investable_assets = portfolioValue + alternatives.reduce((sum, row) => sum + Number(row.marketValue || 0), 0);
  client.model_return_since_entry = capitalAvailable ? totalPL / capitalAvailable * 100 : null;
  client.asOf = valuationDate;
}

const investedCurrentValue = data.positions.reduce((sum, row) => sum + Number(row.marketValue || 0), 0);
const portfolioCash = Number(data._meta?.portfolioCash || 0);
const publicInitialCost = Number(data._meta?.capitalAvailable || 5_000_000);
const publicCurrentValue = investedCurrentValue + portfolioCash;
const publicPL = publicCurrentValue - publicInitialCost;
const unrealizedPL = data.positions.reduce((sum, row) => sum + Number(row.totalPL || 0), 0);
const manualRows = data.positions.filter(row => row.updateMode === "manual").map(row => row.ticker || row.asset);
data._meta.generatedAt = now.toISOString();
data._meta.valuationDate = valuationDate;
data._meta.priceMode = "mixed-automatic-and-manual";
data._meta.publicCurrentValue = publicCurrentValue;
data._meta.publicInitialCost = publicInitialCost;
data._meta.publicPL = publicPL;
data._meta.unrealizedPL = unrealizedPL;
data._meta.modelReturnSinceEntry = publicInitialCost ? publicPL / publicInitialCost * 100 : null;
data._meta.marketDataCoverage = { automaticUpdated: updated, manualInstruments: manualRows.length };
data._meta.warnings = [
  "Exchange-traded prices use an indicative delayed public feed and should be checked before real-world use.",
  manualRows.length ? `Manual clean-price instruments: ${manualRows.join(", ")}.` : null,
  ...warnings,
].filter(Boolean);

await fs.writeFile(dataPath, JSON.stringify(data, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ valuationDate, automaticUpdated: updated, manualInstruments: manualRows.length, warnings }, null, 2));
