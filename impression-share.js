/* Offline Impression Share Analyzer
   - Parses Amazon Search Term Impression Share CSV
   - Aggregates by date + search term + country
   - Sums impressions across campaigns/ad groups
   - Classifies Share+Rank quadrants and recommends strategy
*/

const $ = (id) => document.getElementById(id);

const QUADRANTS = {
  Q1: "① 高份额 + 高排名",
  Q2: "② 高份额 + 低排名",
  Q3: "③ 低份额 + 高排名",
  Q4: "④ 低份额 + 低排名",
};

const QUADRANT_META = {
  [QUADRANTS.Q1]: {
    situation: "你最强，市场地位稳固",
    base: "继续卡位，稳住份额",
    acosGood: "ACOS 健康 → 维持出价与预算，巩固首位",
    acosBad: "ACOS 偏高 → 降 BID、降低 TOS 比例，用份额换利润",
  },
  [QUADRANTS.Q2]: {
    situation: "份额不低但排名靠后，强劲竞品占主导",
    base: "优化 Listing（标题/主图/A+/视频）提升转化与相关性",
    acosGood: "ACOS 健康 → 加预算、抬 BID 争取更高排名",
    acosBad: "ACOS 差 → 评估是否退出或大幅控成本",
  },
  [QUADRANTS.Q3]: {
    situation: "排名靠前但份额低，大词/类目词竞争激烈、曝光分散",
    base: "数据好 → 冲 TOS（大词单词单组，BID +30%~50%）",
    acosGood: "数据好 → 冲首页顶部，扩大 ASIN 定向 / SBV 覆盖",
    acosBad: "数据差但自然排名好 → 控 TOS bid，曝光投向中部/底部",
  },
  [QUADRANTS.Q4]: {
    situation: "份额与排名都低，多为偏词或不精准词",
    base: "检查相关性：不相关 → 否词并停投",
    acosGood: "相关且市场量可观 → 小幅抬 BID 测试",
    acosBad: "市场量很低 → 不必投入，降 ACOS 或停投",
  },
};

let rawRows = [];
let trends = []; // per (date, term, country)
let summary = []; // per term latest + first
let enriched = [];
let lastExportRows = [];
let analysisReady = false;

function debounce(fn, waitMs) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}

function stripHeader(s) {
  return String(s ?? "").trim();
}

