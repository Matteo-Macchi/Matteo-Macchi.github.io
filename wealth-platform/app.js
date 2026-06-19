/* =====================================================================
   Virtual Wealth Portfolio Platform — app.js
   Static, read-only. No backend, no auth, no writes. Data is pulled
   from published Google Sheets CSV endpoints and only ever displayed.
   ===================================================================== */

"use strict";

/* ---------------------------------------------------------------------
   1. Data sources
   --------------------------------------------------------------------- */
const SHEET = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRUWTm9jWxN9oyJG0o0VReM-rcZnbPJWnTcdKhGLA-CKYjihIV63jVm1baWBVhs7NmRtNnvRLvXT56F/pub";
const SOURCES = {
  clients:    { url: `${SHEET}?gid=0&single=true&output=csv`,          label: "Clients" },
  financial:  { url: `${SHEET}?gid=1095770554&single=true&output=csv`, label: "Financial Assets" },
  real:       { url: `${SHEET}?gid=95223140&single=true&output=csv`,   label: "Real Assets" },
  tax:        { url: `${SHEET}?gid=272082907&single=true&output=csv`,  label: "Tax Planning" },
  wealth:     { url: `${SHEET}?gid=374990790&single=true&output=csv`,  label: "Wealth Planning" },
  succession: { url: `${SHEET}?gid=1810567517&single=true&output=csv`, label: "Succession Planning" },
  methodology:{ url: `${SHEET}?gid=1065951101&single=true&output=csv`, label: "Methodology" },
};

/* In-memory store. Never written back anywhere. */
const DB = { clients: [], financial: [], real: [], tax: [], wealth: [], succession: [], methodology: [] };
const ERRORS = {}; // dataset key -> error message

/* ---------------------------------------------------------------------
   2. CSV parsing (RFC-4180-ish: quotes, escaped quotes, embedded
      commas + newlines inside quoted fields)
   --------------------------------------------------------------------- */
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  // Strip a leading BOM if present.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }   // escaped quote
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* ignore, handled by \n */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* Normalise a header to a comparison key: lowercase, alphanumeric only. */
const normKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/* Turn a 2D CSV array into objects keyed by normalised header, while
   keeping the original header text for display fallbacks. */
function toRecords(rows) {
  if (!rows.length) return { records: [], headers: [] };
  const headers = rows[0].map((h) => h.trim());
  const keys = headers.map(normKey);
  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.every((c) => String(c).trim() === "")) continue; // skip blank lines
    const rec = { __headers: headers, __keys: keys };
    keys.forEach((k, i) => { if (k) rec[k] = (cells[i] ?? "").trim(); });
    records.push(rec);
  }
  return { records, headers };
}

/* Pull a field from a record by any of several human labels. */
function field(rec, ...labels) {
  for (const lbl of labels) {
    const k = normKey(lbl);
    if (rec && rec[k] !== undefined && rec[k] !== "") return rec[k];
  }
  return "";
}

/* Keep only rows whose Status column reads "Published" (case-insensitive).
   If no Status column exists at all, keep everything. */
function publishedOnly(records) {
  const hasStatus = records.some((r) => r.status !== undefined);
  if (!hasStatus) return records;
  return records.filter((r) => normKey(r.status) === "published");
}

/* ---------------------------------------------------------------------
   3. Number / currency / date formatting
   --------------------------------------------------------------------- */
function toNumber(v) {
  if (v === null || v === undefined) return NaN;
  let s = String(v).trim();
  if (!s) return NaN;
  const neg = /^\(.*\)$/.test(s) || /-/.test(s);
  s = s.replace(/[^0-9.,]/g, "");
  if (!s) return NaN;
  const lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".");
  const decSep = lastComma > lastDot ? "," : (lastDot > lastComma ? "." : "");
  if (decSep) {
    const thou = decSep === "," ? "." : ",";
    s = s.split(thou).join("").replace(decSep, ".");
  }
  const n = parseFloat(s);
  if (isNaN(n)) return NaN;
  return neg ? -n : n;
}

function fmtCurrency(value, ccy) {
  const n = typeof value === "number" ? value : toNumber(value);
  if (isNaN(n)) return "—";
  const code = String(ccy || "").trim().toUpperCase();
  const valid = /^[A-Z]{3}$/.test(code);
  try {
    return new Intl.NumberFormat("en-GB", {
      style: valid ? "currency" : "decimal",
      currency: valid ? code : undefined,
      maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2,
      minimumFractionDigits: 0,
    }).format(n) + (valid ? "" : (code ? " " + code : ""));
  } catch {
    return n.toLocaleString("en-GB") + (code ? " " + code : "");
  }
}

function fmtNum(value, dp = 2) {
  const n = typeof value === "number" ? value : toNumber(value);
  if (isNaN(n)) return "—";
  return n.toLocaleString("en-GB", { maximumFractionDigits: dp, minimumFractionDigits: 0 });
}

