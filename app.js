/* =====================================================================
   Virtual Wealth Portfolio Platform — app.js
   Clean read-only version. Static frontend only. No backend, no writes.
   Reads published Google Sheets CSV links and displays fictional data.
   ===================================================================== */

"use strict";

/* ---------------------------------------------------------------------
   1. Data sources
   --------------------------------------------------------------------- */
const SHEET = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRUWTm9jWxN9oyJG0o0VReM-rcZnbPJWnTcdKhGLA-CKYjihIV63jVm1baWBVhs7NmRtNnvRLvXT56F/pub";

const SOURCES = {
  clients:     { label: "Clients",             url: `${SHEET}?gid=0&single=true&output=csv` },
  financial:   { label: "Financial Assets",    url: `${SHEET}?gid=1095770554&single=true&output=csv` },
  real:        { label: "Real Assets",         url: `${SHEET}?gid=95223140&single=true&output=csv` },
  tax:         { label: "Tax Planning",        url: `${SHEET}?gid=272082907&single=true&output=csv` },
  wealth:      { label: "Wealth Planning",     url: `${SHEET}?gid=374990790&single=true&output=csv` },
  succession:  { label: "Succession Planning", url: `${SHEET}?gid=1810567517&single=true&output=csv` },
  methodology: { label: "Methodology",         url: `${SHEET}?gid=1065951101&single=true&output=csv` },
};

const DB = {
  clients: [],
  financial: [],
  real: [],
  tax: [],
  wealth: [],
  succession: [],
  methodology: [],
};

const ERRORS = {};
let charts = [];

/* ---------------------------------------------------------------------
   2. Parsing and helpers
   --------------------------------------------------------------------- */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') {
        row.push(field);
        field = "";
      } else if (c === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (c !== '\r') {
        field += c;
      }
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function normKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function toRecords(rows) {
  if (!rows.length) return [];

  const headers = rows[0].map((h) => String(h || "").trim());
  const keys = headers.map(normKey);
  const out = [];

  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (!cells || cells.every((c) => String(c || "").trim() === "")) continue;

    const rec = { __headers: headers, __keys: keys };
    keys.forEach((key, idx) => {
      if (key) rec[key] = String(cells[idx] ?? "").trim();
    });
    out.push(rec);
  }

  return out;
}

function field(record, ...labels) {
  for (const label of labels) {
    const key = normKey(label);
    if (record && record[key] !== undefined && String(record[key]).trim() !== "") {
      return record[key];
    }
  }
  return "";
}