function normHeader(s) {
  // Robust header normalization across CSV/XLSX variants:
  // - trim
  // - collapse whitespace (including newlines)
  // - remove punctuation
  // - lowercase
  return stripHeader(s)
    .replace(/\s+/g, " ")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function pickColumn(headers, candidates) {
  // headers: array of original header strings
  // candidates: array of normalized keys to match
  const byNorm = new Map(headers.map((h) => [normHeader(h), h]));
  for (const c of candidates) {
    const hit = byNorm.get(c);
    if (hit) return hit;
  }
  // fallback: contains-match
  for (const [nh, orig] of byNorm.entries()) {
    for (const c of candidates) {
      if (nh.includes(c)) return orig;
    }
  }
  return null;
}

function toNumberLoose(v) {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  if (!t) return null;
  const cleaned = t.replace(/[%,$]/g, "").replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseDate(v) {
  // expects like "Apr 21, 2026"
  const t = String(v ?? "").trim().replace(/^"|"$/g, "");
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d;
}

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function shareLevel(share, shareHigh) {
  if (share === null) return null;
  return share >= shareHigh ? "高" : "低";
}

function rankLevel(rank, rankGoodMax) {
  if (rank === null) return null;
  return rank <= rankGoodMax ? "高" : "低";
}

function classifyQuadrant(share, rank, shareHigh, rankGoodMax) {
  const sl = shareLevel(share, shareHigh);
  const rl = rankLevel(rank, rankGoodMax);
  if (!sl || !rl) return null;
  if (sl === "高" && rl === "高") return QUADRANTS.Q1;
  if (sl === "高" && rl === "低") return QUADRANTS.Q2;
  if (sl === "低" && rl === "高") return QUADRANTS.Q3;
  return QUADRANTS.Q4;
}

function estimateMarketImpressions(yourImpressions, sharePct) {
  if (yourImpressions == null || sharePct == null || sharePct <= 0) return null;
  return yourImpressions / (sharePct / 100);
}

function buildStrategy(q, acosPct, acosGoodMax, marketImp) {
  if (!q) return "Share 或 Rank 缺失，无法分类";
  const meta = QUADRANT_META[q];
  const parts = [meta.situation, meta.base];
  if (acosPct != null) {
    parts.push(acosPct <= acosGoodMax ? meta.acosGood : meta.acosBad);
  }
  if (marketImp != null) parts.push(`估算市场总曝光 ≈ ${Math.round(marketImp).toLocaleString()}`);
  return parts.join("；");
}

function parseDocThresholds(text) {
  const t = String(text ?? "");
  const pick = (re) => {
    const m = t.match(re);
    return m ? Number(m[1]) : null;
  };
  const share = pick(/(?:高份额|份额分界|份额阈值|share)[^\d]{0,20}(\d+(?:\.\d+)?)\s*%/i);
  const rank = pick(/(?:高排名|排名分界|rank)[^\d]{0,20}(?:<=|≤)\s*(\d+(?:\.\d+)?)/i);
  const acos = pick(/(?:acos)[^\d]{0,20}(\d+(?:\.\d+)?)\s*%/i);
  return { share, rank, acos };
}

function setStatus(msg, kind = "info") {
  const el = $("status");
  el.textContent = msg;
  el.style.color = "#dc2626";
}

function renderKpis(meta) {
  const el = $("kpis");
  el.innerHTML = "";
  const items = [
    ["搜索词数量", meta.terms.toLocaleString()],
    ["日期范围", meta.dateRange],
    ["天数", String(meta.days)],
    ["数据点", meta.points.toLocaleString()],
  ];
  for (const [label, value] of items) {
    const d = document.createElement("div");
    d.className = "kpi";
    d.innerHTML = `<div class="label">${label}</div><div class="value">${value}</div>`;
    el.appendChild(d);
  }
}

function renderTermKpis(meta) {
  const el = $("termKpis");
  el.innerHTML = "";
  const items = [
    ["最新日期", meta.latestDate || "—"],
    ["最新 Share", meta.latestShare ?? "—"],
    ["最新 Rank", meta.latestRank ?? "—"],
    ["天数", String(meta.days ?? 0)],
  ];
  for (const [label, value] of items) {
    const d = document.createElement("div");
    d.className = "kpi";
    d.innerHTML = `<div class="label">${label}</div><div class="value">${value}</div>`;
    el.appendChild(d);
  }
}

function pill(q) {
  const cls =
    q === QUADRANTS.Q1 ? "q1" : q === QUADRANTS.Q2 ? "q2" : q === QUADRANTS.Q3 ? "q3" : "q4";
  return `<span class="pill ${cls}">${q}</span>`;
}

function renderTable(containerId, rows, columns) {
  const wrap = $(containerId);
  if (!rows.length) {
    wrap.innerHTML = `<div style="padding:12px;color:#a8b0c7">没有数据</div>`;
    return;
  }
  const thead = `<thead><tr>${columns.map((c) => `<th>${c.label}</th>`).join("")}</tr></thead>`;
  const tbody = rows
    .map((r) => {
      return `<tr>${columns
        .map((c) => `<td>${c.render ? c.render(r[c.key], r) : String(r[c.key] ?? "")}</td>`)
        .join("")}</tr>`;
    })
    .join("");
  wrap.innerHTML = `<table>${thead}<tbody>${tbody}</tbody></table>`;
}

function matchesSearchTerm(term, query, mode) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const t = String(term || "").trim().toLowerCase();
  return mode === "exact" ? t === q : t.includes(q);
}

function sortRowsByNumber(rows, field, direction) {
  return rows.slice().sort((a, b) => {
    const av = a[field];
    const bv = b[field];
    const aMissing = av == null || Number.isNaN(av);
    const bMissing = bv == null || Number.isNaN(bv);
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    return direction === "asc" ? av - bv : bv - av;
  });
}

function computeBaseFromRaw() {
  if (!rawRows.length) return false;

  // Normalize headers + robust matching across variants
  const headers = Object.keys(rawRows[0] || {}).map(stripHeader);
  const dateCol = pickColumn(headers, ["date"]);
  const termCol = pickColumn(headers, ["customersearchterm"]);
  const rankCol = pickColumn(headers, ["searchtermimpressionrank", "impressionrank"]);
  const shareCol = pickColumn(headers, ["searchtermimpressionshare", "impressionshare"]);
  const countryCol = pickColumn(headers, ["country"]);
  const impCol = pickColumn(headers, ["impressions"]);
  const acosKey = pickColumn(headers, [
    "totaladvertisingcostofsalesacos",
    "advertisingcostofsalesacos",
    "acos",
  ]);

  const missing = [];
  if (!dateCol) missing.push("Date");
  if (!termCol) missing.push("Customer Search Term");
  if (!rankCol) missing.push("Search Term Impression Rank");
  if (!shareCol) missing.push("Search Term Impression Share");
  if (missing.length) {
    setStatus(
      `缺少关键列：${missing.join("、")}。请确认你上传的是 Search Term Impression Share 报告。`,
      "error"
    );
    analysisReady = false;
    return false;
  }

  const hasCountry = !!countryCol;
  if (!hasCountry) {
    setStatus("提示：缺少 Country 列，已按 ALL 处理（不影响四象限分析）。", "info");
  }
  if (!impCol) {
    setStatus("提示：缺少 Impressions 列，将无法反推市场总曝光（仍可做四象限与趋势）。", "info");
  }

  // Aggregate to trends: date+term+country
  const byKey = new Map();
  for (const row of rawRows) {
    const date = parseDate(row[dateCol]);
    if (!date) continue;
    const term = String(row[termCol] ?? "").trim();
    const country = hasCountry ? String(row[countryCol] ?? "").trim() : "ALL";
    const share = toNumberLoose(row[shareCol]);
    const rank = toNumberLoose(row[rankCol]);
    const impressions = impCol ? toNumberLoose(row[impCol]) : null;
    const acos = acosKey ? toNumberLoose(row[acosKey]) : null;

    const key = `${fmtDate(date)}\u0000${term}\u0000${country}`;
    const cur = byKey.get(key) || {
      date,
      dateStr: fmtDate(date),
      search_term: term,
      Country: country,
      impression_share: share,
      impression_rank: rank,
      impressions: impCol ? 0 : null,
      acos: acos,
    };
    if (impressions != null && cur.impressions != null) cur.impressions += impressions;
    // Share/Rank take first non-null (account-level, same across campaigns)
    if (cur.impression_share == null && share != null) cur.impression_share = share;
    if (cur.impression_rank == null && rank != null) cur.impression_rank = rank;
    if (cur.acos == null && acos != null) cur.acos = acos;
    byKey.set(key, cur);
  }
  trends = Array.from(byKey.values()).sort((a, b) => (a.search_term === b.search_term ? a.date - b.date : a.search_term.localeCompare(b.search_term)));

  // Summary per search term: latest + earliest + observations
  const byTerm = new Map();
  for (const t of trends) {
    const term = t.search_term;
    const arr = byTerm.get(term) || [];
    arr.push(t);
    byTerm.set(term, arr);
  }
  summary = [];
  for (const [term, arr] of byTerm.entries()) {
    arr.sort((a, b) => a.date - b.date);
    const first = arr[0];
    const last = arr[arr.length - 1];
    summary.push({
      search_term: term,
      latest_date: last.dateStr,
      latest_share: last.impression_share,
      latest_rank: last.impression_rank,
      latest_impressions: impCol ? last.impressions : null,
      latest_acos: last.acos,
      first_date: first.dateStr,
      first_share: first.impression_share,
      first_rank: first.impression_rank,
      observations: arr.length,
      share_change:
        last.impression_share != null && first.impression_share != null
          ? last.impression_share - first.impression_share
          : null,
      rank_change:
        last.impression_rank != null && first.impression_rank != null
          ? last.impression_rank - first.impression_rank
          : null,
    });
  }
  summary.sort((a, b) => (b.latest_share ?? -1) - (a.latest_share ?? -1));
  analysisReady = true;
  return true;
}

function applyThresholdsToSummary() {
  const shareHigh = Number($("shareHigh").value || 30);
  const rankGood = Number($("rankGood").value || 3);
  const acosGood = Number($("acosGood").value || 30);

  enriched = summary.map((r) => {
    const market =
      r.latest_impressions == null ? null : estimateMarketImpressions(r.latest_impressions, r.latest_share);
    const q = classifyQuadrant(r.latest_share, r.latest_rank, shareHigh, rankGood);
    return {
      ...r,
      market_impressions: market,
      competitor_impressions:
        market != null && r.latest_impressions != null ? market - r.latest_impressions : null,
      quadrant_label: q,
      share_level: shareLevel(r.latest_share, shareHigh),
      rank_level: rankLevel(r.latest_rank, rankGood),
      strategy: buildStrategy(q, r.latest_acos, acosGood, market),
    };
  });
}

function renderResults() {
  if (!analysisReady || !enriched.length) return;

  const byTerm = new Set(enriched.map((r) => r.search_term));
  const dates = [...new Set(trends.map((t) => t.dateStr))].sort();
  renderKpis({
    terms: byTerm.size,
    days: dates.length,
    points: trends.length,
    dateRange: dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : "—",
  });

  const search = ($("search").value || "").trim();
  const marketMatchMode = $("marketMatchMode")?.value || "phrase";
  const minDays = Number($("minDays").value || 1);
  const marketSortField = $("marketSortField")?.value || "market_impressions";
  const marketSortDir = $("marketSortDir")?.value || "desc";
  const marketFiltered = enriched.filter((r) => {
    if (r.observations < minDays) return false;
    if (!matchesSearchTerm(r.search_term, search, marketMatchMode)) return false;
    return true;
  });

  const sortedMarket = sortRowsByNumber(marketFiltered, marketSortField, marketSortDir);

  lastExportRows = sortedMarket;
  $("btnExport").disabled = sortedMarket.length === 0;

  renderTable("tableMarket", sortedMarket.slice(0, 500), [
    { key: "search_term", label: "搜索词" },
    { key: "latest_date", label: "最新日期" },
    { key: "latest_impressions", label: "你的曝光", render: (v) => (v == null ? "—" : Math.round(v).toLocaleString()) },
    { key: "latest_share", label: "Share %", render: (v) => (v == null ? "—" : v.toFixed(2)) },
    { key: "market_impressions", label: "市场总曝光", render: (v) => (v == null ? "—" : Math.round(v).toLocaleString()) },
    { key: "competitor_impressions", label: "竞品曝光", render: (v) => (v == null ? "—" : Math.round(v).toLocaleString()) },
    { key: "latest_rank", label: "Rank", render: (v) => (v == null ? "—" : Math.round(v)) },
    { key: "quadrant_label", label: "象限", render: (v) => (v ? pill(v) : "—") },
    { key: "share_change", label: "Share 变化", render: (v) => (v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(2)) },
    { key: "rank_change", label: "Rank 变化", render: (v) => (v == null ? "—" : (v >= 0 ? "+" : "") + Math.round(v)) },
    { key: "observations", label: "天数" },
  ]);

  const qFilter = $("quadFilter").value;
  const qSearch = ($("quadSearch")?.value || "").trim();
  const qMatchMode = $("quadMatchMode")?.value || "phrase";
  const qSortField = $("quadSortField")?.value || "market_impressions";
  const qSortDir = $("quadSortDir")?.value || "desc";
  const qFiltered = enriched.filter((r) => {
    if (qFilter && r.quadrant_label !== qFilter) return false;
    if (!matchesSearchTerm(r.search_term, qSearch, qMatchMode)) return false;
    return true;
  });
  const qSorted = sortRowsByNumber(qFiltered, qSortField, qSortDir);

  renderTable("tableQuadrant", qSorted.slice(0, 500), [
    { key: "search_term", label: "搜索词" },
    { key: "latest_impressions", label: "你的曝光", render: (v) => (v == null ? "—" : Math.round(v).toLocaleString()) },
    { key: "market_impressions", label: "市场总曝光", render: (v) => (v == null ? "—" : Math.round(v).toLocaleString()) },
    { key: "latest_share", label: "Share %", render: (v) => (v == null ? "—" : v.toFixed(2)) },
    { key: "latest_rank", label: "Rank", render: (v) => (v == null ? "—" : Math.round(v)) },
    { key: "latest_acos", label: "ACOS %", render: (v) => (v == null ? "—" : v.toFixed(2)) },
    { key: "quadrant_label", label: "象限", render: (v) => (v ? pill(v) : "—") },
    { key: "strategy", label: "策略建议", render: (v) => (v ? String(v) : "—") },
  ]);

  setStatus(`分析完成：${marketFiltered.length} 个搜索词（展示前 500）。`, "ok");

  populateTermPicker();
  renderSelectedTermTrend();
}

function analyze() {
  if (!rawRows.length) {
    setStatus("请先上传文件或点击样例数据。", "error");
    return;
  }

  setStatus(`正在分析 ${rawRows.length.toLocaleString()} 行数据，请稍候…`);
  window.setTimeout(() => {
    if (!computeBaseFromRaw()) return;
    applyThresholdsToSummary();
    renderResults();
  }, 0);
}

function refreshViews() {
  if (!analysisReady) return;
  applyThresholdsToSummary();
  renderResults();
}

const refreshViewsDebounced = debounce(refreshViews, 250);

function formatFileSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function finishLoad(rows, label) {
  rawRows = rows || [];
  analysisReady = false;
  enriched = [];
  trends = [];
  summary = [];
  $("btnExport").disabled = true;
  setStatus(
    `已加载：${label}（${rawRows.length.toLocaleString()} 行），请点击「分析」`,
    "ok"
  );
}

/** Parse CSV/TXT from File (no Web Worker — worker often never completes on GitHub Pages). */
function loadDelimitedFile(file, delimiter) {
  const sizeHint = formatFileSize(file.size);
  setStatus(`正在解析 ${file.name}（${sizeHint}）…`);

  const config = {
    header: true,
    skipEmptyLines: true,
    worker: false,
    complete: (res) => finishLoad(res.data, file.name),
    error: (err) => setStatus(`解析失败：${err?.message || err}`, "error"),
  };
  if (delimiter) config.delimiter = delimiter;

  setTimeout(() => {
    try {
      Papa.parse(file, config);
    } catch (err) {
      setStatus(`解析失败：${err?.message || err}`, "error");
    }
  }, 0);
}

function loadCsvText(text, label = "CSV") {
  setStatus(`正在解析：${label} …`);
  setTimeout(() => {
    try {
      Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
        worker: false,
        complete: (res) => finishLoad(res.data, label),
        error: (err) => setStatus(`解析失败：${err?.message || err}`, "error"),
      });
    } catch (err) {
      setStatus(`解析失败：${err?.message || err}`, "error");
    }
  }, 0);
}