function fmtPct(value, { signed = false } = {}) {
  let n = typeof value === "number" ? value : toNumber(value);
  if (isNaN(n)) return "—";
  // Google Sheets often stores percentages as decimals:
  // 0.746 = 74.6%, 0.027 = 2.7%.
  if (Math.abs(n) <= 1) n = n * 100;
  const sign = signed && n > 0 ? "+" : "";
  return `${sign}${n.toLocaleString("en-GB", { maximumFractionDigits: 2 })}%`;
}

/* Display a raw cell, with an em-dash fallback for blanks. */
const cell = (v) => (v === undefined || v === null || String(v).trim() === "" ? "—" : esc(String(v)));

/* HTML escape — every value from the sheet passes through this. */
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* ---------------------------------------------------------------------
   4. Client <-> asset join
      Assets may reference a client by id or by name; clients may be
      keyed by either. We resolve a stable id per client and match
      asset rows flexibly against id OR name.
   --------------------------------------------------------------------- */
function clientId(rec) {
  return field(rec, "Client ID", "ClientID", "Client Code", "Client Name", "Client", "Name");
}
function clientName(rec) {
  return field(rec, "Client Name", "Client", "Name", "Client ID");
}
function rowClientRef(rec) {
  return field(rec, "Client ID", "ClientID", "Client Code", "Client Name", "Client", "Name");
}
function rowsForClient(records, client) {
  const id = normKey(clientId(client));
  const nm = normKey(clientName(client));
  return records.filter((r) => {
    const ref = normKey(rowClientRef(r));
    return ref && (ref === id || ref === nm);
  });
}

/* ---------------------------------------------------------------------
   5. Aggregations
   --------------------------------------------------------------------- */
const sumBy = (records, ...labels) =>
  records.reduce((acc, r) => {
    const n = toNumber(field(r, ...labels));
    return acc + (isNaN(n) ? 0 : n);
  }, 0);

function financialTotals(records) {
  const current = sumBy(records, "Current Value Base");
  const cost = sumBy(records, "Cost Value Base");
  const pl = sumBy(records, "Unrealised PL Base", "Unrealised P&L Base", "Unrealized PL Base");
  const pnl = pl !== 0 ? pl : current - cost;
  const perf = cost > 0 ? (pnl / cost) * 100 : NaN;
  return { current, cost, pnl, perf };
}

/* Group Current Value Base by an arbitrary dimension. */
function allocationBy(records, ...dimLabels) {
  const map = new Map();
  let total = 0;
  for (const r of records) {
    const dim = field(r, ...dimLabels) || "Unclassified";
    const v = toNumber(field(r, "Current Value Base"));
    if (isNaN(v)) continue;
    map.set(dim, (map.get(dim) || 0) + v);
    total += v;
  }
  return [...map.entries()]
    .map(([k, v]) => ({ label: k, value: v, pct: total > 0 ? (v / total) * 100 : 0 }))
    .sort((a, b) => b.value - a.value);
}

/* Count of distinct base currencies present in a set of asset rows. */
function baseCurrencies(records) {
  const s = new Set();
  records.forEach((r) => {
    const c = field(r, "Base Currency").toUpperCase();
    if (c) s.add(c);
  });
  return [...s];
}

function currencyForRecords(records) {
  const direct = baseCurrencies(records)[0];
  if (direct) return direct;
  for (const r of records) {
    const ref = normKey(rowClientRef(r));
    const client = DB.clients.find((c) =>
      normKey(clientId(c)) === ref || normKey(clientName(c)) === ref
    );
    if (client) {
      const ccy = field(client, "Base Currency");
      if (ccy) return ccy;
    }
  }
  return "";
}

/* ---------------------------------------------------------------------
   6. Fetch
   --------------------------------------------------------------------- */