function publishedOnly(records) {
  const hasStatus = records.some((r) => r.status !== undefined);
  if (!hasStatus) return records;
  return records.filter((r) => normKey(r.status) === "published");
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cell(value) {
  return value === undefined || value === null || String(value).trim() === "" ? "—" : esc(value);
}

function toNumber(value) {
  if (value === null || value === undefined) return NaN;
  let s = String(value).trim();
  if (!s) return NaN;

  const negative = /^\(.*\)$/.test(s) || /^-/.test(s);
  s = s.replace(/[^0-9.,]/g, "");
  if (!s) return NaN;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  const decimalSeparator = lastComma > lastDot ? "," : lastDot > lastComma ? "." : "";

  if (decimalSeparator) {
    const thousandSeparator = decimalSeparator === "," ? "." : ",";
    s = s.split(thousandSeparator).join("").replace(decimalSeparator, ".");
  }

  const n = Number.parseFloat(s);
  if (Number.isNaN(n)) return NaN;
  return negative ? -n : n;
}

function fmtCurrency(value, currency) {
  const n = typeof value === "number" ? value : toNumber(value);
  if (Number.isNaN(n)) return "—";

  const code = String(currency || "").trim().toUpperCase();
  const validCode = /^[A-Z]{3}$/.test(code);

  try {
    return new Intl.NumberFormat("en-GB", {
      style: validCode ? "currency" : "decimal",
      currency: validCode ? code : undefined,
      maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2,
      minimumFractionDigits: 0,
    }).format(n) + (validCode ? "" : code ? ` ${code}` : "");
  } catch {
    return `${n.toLocaleString("en-GB")}${code ? ` ${code}` : ""}`;
  }
}

function fmtNum(value, digits = 2) {
  const n = typeof value === "number" ? value : toNumber(value);
  if (Number.isNaN(n)) return "—";
  return n.toLocaleString("en-GB", { maximumFractionDigits: digits });
}

function fmtPct(value, { signed = false, ratio = false } = {}) {
  const raw = String(value ?? "").trim();
  let n = typeof value === "number" ? value : toNumber(value);
  if (Number.isNaN(n)) return "—";

  // Ratio mode: 1.1069 becomes 110.69%; 0.027 becomes 2.7%.
  // If the raw cell already contains %, do not multiply again.
  if (ratio && !raw.includes("%")) n = n * 100;

  const sign = signed && n > 0 ? "+" : "";
  return `${sign}${n.toLocaleString("en-GB", { maximumFractionDigits: 2 })}%`;
}

/* ---------------------------------------------------------------------
   3. Client matching and calculations
   --------------------------------------------------------------------- */
function clientId(client) {
  return field(client, "Client ID", "ClientID", "Client Code", "Client Name", "Client");
}

function clientName(client) {
  return field(client, "Client Name", "Client", "Name", "Client ID");
}

function rowClientRef(row) {
  return field(row, "Client ID", "ClientID", "Client Code", "Client Name", "Client");
}

function rowsForClient(records, client) {
  const id = normKey(clientId(client));
  const name = normKey(clientName(client));

  return records.filter((r) => {
    const ref = normKey(rowClientRef(r));
    return ref && (ref === id || ref === name);
  });
}

function sumBy(records, ...labels) {
  return records.reduce((sum, rec) => {
    const n = toNumber(field(rec, ...labels));
    return sum + (Number.isNaN(n) ? 0 : n);
  }, 0);
}

function baseCurrencyFor(records) {
  for (const r of records) {
    const direct = field(r, "Base Currency", "BaseCurrency");
    if (direct) return direct;

    const ref = normKey(rowClientRef(r));
    const c = DB.clients.find((client) => normKey(clientId(client)) === ref || normKey(clientName(client)) === ref);
    if (c && field(c, "Base Currency", "BaseCurrency")) return field(c, "Base Currency", "BaseCurrency");
  }

  return field(DB.clients[0], "Base Currency", "BaseCurrency") || "";
}

function financialTotals(records) {
  const current = sumBy(records, "Current Value Base", "CurrentValueBase");
  const cost = sumBy(records, "Cost Value Base", "CostValueBase");
  const plFromSheet = sumBy(records, "Unrealised PL Base", "Unrealised P&L Base", "Unrealized PL Base");
  const pnl = plFromSheet !== 0 ? plFromSheet : current - cost;
  const perf = cost > 0 ? pnl / cost : NaN; // ratio, not percent
  return { current, cost, pnl, perf };
}

function allocationBy(records, ...labels) {
  const map = new Map();
  let total = 0;

  for (const r of records) {
    const key = field(r, ...labels) || "Unclassified";
    const value = toNumber(field(r, "Current Value Base", "CurrentValueBase"));
    if (Number.isNaN(value)) continue;
    map.set(key, (map.get(key) || 0) + value);
    total += value;
  }

  return Array.from(map.entries())
    .map(([label, value]) => ({ label, value, pct: total > 0 ? (value / total) * 100 : 0 }))
    .sort((a, b) => b.value - a.value);
}

/* ---------------------------------------------------------------------
   4. Loading
   --------------------------------------------------------------------- */
async function loadAll() {
  const tasks = Object.entries(SOURCES).map(async ([key, src]) => {
    try {
      const cacheBust = src.url.includes("?") ? `&_=${Date.now()}` : `?_=${Date.now()}`;
      const res = await fetch(src.url + cacheBust, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const text = await res.text();
      if (/^\s*<(!doctype|html)/i.test(text)) {
        throw new Error("This Google Sheets tab is not published as CSV.");
      }

      DB[key] = publishedOnly(toRecords(parseCSV(text)));
    } catch (e) {
      ERRORS[key] = e.message || "Unknown loading error";
      DB[key] = [];
    }
  });

  await Promise.allSettled(tasks);
}

/* ---------------------------------------------------------------------
   5. Charts
   --------------------------------------------------------------------- */
const CHART_COLORS = ["#C8A96A", "#6C9BF0", "#5BC196", "#B98AD6", "#E0A05B", "#6FC3C9", "#D98A8A", "#8FA0C4"];

function destroyCharts() {
  charts.forEach((chart) => chart.destroy());
  charts = [];
}

function drawDoughnut(canvasId, data, currency) {
  const el = document.getElementById(canvasId);
  if (!el || typeof Chart === "undefined" || !data.length) return;

  const chart = new Chart(el, {
    type: "doughnut",
    data: {
      labels: data.map((d) => d.label),
      datasets: [{
        data: data.map((d) => d.value),
        backgroundColor: data.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
        borderColor: "#121A2C",
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "62%",
      plugins: {
        legend: {
          position: "right",
          labels: { color: "#98A2B9", font: { family: "Manrope", size: 12 }, boxWidth: 12, padding: 12 },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const item = data[ctx.dataIndex];
              return `${item.label}: ${fmtCurrency(item.value, currency)} (${item.pct.toFixed(1)}%)`;
            },
          },
        },
      },
    },
  });

  charts.push(chart);
}

/* ---------------------------------------------------------------------
   6. Reusable renderers
   --------------------------------------------------------------------- */
const FINANCIAL_COLUMNS = [
  "Asset Class", "Asset Name", "Ticker", "Asset Currency", "Quantity", "Average Cost",
  "Cost Value Local", "Current Price", "Current Value Local", "Base Currency", "FX Rate To Base",
  "Cost Value Base", "Current Value Base", "Unrealised PL Base", "Performance Pct", "Last Updated",
  "Data Delay", "Region", "Liquidity", "Risk Level", "Investment Rationale", "Risk Notes",
];

const MONEY_LOCAL = new Set(["Average Cost", "Cost Value Local", "Current Price", "Current Value Local"]);
const MONEY_BASE = new Set(["Cost Value Base", "Current Value Base", "Unrealised PL Base"]);
const NUM_RIGHT = new Set(["Quantity", "Average Cost", "Cost Value Local", "Current Price", "Current Value Local", "FX Rate To Base", "Cost Value Base", "Current Value Base", "Unrealised PL Base", "Performance Pct"]);
const WRAP_COLUMNS = new Set(["Investment Rationale", "Risk Notes", "Strategic Role", "Planning Relevance", "Description", "Potential Benefit", "Recommended Action", "Proposed Strategy", "Governance Issue", "Tax Consideration"]);

function formatFinancialCell(row, column) {
  let value = field(row, column);
  const assetCurrency = field(row, "Asset Currency", "AssetCurrency");
  const baseCurrency = field(row, "Base Currency", "BaseCurrency");

  if (!value) return "—";
  if (MONEY_LOCAL.has(column)) return esc(fmtCurrency(value, assetCurrency));
  if (MONEY_BASE.has(column)) return esc(fmtCurrency(value, baseCurrency));
  if (column === "Quantity") return esc(fmtNum(value, 4));
  if (column === "FX Rate To Base") return esc(fmtNum(value, 4));
  if (column === "Performance Pct") return esc(fmtPct(value, { signed: true, ratio: true }));
  return cell(value);
}

function renderFinancialSection(records, prefix = "fin") {
  if (!records.length) return `<p class="empty">No published financial assets for this view.</p>`;

  const currency = baseCurrencyFor(records);
  const totals = financialTotals(records);
  const byClass = allocationBy(records, "Asset Class", "AssetClass");
  const byRegion = allocationBy(records, "Region");

  const headers = FINANCIAL_COLUMNS.map((c) => `<th class="${NUM_RIGHT.has(c) ? "r" : ""}">${esc(c)}</th>`).join("");
  const rows = records.map((r) => {
    const cells = FINANCIAL_COLUMNS.map((c) => {
      const cls = `${NUM_RIGHT.has(c) ? "num r" : ""} ${WRAP_COLUMNS.has(c) ? "wrap" : ""}`.trim();
      return `<td class="${cls}">${formatFinancialCell(r, c)}</td>`;
    }).join("");
    return `<tr>${cells}</tr>`;
  }).join("");

  return `
    <div class="kpis">
      <div class="kpi"><div class="label">Current Value</div><div class="value num">${esc(fmtCurrency(totals.current, currency))}</div><div class="sub">${records.length} position${records.length === 1 ? "" : "s"}</div></div>
      <div class="kpi"><div class="label">Cost Basis</div><div class="value num">${esc(fmtCurrency(totals.cost, currency))}</div></div>
      <div class="kpi"><div class="label">Unrealised P&amp;L</div><div class="value num ${totals.pnl >= 0 ? "pos" : "neg"}">${esc(fmtCurrency(totals.pnl, currency))}</div></div>
      <div class="kpi"><div class="label">Performance</div><div class="value num ${totals.perf >= 0 ? "pos" : "neg"}">${esc(fmtPct(totals.perf, { signed: true, ratio: true }))}</div></div>
    </div>

    <div class="grid-2" style="margin-top:18px">
      <div class="chart-card"><h3>Allocation by asset class</h3><div class="chart-box"><canvas id="${prefix}-class"></canvas></div></div>
      <div class="chart-card"><h3>Allocation by region</h3><div class="chart-box"><canvas id="${prefix}-region"></canvas></div></div>
    </div>

    <h3 class="subhead" style="margin-top:26px">Positions</h3>
    <div class="table-wrap"><table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table></div>
  `;
}

function renderFinancialCharts(records, prefix = "fin") {
  const currency = baseCurrencyFor(records);
  drawDoughnut(`${prefix}-class`, allocationBy(records, "Asset Class", "AssetClass"), currency);
  drawDoughnut(`${prefix}-region`, allocationBy(records, "Region"), currency);
}

const REAL_COLUMNS = [
  "Asset Type", "Asset Name", "Location", "Ownership Structure", "Estimated Value Base",
  "Annual Income", "Income Yield", "Strategic Role", "Liquidity", "Risk Notes",
  "Planning Relevance", "Valuation Date",
];

function renderRealSection(records) {
  if (!records.length) return `<p class="empty">No published real assets for this view.</p>`;

  const currency = baseCurrencyFor(records);
  const total = sumBy(records, "Estimated Value Base", "EstimatedValueBase");
  const income = sumBy(records, "Annual Income", "AnnualIncome");
  const yieldRatio = total > 0 ? income / total : NaN;

  const headers = REAL_COLUMNS.map((c) => `<th class="${NUM_RIGHT.has(c) ? "r" : ""}">${esc(c)}</th>`).join("");
  const rows = records.map((r) => {
    const cells = REAL_COLUMNS.map((c) => {
      let value = field(r, c);
      let out = "—";
      if (value) {
        if (c === "Estimated Value Base" || c === "Annual Income") out = esc(fmtCurrency(value, currency));
        else if (c === "Income Yield") out = esc(fmtPct(value, { ratio: true }));
        else out = cell(value);
      }
      const cls = `${NUM_RIGHT.has(c) ? "num r" : ""} ${WRAP_COLUMNS.has(c) ? "wrap" : ""}`.trim();
      return `<td class="${cls}">${out}</td>`;
    }).join("");
    return `<tr>${cells}</tr>`;
  }).join("");

  return `
    <div class="kpis">
      <div class="kpi"><div class="label">Estimated Value</div><div class="value num">${esc(fmtCurrency(total, currency))}</div><div class="sub">${records.length} asset${records.length === 1 ? "" : "s"}</div></div>
      <div class="kpi"><div class="label">Annual Income</div><div class="value num">${esc(fmtCurrency(income, currency))}</div></div>
      <div class="kpi"><div class="label">Blended Yield</div><div class="value num">${esc(fmtPct(yieldRatio, { ratio: true }))}</div></div>
    </div>
    <h3 class="subhead" style="margin-top:26px">Holdings</h3>
    <div class="table-wrap"><table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table></div>
  `;
}

function caseCards(records, config) {
  if (!records.length) return `<p class="empty">No published entries.</p>`;

  return `<div class="case-grid">${records.map((r) => {
    const title = field(r, ...config.title) || "—";
    const sub = config.sub ? field(r, ...config.sub) : "";
    const rows = config.fields.map(([label, strong]) => {
      const value = field(r, label);
      return value ? `<div><dt>${esc(label)}</dt><dd class="${strong ? "strong" : ""}">${esc(value)}</dd></div>` : "";
    }).join("");
    const tags = (config.tags || []).map((label) => {
      const value = field(r, label);
      return value ? `<span class="pill">${esc(label)}: ${esc(value)}</span>` : "";
    }).join("");

    return `<div class="case"><h3>${esc(title)}</h3>${sub ? `<div class="case-sub">${esc(sub)}</div>` : ""}<dl>${rows}</dl>${tags ? `<div class="case-tags">${tags}</div>` : ""}</div>`;
  }).join("")}</div>`;
}

function errorBanners(keys) {
  return keys.filter((key) => ERRORS[key]).map((key) => `
    <div class="error-box"><b>Could not load ${esc(SOURCES[key].label)}.</b> ${esc(ERRORS[key])}</div>
  `).join("");
}

const DISCLAIMER = `
  <div class="disclaimer">
    <span class="ico">◆</span>
    <div><b>Fictional &amp; educational.</b> Every client, holding, valuation and plan shown here is fictional and prepared only for portfolio demonstration. Nothing on this platform is investment, tax or legal advice.</div>
  </div>`;

/* ---------------------------------------------------------------------
   7. Views
   --------------------------------------------------------------------- */
function viewHome() {
  const totalVisible = DB.clients.reduce((sum, client) => {
    return sum + sumBy(rowsForClient(DB.financial, client), "Current Value Base") + sumBy(rowsForClient(DB.real, client), "Estimated Value Base");
  }, 0);

  const currency = field(DB.clients[0], "Base Currency", "BaseCurrency") || baseCurrencyFor(DB.financial);
  const assetClasses = new Set(DB.financial.map((r) => field(r, "Asset Class", "AssetClass")).filter(Boolean)).size;

  return `
    ${errorBanners(Object.keys(SOURCES))}
    <section class="hero">
      <span class="eyebrow">Private wealth · case-study platform</span>
      <h1>Virtual Wealth <em>Portfolio</em> Platform</h1>
      <p class="lede">A read-only wealth management case-study platform presenting fictional client portfolios across financial assets, real assets, tax planning, wealth structuring and intergenerational succession.</p>
    </section>
    <div class="rule"></div>
    <div class="kpis" style="margin-top:8px">
      <div class="kpi"><div class="label">Client Cases</div><div class="value">${DB.clients.length}</div></div>
      <div class="kpi"><div class="label">Visible Assets Under Review</div><div class="value num">${esc(fmtCurrency(totalVisible, currency))}</div><div class="sub">financial + real, fictional</div></div>
      <div class="kpi"><div class="label">Financial Positions</div><div class="value num">${DB.financial.length}</div></div>
      <div class="kpi"><div class="label">Asset Classes</div><div class="value num">${assetClasses}</div></div>
    </div>
    <div class="spacer"></div>
    ${DISCLAIMER}
    <div class="spacer"></div>
    <h3 class="subhead">Explore the platform</h3>
    <div class="grid-2">
      ${navCard("clients", "Clients", "Browse the fictional client roster and open a full wealth dashboard.")}
      ${navCard("financial", "Financial Assets", "Listed positions with cost, current value, P&L and allocation.")}
      ${navCard("real", "Real Assets", "Property, businesses and other illiquid assets.")}
      ${navCard("tax", "Tax Planning", "Planning tools, complexity, implementation and risks.")}
      ${navCard("wealth", "Wealth Planning", "Objectives, structures, time horizon and priority.")}
      ${navCard("succession", "Succession Planning", "Transfer strategy, governance and recommended action.")}
    </div>
  `;
}

function navCard(route, title, description) {
  return `<a class="card" href="#/${route}" style="display:block"><h3 class="subhead" style="margin-bottom:6px">${esc(title)}</h3><p style="margin:0;color:var(--text-dim);font-size:14px">${esc(description)}</p><div style="margin-top:14px;color:var(--gold);font-size:12px;font-weight:600;letter-spacing:.04em">Open →</div></a>`;
}

function viewClients() {
  if (ERRORS.clients) return errorBanners(["clients"]);
  if (!DB.clients.length) return `<div class="section-head"><h1>Clients</h1></div><p class="empty">No published clients found.</p>`;

  const cards = DB.clients.map((c) => {
    const id = encodeURIComponent(clientId(c));
    const details = [
      ["Type", field(c, "Client Type")],
      ["Country", field(c, "Country")],
      ["Tax Residence", field(c, "Tax Residence")],
      ["Base Currency", field(c, "Base Currency")],
      ["Liquidity Need", field(c, "Liquidity Need")],
      ["Risk Profile", field(c, "Risk Profile")],
    ].map(([k, v]) => `<div class="cc-field"><div class="k">${esc(k)}</div><div class="v">${cell(v)}</div></div>`).join("");

    return `<a class="client-card" href="#/client/${id}" role="listitem">
      <div class="cc-top">
        <div class="cc-name">${cell(clientName(c))}</div>
        <div class="cc-meta">${cell(field(c, "Country"))}${field(c, "Client Type") ? ` · ${esc(field(c, "Client Type"))}` : ""}</div>
        <div class="cc-nw-label">Estimated Net Worth</div>
        <div class="cc-nw num">${esc(fmtCurrency(field(c, "Estimated Net Worth"), field(c, "Base Currency")))}</div>
      </div>
      <div class="cc-grid">${details}</div>
      <div class="cc-foot"><span class="pill gold">${cell(field(c, "Main Objective"))}</span><span class="view-link">View dashboard →</span></div>
    </a>`;
  }).join("");

  return `<div class="section-head"><span class="eyebrow">Roster</span><h1>Clients</h1><p>${DB.clients.length} fictional client case${DB.clients.length === 1 ? "" : "s"}.</p></div><div class="client-grid" role="list">${cards}</div>`;
}

function viewClientDetail(id) {
  const client = DB.clients.find((c) => normKey(clientId(c)) === normKey(decodeURIComponent(id)));
  if (!client) return `<a class="back-link" href="#/clients">← Clients</a><p class="empty">Client not found.</p>`;

  const currency = field(client, "Base Currency");
  const financial = rowsForClient(DB.financial, client);
  const real = rowsForClient(DB.real, client);
  const tax = rowsForClient(DB.tax, client);
  const wealth = rowsForClient(DB.wealth, client);
  const succession = rowsForClient(DB.succession, client);
  const finValue = sumBy(financial, "Current Value Base");
  const realValue = sumBy(real, "Estimated Value Base");
  const visible = finValue + realValue;

  const profile = [
    ["Liquidity Need", field(client, "Liquidity Need")],
    ["Risk Profile", field(client, "Risk Profile")],
    ["Family Situation", field(client, "Family Situation")],
    ["Business Ownership", field(client, "Business Ownership")],
    ["Tax Residence", field(client, "Tax Residence")],
    ["Main Objective", field(client, "Main Objective")],
  ].map(([k, v]) => `<div class="cc-field"><div class="k">${esc(k)}</div><div class="v">${cell(v)}</div></div>`).join("");

  return `
    <a class="back-link" href="#/clients">← Clients</a>
    <div class="section-head"><span class="eyebrow">Statement of wealth · fictional</span><h1>${cell(clientName(client))}</h1><p>${cell(field(client, "Client Type"))}${field(client, "Country") ? ` · ${esc(field(client, "Country"))}` : ""}</p></div>
    <div class="kpis">
      <div class="kpi"><div class="label">Estimated Net Worth</div><div class="value num">${esc(fmtCurrency(field(client, "Estimated Net Worth"), currency))}</div></div>
      <div class="kpi"><div class="label">Financial Assets</div><div class="value num">${esc(fmtCurrency(finValue, currency))}</div><div class="sub">${financial.length} positions</div></div>
      <div class="kpi"><div class="label">Real Assets</div><div class="value num">${esc(fmtCurrency(realValue, currency))}</div><div class="sub">${real.length} assets</div></div>
      <div class="kpi"><div class="label">Total Visible Assets</div><div class="value num">${esc(fmtCurrency(visible, currency))}</div></div>
    </div>
    <div class="spacer"></div>
    <div class="grid-2">
      <div class="card"><h3 class="subhead">Profile</h3><div class="cc-grid" style="padding:0;grid-template-columns:1fr 1fr">${profile}</div></div>
      <div class="chart-card"><h3>Visible asset split</h3><div class="chart-box"><canvas id="client-split"></canvas></div></div>
    </div>
    <div class="spacer"></div><h3 class="subhead">Financial assets</h3>${renderFinancialSection(financial, "client-fin")}
    <div class="spacer"></div><h3 class="subhead">Real assets</h3>${renderRealSection(real)}
    ${tax.length ? `<div class="spacer"></div><h3 class="subhead">Tax planning</h3>${taxCards(tax)}` : ""}
    ${wealth.length ? `<div class="spacer"></div><h3 class="subhead">Wealth planning</h3>${wealthCards(wealth)}` : ""}
    ${succession.length ? `<div class="spacer"></div><h3 class="subhead">Succession planning</h3>${successionCards(succession)}` : ""}
  `;
}

function renderClientCharts(id) {
  const client = DB.clients.find((c) => normKey(clientId(c)) === normKey(decodeURIComponent(id)));
  if (!client) return;
  const currency = field(client, "Base Currency");
  const financial = rowsForClient(DB.financial, client);
  const real = rowsForClient(DB.real, client);
  const finValue = sumBy(financial, "Current Value Base");
  const realValue = sumBy(real, "Estimated Value Base");
  const total = finValue + realValue;

  drawDoughnut("client-split", [
    { label: "Financial assets", value: finValue, pct: total > 0 ? (finValue / total) * 100 : 0 },
    { label: "Real assets", value: realValue, pct: total > 0 ? (realValue / total) * 100 : 0 },
  ].filter((x) => x.value > 0), currency);

  renderFinancialCharts(financial, "client-fin");
}

function viewFinancial() {
  if (ERRORS.financial) return errorBanners(["financial"]);
  return `<div class="section-head"><span class="eyebrow">Liquid &amp; private positions</span><h1>Financial Assets</h1><p>Read-only positions with cost, current valuation, unrealised P&amp;L and allocation.</p></div>${renderFinancialSection(DB.financial, "fin")}`;
}

function viewReal() {
  if (ERRORS.real) return errorBanners(["real"]);
  return `<div class="section-head"><span class="eyebrow">Illiquid holdings</span><h1>Real Assets</h1><p>Property, family business interests and other manually valued holdings.</p></div>${renderRealSection(DB.real)}`;
}

function taxCards(records) {
  return caseCards(records, {
    title: ["Tax Issue"],
    sub: ["Jurisdiction"],
    fields: [["Planning Tool", true], ["Description", false], ["Potential Benefit", true], ["Risks Limitations", false], ["Next Step", true]],
    tags: ["Complexity", "Implementation Status"],
  });
}

function wealthCards(records) {
  return caseCards(records, {
    title: ["Planning Area"],
    sub: ["Objective"],
    fields: [["Planning Tool", true], ["Description", false], ["Expected Benefit", true], ["Time Horizon", false]],
    tags: ["Complexity", "Priority"],
  });
}

function successionCards(records) {
  return caseCards(records, {
    title: ["Transfer Objective"],
    sub: ["Generation"],
    fields: [["Assets Involved", true], ["Proposed Strategy", false], ["Governance Issue", false], ["Tax Consideration", false], ["Recommended Action", true]],
    tags: ["Risk"],
  });
}

function viewTax() {
  return `<div class="section-head"><span class="eyebrow">Fiscal strategy</span><h1>Tax Planning</h1><p>Jurisdictional issues, planning tools, benefits, complexity and next steps.</p></div>${ERRORS.tax ? errorBanners(["tax"]) : taxCards(DB.tax)}`;
}

function viewWealth() {
  return `<div class="section-head"><span class="eyebrow">Structuring</span><h1>Wealth Planning</h1><p>Planning objectives, tools, time horizons, benefits and priorities.</p></div>${ERRORS.wealth ? errorBanners(["wealth"]) : wealthCards(DB.wealth)}`;
}

function viewSuccession() {
  return `<div class="section-head"><span class="eyebrow">Intergenerational</span><h1>Succession Planning</h1><p>Transfer strategy, governance issues, tax considerations and recommended action.</p></div>${ERRORS.succession ? errorBanners(["succession"]) : successionCards(DB.succession)}`;
}

function viewMethodology() {
  const blocks = DB.methodology.length ? DB.methodology.map((r) => {
    const title = field(r, "Section", "Topic") || "Methodology";
    const text = field(r, "Text", "Description") || "";
    return `<div class="method-block"><h3>${esc(title)}</h3><div class="mb-field"><div class="v">${esc(text)}</div></div></div>`;
  }).join("") : `<p class="empty">No methodology entries published.</p>`;

  return `<div class="section-head"><span class="eyebrow">How to read this platform</span><h1>Methodology &amp; Disclaimer</h1><p>The framework, assumptions and data treatment behind the case studies.</p></div>${errorBanners(["methodology"])}${DISCLAIMER}<div class="spacer"></div>${blocks}<div class="method-block"><h3>Data &amp; calculations</h3><div class="mb-field"><div class="k">Source</div><div class="v">Figures are read live from published Google Sheets CSV links. Listed prices are calculated in Google Sheets via GOOGLEFINANCE and displayed here.</div></div><div class="mb-field"><div class="k">Read-only</div><div class="v">This site has no forms, edit buttons, trade buttons, backend, login or write access.</div></div></div>`;
}

/* ---------------------------------------------------------------------
   8. Router and boot
   --------------------------------------------------------------------- */
const ROUTES = {
  home: viewHome,
  clients: viewClients,
  financial: viewFinancial,
  real: viewReal,
  tax: viewTax,
  wealth: viewWealth,
  succession: viewSuccession,
  methodology: viewMethodology,
};

function parseHash() {
  const hash = (location.hash || "#/home").replace(/^#\/?/, "");
  const [route, arg] = hash.split("/");
  return { route: route || "home", arg };
}

function render() {
  destroyCharts();
  const { route, arg } = parseHash();
  const view = document.getElementById("view");

  let html;
  let active = route;

  if (route === "client" && arg) {
    html = viewClientDetail(arg);
    active = "clients";
  } else {
    html = ROUTES[route] ? ROUTES[route]() : viewHome();
  }

  view.innerHTML = html;
  window.scrollTo(0, 0);

  if (route === "financial") renderFinancialCharts(DB.financial, "fin");
  if (route === "client" && arg) renderClientCharts(arg);

  document.querySelectorAll(".nav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.route === active);
  });

  document.querySelector(".app")?.classList.remove("nav-open");
}

function wireChrome() {
  const app = document.querySelector(".app");
  document.querySelector(".menu-btn")?.addEventListener("click", () => app.classList.toggle("nav-open"));
  document.querySelector(".scrim")?.addEventListener("click", () => app.classList.remove("nav-open"));
}

async function init() {
  const view = document.getElementById("view");
  view.innerHTML = `<div class="state"><div class="ring"></div>Loading fictional client data…</div>`;
  await loadAll();
  wireChrome();
  window.addEventListener("hashchange", render);
  render();
}

document.addEventListener("DOMContentLoaded", init);