async function loadXlsx(file) {
  if (!window.XLSX) {
    setStatus("缺少 XLSX 解析库（vendor/xlsx.full.min.js）。", "error");
    return;
  }
  setStatus(`正在读取 Excel：${file.name}（${formatFileSize(file.size)}）…`);
  await new Promise((r) => setTimeout(r, 0));
  try {
    const buf = await file.arrayBuffer();
    setStatus(`正在解析 Excel 工作表…`);
    await new Promise((r) => setTimeout(r, 0));
    const wb = window.XLSX.read(buf, { type: "array" });
    const sheetName = wb.SheetNames?.[0];
    if (!sheetName) {
      setStatus("Excel 没有工作表。", "error");
      return;
    }
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    finishLoad(rows, `${file.name}#${sheetName}`);
  } catch (err) {
    setStatus(`Excel 解析失败：${err?.message || err}`, "error");
  }
}

async function loadSample() {
  const resp = await fetch("./data/sample_report.csv");
  const text = await resp.text();
  loadCsvText(text, "data/sample_report.csv");
}

function exportCsv() {
  if (!lastExportRows.length) return;
  const cols = [
    "search_term",
    "latest_date",
    "latest_share",
    "latest_rank",
    "latest_impressions",
    "market_impressions",
    "competitor_impressions",
    "quadrant_label",
    "strategy",
    "observations",
  ];
  const lines = [cols.join(",")];
  for (const r of lastExportRows) {
    const row = cols.map((k) => {
      const v = r[k];
      const s = v == null ? "" : String(v);
      const escaped = /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      return escaped;
    });
    lines.push(row.join(","));
  }
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "impression-share-analysis.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      $("tab-market").classList.toggle("hidden", tab !== "market");
      $("tab-quadrant").classList.toggle("hidden", tab !== "quadrant");
      $("tab-term").classList.toggle("hidden", tab !== "term");
    });
  });
}