async function loadAll() {
  const tasks = Object.entries(SOURCES).map(async ([key, src]) => {
    try {
      const res = await fetch(src.url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (/^\s*<(!doctype|html)/i.test(text))
        throw new Error("Sheet is not published to the web as CSV.");
      const { records } = toRecords(parseCSV(text));
      DB[key] = publishedOnly(records);
    } catch (e) {
      ERRORS[key] = e.message || "Unknown error";
      DB[key] = [];
    }
  });
  await Promise.allSettled(tasks);
}

/* ---------------------------------------------------------------------
   7. Charts (Chart.js). Track instances so we can destroy on re-render.
   --------------------------------------------------------------------- */
const CHART_COLORS = ["#C8A96A", "#6C9BF0", "#5BC196", "#B98AD6", "#E0A05B", "#6FC3C9", "#D98A8A", "#8FA0C4"];
let _charts = [];
function destroyCharts() { _charts.forEach((c) => c.destroy()); _charts = []; }

function doughnut(canvasId, data, ccy) {
  const el = document.getElementById(canvasId);
  if (!el || typeof Chart === "undefined" || !data.length) return;
  const c = new Chart(el, {
    type: "doughnut",
    data: {
      labels: data.map((d) => d.label),
      datasets: [{
        data: data.map((d) => d.value),
        backgroundColor: data.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
        borderColor: "#121A2C", borderWidth: 2, hoverOffset: 6,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "62%",
      plugins: {
        legend: {
          position: "right",
          labels: { color: "#98A2B9", font: { family: "Manrope", size: 12 }, boxWidth: 12, padding: 12 },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.label}: ${fmtCurrency(ctx.parsed, ccy)} (${(data[ctx.dataIndex].pct).toFixed(1)}%)`,
          },
        },
      },
    },
  });
  _charts.push(c);
}

/* ---------------------------------------------------------------------
   8. Reusable section renderers
   --------------------------------------------------------------------- */
const FIN_COLUMNS = [
  "Asset Class", "Asset Name", "Ticker", "Asset Currency", "Quantity", "Average Cost",
  "Cost Value Local", "Current Price", "Current Value Local", "Base Currency", "FX Rate To Base",
  "Cost Value Base", "Current Value Base", "Unrealised PL Base", "Performance Pct", "Last Updated",
  "Data Delay", "Region", "Liquidity", "Risk Level", "Investment Rationale", "Risk Notes",
];
const FIN_WRAP = new Set(["Investment Rationale", "Risk Notes"]);
const FIN_RIGHT = new Set([
  "Quantity", "Average Cost", "Cost Value Local", "Current Price", "Current Value Local",
  "FX Rate To Base", "Cost Value Base", "Current Value Base", "Unrealised PL Base", "Performance Pct",
]);

function financialSection(records, { idPrefix = "fin", showCharts = true } = {}) {
  if (!records.length) return `<p class="empty">No published financial assets for this view.</p>`;
  const t = financialTotals(records);
  const ccys = baseCurrencies(records);
  const ccy = ccys[0] || "";
  const mixed = ccys.length > 1;

  const byClass = allocationBy(records, "Asset Class");
  const byRegion = allocationBy(records, "Region");

  const kpis = `
    <div class="kpis">
      <div class="kpi"><div class="label">Current Value</div>
        <div class="value num">${esc(fmtCurrency(t.current, ccy))}</div>
        <div class="sub">${records.length} position${records.length === 1 ? "" : "s"}</div></div>
      <div class="kpi"><div class="label">Cost Basis</div>
        <div class="value num">${esc(fmtCurrency(t.cost, ccy))}</div></div>
      <div class="kpi"><div class="label">Unrealised P&amp;L</div>
        <div class="value num ${t.pnl >= 0 ? "pos" : "neg"}">${esc(fmtCurrency(t.pnl, ccy))}</div></div>
      <div class="kpi"><div class="label">Performance</div>
        <div class="value num ${t.perf >= 0 ? "pos" : "neg"}">${esc(fmtPct(t.perf, { signed: true }))}</div></div>
    </div>`;

  const charts = showCharts && (byClass.length || byRegion.length) ? `
    <div class="grid-2" style="margin-top:18px">
      <div class="chart-card"><h3>Allocation by asset class</h3>
        <div class="chart-box"><canvas id="${idPrefix}-class"></canvas></div></div>
      <div class="chart-card"><h3>Allocation by region</h3>
        <div class="chart-box"><canvas id="${idPrefix}-region"></canvas></div></div>
    </div>` : "";

  const head = FIN_COLUMNS.map((c) => `<th class="${FIN_RIGHT.has(c) ? "r" : ""}">${esc(c)}</th>`).join("");
  const body = records.map((r) => {
    const tds = FIN_COLUMNS.map((c) => {
      let v = field(r, c);
      let cls = FIN_WRAP.has(c) ? "wrap" : (FIN_RIGHT.has(c) ? "num r" : "");
      // Format the money-ish and pct columns.
      if (["Cost Value Local", "Current Value Local"].includes(c))
        v = v ? fmtCurrency(v, field(r, "Asset Currency")) : "";
      else if (["Cost Value Base", "Current Value Base", "Unrealised PL Base"].includes(c))
        v = v ? fmtCurrency(v, field(r, "Base Currency")) : "";
      else if (["Average Cost", "Current Price"].includes(c))
        v = v ? fmtCurrency(v, field(r, "Asset Currency")) : "";
      else if (c === "Quantity") v = v ? fmtNum(v, 4) : "";
      else if (c === "FX Rate To Base") v = v ? fmtNum(v, 4) : "";
      else if (c === "Performance Pct") {
        const n = toNumber(v);
        if (!isNaN(n)) { cls += n >= 0 ? " pos" : " neg"; v = fmtPct(n, { signed: true }); }
      }
      return `<td class="${cls}">${cell(v)}</td>`;
    }).join("");
    return `<tr>${tds}</tr>`;
  }).join("");

  const note = mixed
    ? `<div class="disclaimer" style="margin-top:14px"><span class="ico">◆</span><div>Totals aggregate positions across <b>${ccys.length} base currencies</b> (${ccys.join(", ")}); treat the headline figures as indicative rather than a single-currency consolidation.</div></div>`
    : "";

  return `${kpis}${charts}${note}
    <h3 class="subhead" style="margin-top:26px">Positions</h3>
    <div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function financialCharts(records, idPrefix) {
  const ccy = baseCurrencies(records)[0] || "";
  doughnut(`${idPrefix}-class`, allocationBy(records, "Asset Class"), ccy);
  doughnut(`${idPrefix}-region`, allocationBy(records, "Region"), ccy);
}

const REAL_COLUMNS = [
  "Asset Type", "Asset Name", "Location", "Ownership Structure", "Estimated Value Base",
  "Annual Income", "Income Yield", "Strategic Role", "Liquidity", "Risk Notes",
  "Planning Relevance", "Valuation Date",
];
const REAL_WRAP = new Set(["Strategic Role", "Risk Notes", "Planning Relevance"]);
const REAL_RIGHT = new Set(["Estimated Value Base", "Annual Income", "Income Yield"]);

function realSection(records) {
  if (!records.length) return `<p class="empty">No published real assets for this view.</p>`;
  const ccy = currencyForRecords(records);
  const total = sumBy(records, "Estimated Value Base");
  const income = sumBy(records, "Annual Income");

  const kpis = `
    <div class="kpis">
      <div class="kpi"><div class="label">Estimated Value</div>
        <div class="value num">${esc(fmtCurrency(total, ccy))}</div>
        <div class="sub">${records.length} asset${records.length === 1 ? "" : "s"}</div></div>
      <div class="kpi"><div class="label">Annual Income</div>
        <div class="value num">${esc(fmtCurrency(income, ccy))}</div></div>
      <div class="kpi"><div class="label">Blended Yield</div>
        <div class="value num">${total > 0 ? esc(fmtPct((income / total) * 100)) : "—"}</div></div>
    </div>`;

  const head = REAL_COLUMNS.map((c) => `<th class="${REAL_RIGHT.has(c) ? "r" : ""}">${esc(c)}</th>`).join("");
  const body = records.map((r) => {
    const tds = REAL_COLUMNS.map((c) => {
      let v = field(r, c);
      let cls = REAL_WRAP.has(c) ? "wrap" : (REAL_RIGHT.has(c) ? "num r" : "");
      if (c === "Estimated Value Base" || c === "Annual Income") v = v ? fmtCurrency(v, field(r, "Base Currency") || ccy) : "";
      else if (c === "Income Yield") { const n = toNumber(v); if (!isNaN(n)) v = fmtPct(n); }
      return `<td class="${cls}">${cell(v)}</td>`;
    }).join("");
    return `<tr>${tds}</tr>`;
  }).join("");

  return `${kpis}
    <h3 class="subhead" style="margin-top:26px">Holdings</h3>
    <div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/* Definition-style case cards for the narrative planning sections. */
function caseCards(records, config) {
  if (!records.length) return `<p class="empty">No published entries.</p>`;
  const cards = records.map((r) => {
    const title = field(r, ...config.title) || "—";
    const sub = config.sub ? field(r, ...config.sub) : "";
    const fields = config.fields.map(([label, strong]) => {
      const v = field(r, label);
      if (!v) return "";
      return `<div><dt>${esc(label)}</dt><dd class="${strong ? "strong" : ""}">${esc(v)}</dd></div>`;
    }).join("");
    const tags = (config.tags || []).map((label) => {
      const v = field(r, label);
      return v ? `<span class="pill">${esc(label)}: ${esc(v)}</span>` : "";
    }).join("");
    return `<div class="case">
      <h3>${esc(title)}</h3>
      ${sub ? `<div class="case-sub">${esc(sub)}</div>` : ""}
      <dl>${fields}</dl>
      ${tags ? `<div class="case-tags">${tags}</div>` : ""}
    </div>`;
  }).join("");
  return `<div class="case-grid">${cards}</div>`;
}

/* ---------------------------------------------------------------------
   9. Views
   --------------------------------------------------------------------- */
const DISCLAIMER = `
  <div class="disclaimer">
    <span class="ico">◆</span>
    <div><b>Fictional &amp; educational.</b> Every client, holding, valuation and plan shown here is invented
    for portfolio demonstration. Nothing on this platform is investment, tax or legal advice, and no figure
    represents a real person or account.</div>
  </div>`;

function errorBanners(keys) {
  return keys.filter((k) => ERRORS[k]).map((k) =>
    `<div class="error-box"><b>Couldn’t load ${esc(SOURCES[k].label)}.</b> ${esc(ERRORS[k])} — check that this tab is published to the web as CSV.</div>`
  ).join("");
}

function viewHome() {
  const clients = DB.clients;
  const totalVisible = clients.reduce((acc, c) => {
    const fin = sumBy(rowsForClient(DB.financial, c), "Current Value Base");
    const real = sumBy(rowsForClient(DB.real, c), "Estimated Value Base");
    return acc + fin + real;
  }, 0);
  const ccy = baseCurrencies(DB.financial)[0] || (clients[0] && field(clients[0], "Base Currency")) || "";
  const assetClasses = new Set(DB.financial.map((r) => field(r, "Asset Class")).filter(Boolean)).size;

  return `
    ${errorBanners(Object.keys(SOURCES))}
    <section class="hero">
      <span class="eyebrow">Private wealth · case-study platform</span>
      <h1>Virtual Wealth <em>Portfolio</em> Platform</h1>
      <p class="lede">A read-only wealth management case-study platform presenting fictional client portfolios
      across financial assets, real assets, tax planning, wealth structuring and intergenerational succession.</p>
    </section>
    <div class="rule"></div>
    <div class="kpis" style="margin-top:8px">
      <div class="kpi"><div class="label">Client Cases</div><div class="value">${clients.length}</div></div>
      <div class="kpi"><div class="label">Visible Assets Under Review</div><div class="value num">${esc(fmtCurrency(totalVisible, ccy))}</div><div class="sub">financial + real, fictional</div></div>
      <div class="kpi"><div class="label">Financial Positions</div><div class="value num">${DB.financial.length}</div></div>
      <div class="kpi"><div class="label">Asset Classes</div><div class="value num">${assetClasses}</div></div>
    </div>
    <div class="spacer"></div>
    ${DISCLAIMER}
    <div class="spacer"></div>
    <h3 class="subhead">Explore the platform</h3>
    <div class="grid-2">
      ${navCard("clients", "Clients", "Browse the fictional client roster and open a full wealth dashboard for each.")}
      ${navCard("financial", "Financial Assets", "Listed and private positions with cost, value, P&L and allocation.")}
      ${navCard("real", "Real Assets", "Property, operating businesses and other illiquid holdings.")}
      ${navCard("tax", "Tax Planning", "Cross-border issues, planning tools and implementation status.")}
      ${navCard("wealth", "Wealth Planning", "Structuring objectives across the balance sheet.")}
      ${navCard("succession", "Succession Planning", "Intergenerational transfer strategy and governance.")}
    </div>`;
}

function navCard(route, title, desc) {
  return `<a class="card" href="#/${route}" style="display:block">
    <h3 class="subhead" style="margin-bottom:6px">${esc(title)}</h3>
    <p style="margin:0;color:var(--text-dim);font-size:14px">${esc(desc)}</p>
    <div style="margin-top:14px;color:var(--gold);font-size:12px;font-weight:600;letter-spacing:.04em">Open →</div>
  </a>`;
}

function viewClients() {
  const clients = DB.clients;
  if (ERRORS.clients) return errorBanners(["clients"]);
  if (!clients.length) return `<div class="section-head"><h1>Clients</h1></div><p class="empty">No published clients found.</p>`;

  const cards = clients.map((c) => {
    const id = encodeURIComponent(clientId(c));
    const f = (l1, ...rest) => field(c, l1, ...rest);
    const detail = [
      ["Type", f("Client Type")],
      ["Country", f("Country")],
      ["Tax Residence", f("Tax Residence")],
      ["Base Currency", f("Base Currency")],
      ["Liquidity Need", f("Liquidity Need")],
      ["Risk Profile", f("Risk Profile")],
    ].map(([k, v]) => `<div class="cc-field"><div class="k">${esc(k)}</div><div class="v">${cell(v)}</div></div>`).join("");

    return `<a class="client-card" href="#/client/${id}" role="listitem">
      <div class="cc-top">
        <div class="cc-name">${cell(clientName(c))}</div>
        <div class="cc-meta">${cell(f("Country"))}${f("Client Type") ? " · " + esc(f("Client Type")) : ""}</div>
        <div class="cc-nw-label">Estimated Net Worth</div>
        <div class="cc-nw num">${esc(fmtCurrency(f("Estimated Net Worth"), f("Base Currency")))}</div>
      </div>
      <div class="cc-grid">${detail}</div>
      <div class="cc-foot">
        <span class="pill gold">${cell(f("Main Objective"))}</span>
        <span class="view-link">View dashboard →</span>
      </div>
    </a>`;
  }).join("");

  return `
    <div class="section-head">
      <span class="eyebrow">Roster</span>
      <h1>Clients</h1>
      <p>${clients.length} fictional client case${clients.length === 1 ? "" : "s"}. Select any card to open a full read-only wealth dashboard.</p>
    </div>
    <div class="client-grid" role="list">${cards}</div>`;
}

function viewClientDetail(id) {
  const client = DB.clients.find((c) => normKey(clientId(c)) === normKey(decodeURIComponent(id)));
  if (!client) return `<a class="back-link" href="#/clients">← Clients</a><p class="empty">Client not found.</p>`;

  const f = (l1, ...rest) => field(client, l1, ...rest);
  const ccy = f("Base Currency");
  const fin = rowsForClient(DB.financial, client);
  const realA = rowsForClient(DB.real, client);
  const tax = rowsForClient(DB.tax, client);
  const wealth = rowsForClient(DB.wealth, client);
  const succ = rowsForClient(DB.succession, client);

  const finTotal = sumBy(fin, "Current Value Base");
  const realTotal = sumBy(realA, "Estimated Value Base");
  const visible = finTotal + realTotal;

  const profile = [
    ["Family Situation", f("Family Situation", "Family")],
    ["Business Ownership", f("Business Ownership", "Business")],
    ["Tax Residence", f("Tax Residence")],
    ["Main Objective", f("Main Objective")],
  ].map(([k, v]) => `<div class="cc-field"><div class="k">${esc(k)}</div><div class="v">${cell(v)}</div></div>`).join("");

  const sections = [];
  if (tax.length) sections.push(`<div class="spacer"></div><h3 class="subhead">Tax planning</h3>${taxCards(tax)}`);
  if (wealth.length) sections.push(`<div class="spacer"></div><h3 class="subhead">Wealth planning</h3>${wealthCards(wealth)}`);
  if (succ.length) sections.push(`<div class="spacer"></div><h3 class="subhead">Succession planning</h3>${successionCards(succ)}`);

  return `
    <a class="back-link" href="#/clients">← Clients</a>
    <div class="section-head">
      <span class="eyebrow">Statement of wealth · fictional</span>
      <h1>${cell(clientName(client))}</h1>
      <p>${cell(f("Client Type"))}${f("Country") ? " · " + esc(f("Country")) : ""}${f("Risk Profile") ? " · " + esc(f("Risk Profile")) + " risk" : ""}</p>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="label">Estimated Net Worth</div><div class="value num">${esc(fmtCurrency(f("Estimated Net Worth"), ccy))}</div></div>
      <div class="kpi"><div class="label">Financial Assets</div><div class="value num">${esc(fmtCurrency(finTotal, ccy))}</div><div class="sub">${fin.length} positions</div></div>
      <div class="kpi"><div class="label">Real Assets</div><div class="value num">${esc(fmtCurrency(realTotal, ccy))}</div><div class="sub">${realA.length} assets</div></div>
      <div class="kpi"><div class="label">Total Visible Assets</div><div class="value num">${esc(fmtCurrency(visible, ccy))}</div></div>
    </div>

    <div class="spacer"></div>
    <div class="grid-2">
      <div class="card">
        <h3 class="subhead">Profile</h3>
        <div class="cc-grid" style="padding:0;grid-template-columns:1fr 1fr">
          <div class="cc-field"><div class="k">Liquidity Need</div><div class="v">${cell(f("Liquidity Need"))}</div></div>
          <div class="cc-field"><div class="k">Risk Profile</div><div class="v">${cell(f("Risk Profile"))}</div></div>
          ${profile}
        </div>
      </div>
      <div class="chart-card"><h3>Visible asset split</h3>
        <div class="chart-box"><canvas id="cd-split"></canvas></div></div>
    </div>

    <div class="spacer"></div>
    <h3 class="subhead">Financial assets</h3>
    ${financialSection(fin, { idPrefix: "cd-fin" })}

    <div class="spacer"></div>
    <h3 class="subhead">Real assets</h3>
    ${realSection(realA)}

    ${sections.join("")}`;
}

function clientDetailCharts(id) {
  const client = DB.clients.find((c) => normKey(clientId(c)) === normKey(decodeURIComponent(id)));
  if (!client) return;
  const ccy = field(client, "Base Currency");
  const fin = rowsForClient(DB.financial, client);
  const realA = rowsForClient(DB.real, client);
  const finTotal = sumBy(fin, "Current Value Base");
  const realTotal = sumBy(realA, "Estimated Value Base");
  doughnut("cd-split", [
    { label: "Financial assets", value: finTotal, pct: 0 },
    { label: "Real assets", value: realTotal, pct: 0 },
  ].filter((d) => d.value > 0).map((d, _, arr) => {
    const tot = arr.reduce((a, x) => a + x.value, 0);
    return { ...d, pct: tot ? (d.value / tot) * 100 : 0 };
  }), ccy);
  financialCharts(fin, "cd-fin");
}

/* Section pages with a client filter (filter chips are navigation only —
   they change what is displayed, never the underlying data). */
let filterState = {}; // route -> selected client id ("" = all)

function clientFilterChips(route, records) {
  const refs = new Set(records.map((r) => normKey(rowClientRef(r))).filter(Boolean));
  const relevant = DB.clients.filter((c) => refs.has(normKey(clientId(c))) || refs.has(normKey(clientName(c))));
  if (relevant.length < 2) return "";
  const sel = filterState[route] || "";
  const chip = (id, label) =>
    `<button class="chip ${sel === id ? "active" : ""}" data-filter="${route}" data-id="${esc(id)}">${esc(label)}</button>`;
  return `<div class="chips">${chip("", "All clients")}${relevant.map((c) => chip(clientId(c), clientName(c))).join("")}</div>`;
}

function applyFilter(route, records) {
  const sel = filterState[route];
  if (!sel) return records;
  const client = DB.clients.find((c) => clientId(c) === sel);
  return client ? rowsForClient(records, client) : records;
}

function viewFinancial() {
  if (ERRORS.financial) return errorBanners(["financial"]);
  const filtered = applyFilter("financial", DB.financial);
  return `
    <div class="section-head"><span class="eyebrow">Liquid &amp; private positions</span><h1>Financial Assets</h1>
    <p>Aggregated positions with cost, valuation, unrealised P&amp;L and allocation. Values shown in each position’s base currency.</p></div>
    ${clientFilterChips("financial", DB.financial)}
    ${financialSection(filtered, { idPrefix: "fin" })}`;
}

function viewReal() {
  if (ERRORS.real) return errorBanners(["real"]);
  const filtered = applyFilter("real", DB.real);
  return `
    <div class="section-head"><span class="eyebrow">Illiquid holdings</span><h1>Real Assets</h1>
    <p>Property, operating businesses and other tangible holdings, with estimated value, income and strategic role.</p></div>
    ${clientFilterChips("real", DB.real)}
    ${realSection(filtered)}`;
}

function taxCards(records) {
  return caseCards(records, {
    title: ["Tax Issue"], sub: ["Jurisdiction"],
    fields: [["Planning Tool", true], ["Description", false], ["Potential Benefit", true],
      ["Risks / Limitations", false], ["Next Step", true]],
    tags: ["Complexity", "Implementation Status"],
  });
}
function wealthCards(records) {
  return caseCards(records, {
    title: ["Planning Area"], sub: ["Objective"],
    fields: [["Planning Tool", true], ["Description", false], ["Expected Benefit", true], ["Time Horizon", false]],
    tags: ["Complexity", "Priority"],
  });
}
function successionCards(records) {
  return caseCards(records, {
    title: ["Transfer Objective"], sub: ["Generation"],
    fields: [["Assets Involved", true], ["Proposed Strategy", false], ["Governance Issue", false],
      ["Tax Consideration", false], ["Recommended Action", true]],
    tags: ["Risk"],
  });
}

function viewTax() {
  if (ERRORS.tax) return errorBanners(["tax"]);
  const f = applyFilter("tax", DB.tax);
  return `<div class="section-head"><span class="eyebrow">Fiscal strategy</span><h1>Tax Planning</h1>
    <p>Cross-border tax issues mapped to planning tools, expected benefit, complexity and implementation status.</p></div>
    ${clientFilterChips("tax", DB.tax)}${taxCards(f)}`;
}
function viewWealth() {
  if (ERRORS.wealth) return errorBanners(["wealth"]);
  const f = applyFilter("wealth", DB.wealth);
  return `<div class="section-head"><span class="eyebrow">Structuring</span><h1>Wealth Planning</h1>
    <p>Planning objectives across the balance sheet, with tools, horizon, expected benefit and priority.</p></div>
    ${clientFilterChips("wealth", DB.wealth)}${wealthCards(f)}`;
}
function viewSuccession() {
  if (ERRORS.succession) return errorBanners(["succession"]);
  const f = applyFilter("succession", DB.succession);
  return `<div class="section-head"><span class="eyebrow">Intergenerational</span><h1>Succession Planning</h1>
    <p>Transfer strategy across generations, including governance, tax considerations and recommended actions.</p></div>
    ${clientFilterChips("succession", DB.succession)}${successionCards(f)}`;
}

function viewMethodology() {
  const recs = DB.methodology;
  const banner = errorBanners(["methodology"]);
  const blocks = recs.length ? recs.map((r) => {
    const keys = r.__keys || [];
    const headers = r.__headers || [];
    // First non-empty field is treated as the block title.
    let titleIdx = keys.findIndex((k) => k && k !== "status" && r[k]);
    if (titleIdx < 0) titleIdx = 0;
    const title = r[keys[titleIdx]] || "Note";
    const fields = keys.map((k, i) => {
      if (!k || k === "status" || i === titleIdx) return "";
      const v = r[k];
      if (!v) return "";
      return `<div class="mb-field"><div class="k">${esc(headers[i])}</div><div class="v">${esc(v)}</div></div>`;
    }).join("");
    return `<div class="method-block"><h3>${esc(title)}</h3>${fields}</div>`;
  }).join("") : `<p class="empty">No methodology entries published.</p>`;

  return `
    <div class="section-head"><span class="eyebrow">How to read this platform</span><h1>Methodology &amp; Disclaimer</h1>
    <p>The framework, assumptions and data treatment behind the case studies.</p></div>
    ${banner}
    ${DISCLAIMER}
    <div class="spacer"></div>
    ${blocks}
    <div class="spacer"></div>
    <div class="method-block">
      <h3>Data &amp; calculations</h3>
      <div class="mb-field"><div class="k">Source</div><div class="v">Figures are read live from published Google Sheets (CSV). Listed prices are pre-computed in the sheet via GOOGLEFINANCE; this platform never fetches market data itself.</div></div>
      <div class="mb-field"><div class="k">Totals</div><div class="v">Total financial assets = sum of Current Value Base. Total real assets = sum of Estimated Value Base. Total visible assets = financial + real.</div></div>
      <div class="mb-field"><div class="k">Allocation</div><div class="v">Allocation by asset class and by region is each segment’s Current Value Base divided by total financial assets.</div></div>
      <div class="mb-field"><div class="k">Read-only</div><div class="v">This is a presentation layer only: no inputs, no forms, no edits, no trades. Nothing here can modify the underlying data.</div></div>
    </div>`;
}

/* ---------------------------------------------------------------------
   10. Router
   --------------------------------------------------------------------- */
const ROUTES = {
  home: { title: "Overview", render: viewHome },
  clients: { title: "Clients", render: viewClients },
  financial: { title: "Financial Assets", render: viewFinancial },
  real: { title: "Real Assets", render: viewReal },
  tax: { title: "Tax Planning", render: viewTax },
  wealth: { title: "Wealth Planning", render: viewWealth },
  succession: { title: "Succession Planning", render: viewSuccession },
  methodology: { title: "Methodology", render: viewMethodology },
};

function parseHash() {
  const h = (location.hash || "#/home").replace(/^#\/?/, "");
  const [route, arg] = h.split("/");
  return { route: route || "home", arg };
}

function render() {
  destroyCharts();
  const { route, arg } = parseHash();
  const view = document.getElementById("view");

  let html, activeRoute = route;
  if (route === "client" && arg) { html = viewClientDetail(arg); activeRoute = "clients"; }
  else if (ROUTES[route]) html = ROUTES[route].render();
  else html = viewHome();

  view.innerHTML = html;
  window.scrollTo(0, 0);

  // Post-render: charts need the canvases in the DOM.
  if (route === "client" && arg) clientDetailCharts(arg);
  else if (route === "financial") financialCharts(applyFilter("financial", DB.financial), "fin");

  // Active nav state.
  document.querySelectorAll(".nav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.route === activeRoute);
  });

  // Count-up on KPI mono figures (respecting reduced motion).
  animateFigures(view);

  // Close mobile drawer after navigation.
  document.querySelector(".app").classList.remove("nav-open");
}

/* Subtle count-up for numeric KPI values. Read-only flourish. */
function animateFigures(scope) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  scope.querySelectorAll(".kpi .value.num").forEach((el) => {
    const text = el.textContent;
    const m = text.match(/-?[\d.,]+/);
    if (!m) return;
    const target = toNumber(m[0]);
    if (isNaN(target) || Math.abs(target) < 1) return;
    const prefix = text.slice(0, m.index), suffix = text.slice(m.index + m[0].length);
    const dur = 650, t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      const cur = target * eased;
      el.textContent = prefix + cur.toLocaleString("en-GB", { maximumFractionDigits: 0 }) + suffix;
      if (p < 1) requestAnimationFrame(step);
      else el.textContent = text;
    };
    requestAnimationFrame(step);
  });
}

/* ---------------------------------------------------------------------
   11. Boot
   --------------------------------------------------------------------- */
function wireChrome() {
  const app = document.querySelector(".app");
  document.querySelector(".menu-btn")?.addEventListener("click", () => app.classList.toggle("nav-open"));
  document.querySelector(".scrim")?.addEventListener("click", () => app.classList.remove("nav-open"));

  // Filter chips (event delegation; pure view filtering).
  document.getElementById("view").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-filter]");
    if (!chip) return;
    filterState[chip.dataset.filter] = chip.dataset.id;
    render();
  });
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