function populateTermPicker() {
  const pick = $("termPick");
  if (!pick) return;
  const query = ($("termQuery")?.value || "").trim().toLowerCase();
  const mode = ($("termMatchMode")?.value || "broad").toLowerCase();
  const terms = Array.from(new Set(trends.map((t) => t.search_term))).sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );
  const filtered = query
    ? terms.filter((t) => {
        const hay = t.toLowerCase();
        return mode === "exact" ? hay === query : hay.includes(query);
      })
    : terms;
  const current = pick.value;
  pick.innerHTML = filtered
    .slice(0, 8000)
    .map((t) => `<option value="${t.replace(/"/g, "&quot;")}">${t}</option>`)
    .join("");
  if (current && filtered.includes(current)) pick.value = current;
}

function renderSelectedTermTrend() {
  const pick = $("termPick");
  if (!pick || !trends.length) return;
  const term = pick.value || "";
  if (!term) return;
  const showShare = $("showShare")?.checked ?? true;
  const showRank = $("showRank")?.checked ?? true;
  const showMarket = $("showMarket")?.checked ?? true;
  const rows = trends
    .filter((t) => t.search_term === term)
    .sort((a, b) => a.date - b.date)
    .map((t, idx, arr) => {
      const prev = idx > 0 ? arr[idx - 1] : null;
      const shareDelta =
        prev && t.impression_share != null && prev.impression_share != null
          ? t.impression_share - prev.impression_share
          : null;
      const rankDelta =
        prev && t.impression_rank != null && prev.impression_rank != null
          ? t.impression_rank - prev.impression_rank
          : null;
      const market = estimateMarketImpressions(t.impressions, t.impression_share);
      return {
        date: t.dateStr,
        share: t.impression_share,
        share_delta: shareDelta,
        rank: t.impression_rank,
        rank_delta: rankDelta,
        impressions: t.impressions,
        market_impressions: market,
      };
    });

  renderTermChart(rows, { showShare, showRank });
  renderMarketChart(rows, { showMarket });

  const last = rows[rows.length - 1];
  renderTermKpis({
    latestDate: last?.date,
    latestShare: last?.share != null ? `${last.share.toFixed(2)}%` : "—",
    latestRank: last?.rank != null ? String(Math.round(last.rank)) : "—",
    days: rows.length,
  });

  renderTable("tableTerm", rows.slice().reverse(), [
    { key: "date", label: "日期" },
    { key: "share", label: "Share %", render: (v) => (v == null ? "—" : v.toFixed(2)) },
    {
      key: "share_delta",
      label: "Share 日变",
      render: (v) => (v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(2)),
    },
    { key: "rank", label: "Rank", render: (v) => (v == null ? "—" : Math.round(v)) },
    {
      key: "rank_delta",
      label: "Rank 日变",
      render: (v) => (v == null ? "—" : (v >= 0 ? "+" : "") + Math.round(v)),
    },
    {
      key: "impressions",
      label: "你的曝光",
      render: (v) => (v == null ? "—" : Math.round(v).toLocaleString()),
    },
    {
      key: "market_impressions",
      label: "市场总曝光",
      render: (v) => (v == null ? "—" : Math.round(v).toLocaleString()),
    },
  ]);
}

function renderTermChart(rows, { showShare, showRank }) {
  const canvas = $("termChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (!rows?.length) {
    ctx.fillStyle = "#a8b0c7";
    ctx.font = "14px system-ui, -apple-system, Segoe UI, Roboto";
    ctx.fillText("没有数据", 20, 30);
    return;
  }

  const padding = { l: 66, r: 66, t: 38, b: 42 };
  const plotW = w - padding.l - padding.r;
  const plotH = h - padding.t - padding.b;

  const shareVals = rows.map((r) => r.share).filter((v) => v != null);
  const rankVals = rows.map((r) => r.rank).filter((v) => v != null);

  const shareMin = shareVals.length ? Math.min(...shareVals) : 0;
  const shareMax = shareVals.length ? Math.max(...shareVals) : 100;
  const rankMin = rankVals.length ? Math.min(...rankVals) : 1;
  const rankMax = rankVals.length ? Math.max(...rankVals) : 10;
  const shareAxisMin = Math.floor(Math.max(0, shareMin - 2));
  const shareAxisMax = Math.ceil(shareMax + 2);
  const rankAxisMin = Math.floor(Math.max(1, rankMin));
  const rankAxisMax = Math.ceil(rankMax);

  const xToPx = (i) =>
    padding.l + (rows.length === 1 ? plotW / 2 : (i / (rows.length - 1)) * plotW);
  const shareToPy = (v) => {
    const t = shareAxisMax === shareAxisMin ? 0.5 : (v - shareAxisMin) / (shareAxisMax - shareAxisMin);
    return padding.t + (1 - t) * plotH;
  };
  const rankToPy = (v) => {
    // reversed axis: smaller rank is better, draw higher
    const t = rankAxisMax === rankAxisMin ? 0.5 : (v - rankAxisMin) / (rankAxisMax - rankAxisMin);
    return padding.t + t * plotH;
  };

  // Grid
  ctx.strokeStyle = "#cbd5e1";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 4; i++) {
    const y = padding.t + (i / 4) * plotH;
    ctx.moveTo(padding.l, y);
    ctx.lineTo(padding.l + plotW, y);
  }
  ctx.stroke();

  // Axes labels
  ctx.fillStyle = "#111827";
  ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto";
  ctx.fillStyle = "#2563eb";
  ctx.fillText("Share (%)", padding.l, 18);
  ctx.fillStyle = "#ea580c";
  ctx.fillText("Rank", w - padding.r - 8, 18);

  // Y axis ticks: left Share, right Rank
  ctx.font = "11px system-ui, -apple-system, Segoe UI, Roboto";
  for (let i = 0; i <= 4; i++) {
    const ratio = i / 4;
    const y = padding.t + ratio * plotH;
    const shareTick = shareAxisMax - ratio * (shareAxisMax - shareAxisMin);
    const rankTick = rankAxisMin + ratio * (rankAxisMax - rankAxisMin);
    ctx.fillStyle = "#2563eb";
    ctx.fillText(shareTick.toFixed(1), 8, y + 4);
    ctx.fillStyle = "#ea580c";
    ctx.fillText(rankTick.toFixed(0), w - padding.r + 18, y + 4);
  }

  // X labels (max 8)
  ctx.fillStyle = "#111827";
  const step = Math.max(1, Math.ceil(rows.length / 8));
  for (let i = 0; i < rows.length; i += step) {
    const x = xToPx(i);
    const label = rows[i].date.slice(5); // MM-DD
    ctx.fillText(label, x - 14, padding.t + plotH + 24);
  }

  const drawSeries = (getter, yMap, color, formatValue, labelOffset) => {
    const pts = [];
    for (let i = 0; i < rows.length; i++) {
      const v = getter(rows[i]);
      if (v == null) continue;
      pts.push({ x: xToPx(i), y: yMap(v), v, i });
    }
    if (pts.length < 1) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.fillStyle = color;
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Point values. Show all for short series; otherwise interval labels.
    const valueStep = Math.max(1, Math.ceil(rows.length / 18));
    ctx.font = "10px system-ui, -apple-system, Segoe UI, Roboto";
    ctx.fillStyle = "#111827";
    for (const p of pts) {
      if (p.i % valueStep !== 0 && p.i !== rows.length - 1) continue;
      ctx.fillText(formatValue(p.v), p.x - 10, p.y + labelOffset);
    }
  };

  if (showShare) drawSeries((r) => r.share, shareToPy, "#2563eb", (v) => `${v.toFixed(1)}%`, -8);
  if (showRank) drawSeries((r) => r.rank, rankToPy, "#ea580c", (v) => `${Math.round(v)}`, 14);

  // Legend
  const legendY = 32;
  let lx = padding.l + 8;
  const legend = [];
  if (showShare) legend.push({ label: "Share", color: "#60a5fa" });
  if (showRank) legend.push({ label: "Rank", color: "#fb923c" });
  for (const item of legend) {
    ctx.fillStyle = item.color;
    ctx.fillRect(lx, legendY - 8, 10, 3);
    lx += 14;
    ctx.fillStyle = "#111827";
    ctx.fillText(item.label, lx, legendY - 4);
    lx += ctx.measureText(item.label).width + 14;
  }
}

function renderMarketChart(rows, { showMarket }) {
  const canvas = $("marketChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (!showMarket) {
    ctx.fillStyle = "#111827";
    ctx.font = "14px system-ui, -apple-system, Segoe UI, Roboto";
    ctx.fillText("已隐藏市场总曝光趋势图（勾选“显示市场总曝光”可显示）", 20, 30);
    return;
  }

  const vals = rows.map((r) => r.market_impressions).filter((v) => v != null);
  if (!vals.length) {
    ctx.fillStyle = "#111827";
    ctx.font = "14px system-ui, -apple-system, Segoe UI, Roboto";
    ctx.fillText("缺少 Impressions 或 Share，无法计算市场总曝光。", 20, 30);
    return;
  }

  const padding = { l: 82, r: 18, t: 38, b: 42 };
  const plotW = w - padding.l - padding.r;
  const plotH = h - padding.t - padding.b;
  const min = Math.min(...vals);
  const max = Math.max(...vals);

  const xToPx = (i) =>
    padding.l + (rows.length === 1 ? plotW / 2 : (i / (rows.length - 1)) * plotW);
  const yToPy = (v) => {
    const lo = Math.max(0, min * 0.95);
    const hi = max * 1.05;
    const t = hi === lo ? 0.5 : (v - lo) / (hi - lo);
    return padding.t + (1 - t) * plotH;
  };

  // grid
  ctx.strokeStyle = "#cbd5e1";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 4; i++) {
    const y = padding.t + (i / 4) * plotH;
    ctx.moveTo(padding.l, y);
    ctx.lineTo(padding.l + plotW, y);
  }
  ctx.stroke();

  // labels
  ctx.fillStyle = "#111827";
  ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto";
  ctx.fillText("市场总曝光", padding.l, 18);

  // x labels
  ctx.fillStyle = "#111827";
  const step = Math.max(1, Math.ceil(rows.length / 8));
  for (let i = 0; i < rows.length; i += step) {
    const x = xToPx(i);
    const label = rows[i].date.slice(5);
    ctx.fillText(label, x - 14, padding.t + plotH + 24);
  }

  // line
  const pts = [];
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i].market_impressions;
    if (v == null) continue;
    pts.push({ x: xToPx(i), y: yToPy(v), v, i });
  }
  if (pts.length) {
    ctx.strokeStyle = "#0f766e";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.fillStyle = "#0f766e";
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    const valueStep = Math.max(1, Math.ceil(rows.length / 18));
    ctx.font = "10px system-ui, -apple-system, Segoe UI, Roboto";
    ctx.fillStyle = "#111827";
    for (const p of pts) {
      if (p.i % valueStep !== 0 && p.i !== rows.length - 1) continue;
      ctx.fillText(Math.round(p.v).toLocaleString(), p.x - 18, p.y - 8);
    }
  }

  // y axis tick (show min/max)
  ctx.fillStyle = "#111827";
  ctx.fillText(Math.round(max).toLocaleString(), padding.l - 66, padding.t + 10);
  ctx.fillText(Math.round(min).toLocaleString(), padding.l - 66, padding.t + plotH);
}

function init() {
  setupTabs();

  $("file").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const name = (f.name || "").toLowerCase();
    if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      await loadXlsx(f);
      return;
    }
    if (name.endsWith(".txt")) {
      loadDelimitedFile(f, "\t");
      return;
    }
    loadDelimitedFile(f);
  });

  $("btnLoadSample").addEventListener("click", loadSample);
  $("btnAnalyze").addEventListener("click", analyze);
  $("btnExport").addEventListener("click", exportCsv);

  // Filters only re-render tables (do not re-parse the whole file)
  $("search").addEventListener("input", refreshViewsDebounced);
  $("marketMatchMode")?.addEventListener("change", refreshViews);
  $("minDays").addEventListener("change", refreshViews);
  $("marketSortField")?.addEventListener("change", refreshViews);
  $("marketSortDir")?.addEventListener("change", refreshViews);
  $("quadSearch")?.addEventListener("input", refreshViewsDebounced);
  $("quadMatchMode")?.addEventListener("change", refreshViews);
  $("quadFilter").addEventListener("change", refreshViews);
  $("quadSortField")?.addEventListener("change", refreshViews);
  $("quadSortDir")?.addEventListener("change", refreshViews);
  $("shareHigh")?.addEventListener("change", refreshViews);
  $("rankGood")?.addEventListener("change", refreshViews);
  $("acosGood")?.addEventListener("change", refreshViews);

  $("termQuery")?.addEventListener("input", () => {
    if (!rawRows.length) return;
    populateTermPicker();
    renderSelectedTermTrend();
  });
  $("termMatchMode")?.addEventListener("change", () => {
    if (!rawRows.length) return;
    populateTermPicker();
    renderSelectedTermTrend();
  });
  $("termPick")?.addEventListener("change", () => {
    if (!rawRows.length) return;
    renderSelectedTermTrend();
  });
  $("showShare")?.addEventListener("change", () => rawRows.length && renderSelectedTermTrend());
  $("showRank")?.addEventListener("change", () => rawRows.length && renderSelectedTermTrend());
  $("showMarket")?.addEventListener("change", () => rawRows.length && renderSelectedTermTrend());

  // Initial sample load for zero-config usage
  loadSample().catch(() => {});
}

init();

