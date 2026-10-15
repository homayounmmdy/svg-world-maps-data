#!/usr/bin/env node
/**
 * generate-maps-report.mjs
 * ---------------------------------------------------------------------------
 * Scans the `maps/` directory for *.ts map definitions and produces a single,
 * self-contained static HTML report (MAPS_INFO.html) that can be opened
 * directly in a browser — similar to the HTML coverage report produced by
 * Vitest / Jest / Istanbul.
 *
 * Features
 *  - No external dependencies, no build step, works offline (file://).
 *  - Live search + filter chips (All / Labels / No labels / Capitals / ...)
 *  - Sortable table columns
 *  - Click a command to copy it to the clipboard
 *  - Summary cards with coverage progress bars
 *  - "Missing" sections for maps without labels / capitals
 *  - Light + dark theme (follows the OS preference)
 *
 * Usage:
 *   node generate-maps-report.mjs
 *   → writes ./MAPS_INFO.html
 * ---------------------------------------------------------------------------
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Configuration ──────────────────────────────────────────────────────────
const MAPS_DIR = path.join(process.cwd(), "maps");
const OUTPUT_FILE = path.join(process.cwd(), "index.html");

// ─── Helpers ────────────────────────────────────────────────────────────────
function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[ch];
  });
}

function coverageClass(pct) {
  if (pct >= 90) return "good";
  if (pct >= 70) return "warn";
  return "bad";
}

// ─── Map file parsing (same logic as before) ────────────────────────────────
function extractMapInfo(content, fileName) {
  const command = fileName.replace(/\.ts$/i, "").toLowerCase();
  const nameMatch = content.match(/\bname\s*:\s*["']([^"']+)["']/);
  const mapName = nameMatch ? nameMatch[1] : command;
  const codeMatch = content.match(/\bcode\s*:\s*["']([^"']+)["']/);
  const mapCode = codeMatch ? codeMatch[1] : "N/A";

  let stateCount = 0;
  const statesMatch = content.match(/\bstates\s*:\s*\[/);
  if (statesMatch) {
    const startIndex = statesMatch.index + statesMatch[0].length;
    const restOfContent = content.slice(startIndex);
    let depth = 1;
    let endIndex = 0;
    for (let i = 0; i < restOfContent.length; i++) {
      const char = restOfContent[i];
      if (char === "[") depth++;
      else if (char === "]") depth--;
      if (depth === 0) {
        endIndex = i;
        break;
      }
    }
    if (endIndex > 0) {
      const statesBlock = restOfContent.slice(0, endIndex);
      const nameMatchesInStates = statesBlock.match(
        /\bname\s*:\s*["'][^"']*["']/g,
      );
      stateCount = nameMatchesInStates ? nameMatchesInStates.length : 0;
    }
  }

  const hasLabels = /\blabels\s*:\s*\[[^\]]*\{/.test(content);

  // Detect a `capitals:` property. It may be a string OR an array literal.
  //   capitals: "Berlin",
  //   capitals: { name: "Berlin", x: "...", y: "..." },
  //   capitals: [ { name: "Pretoria", ... }, ... ],
  const capitalsMatch = content.match(/\bcapitals\s*:\s*/);
  let hasCapitals = false;
  let capitalCount = 0;
  let capitalNames = [];

  if (capitalsMatch) {
    const afterIdx = capitalsMatch.index + capitalsMatch[0].length;
    const after = content.slice(afterIdx);
    const trimmed = after.replace(/^[\s\r\n]+/, "");
    const firstChar = trimmed[0];

    if (firstChar === "[") {
      // Array form — bracket match to get the full block
      let depth = 0;
      let end = -1;
      for (let i = 0; i < trimmed.length; i++) {
        const c = trimmed[i];
        if (c === "[") depth++;
        else if (c === "]") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end !== -1) {
        const block = trimmed.slice(1, end);
        const names = block.match(/\bname\s*:\s*["'`]([^"'`]+)["'`]/g) || [];
        capitalNames = names
          .map((n) => {
            const m = n.match(/["'`]([^"'`]+)["'`]/);
            return m ? m[1] : null;
          })
          .filter(Boolean);
        capitalCount = capitalNames.length;
        hasCapitals = capitalCount > 0;
      }
    } else if (firstChar === "{") {
      // Single object form
      const objMatch = trimmed.match(/\{[^{}]*\}/);
      if (objMatch) {
        const nm = objMatch[0].match(/\bname\s*:\s*["'`]([^"'`]+)["'`]/);
        if (nm) {
          capitalNames = [nm[1]];
          capitalCount = 1;
          hasCapitals = true;
        }
      }
    } else if (firstChar === '"' || firstChar === "'" || firstChar === "`") {
      // Plain string form
      const sm = trimmed.match(/^["'`]([^"'`]+)["'`]/);
      if (sm) {
        capitalNames = [sm[1]];
        capitalCount = 1;
        hasCapitals = true;
      }
    }
  }

  return {
    command,
    mapName,
    mapCode,
    stateCount,
    hasLabels,
    hasCapitals,
    capitalCount,
    capitalNames,
  };
}

// ─── Styles (embedded in the generated HTML) ────────────────────────────────
const CSS = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;
  font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  font-size:14px;line-height:1.5;color:var(--text);background:var(--bg);
}
code,.mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;font-size:12.5px}

:root{
  --bg:#f6f8fa;--panel:#ffffff;--text:#1f2328;--muted:#656d76;
  --border:#d0d7de;--border-soft:#eaeef2;
  --green:#1a7f37;--green-bg:#dafbe1;
  --red:#cf222e;--red-bg:#ffebe9;
  --yellow:#9a6700;--yellow-bg:#fff8c5;
  --accent:#0969da;--accent-bg:#ddf4ff;
  --radius:10px;
  --shadow:0 1px 3px rgba(27,31,36,.06);
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#0d1117;--panel:#161b22;--text:#e6edf3;--muted:#8b949e;
    --border:#30363d;--border-soft:#21262d;
    --green:#3fb950;--green-bg:#12261e;
    --red:#f85149;--red-bg:#2d1214;
    --yellow:#d29922;--yellow-bg:#2b2413;
    --accent:#58a6ff;--accent-bg:#0c2d6b;
    --shadow:0 1px 3px rgba(0,0,0,.4);
  }
}

/* ── Top bar ───────────────────────────────────────────── */
.topbar{
  position:sticky;top:0;z-index:20;
  display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;
  padding:16px 24px;background:var(--panel);border-bottom:1px solid var(--border);
}
.topbar h1{margin:0;font-size:18px;font-weight:600;letter-spacing:-.01em}
.topbar .sub{margin:2px 0 0;color:var(--muted);font-size:12.5px}
.topbar .stamp{color:var(--muted);font-size:12.5px;white-space:nowrap}

main{max-width:1200px;margin:0 auto;padding:24px}

/* ── Summary cards ─────────────────────────────────────── */
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px;margin-bottom:24px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;box-shadow:var(--shadow)}
.card .k{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.card .v{font-size:28px;font-weight:700;line-height:1.15;margin-top:6px;font-variant-numeric:tabular-nums}
.card .d{font-size:12.5px;color:var(--muted);margin-top:2px}
.bar{height:6px;border-radius:999px;background:var(--border-soft);overflow:hidden;margin-top:12px}
.bar > i{display:block;height:100%;border-radius:999px;transition:width .3s ease}
.bar > i.good{background:var(--green)}
.bar > i.warn{background:var(--yellow)}
.bar > i.bad{background:var(--red)}

/* ── Panels ────────────────────────────────────────────── */
.panel{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);margin-bottom:24px;overflow:hidden}
.panel > header{
  padding:14px 18px;border-bottom:1px solid var(--border-soft);
  display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;
}
.panel h2{margin:0;font-size:15px;font-weight:600}
.panel .hint{color:var(--muted);font-size:12.5px}
.panel .body{padding:16px 18px}

/* ── Toolbar ───────────────────────────────────────────── */
.toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:14px 18px;border-bottom:1px solid var(--border-soft)}
.search{position:relative;flex:1 1 220px;max-width:340px}
.search input{
  width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:8px;
  background:var(--bg);color:var(--text);font-size:13px;outline:none;
}
.search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-bg)}
.search kbd{
  position:absolute;right:8px;top:50%;transform:translateY(-50%);
  font-size:11px;color:var(--muted);border:1px solid var(--border);
  border-radius:4px;padding:1px 5px;background:var(--panel);pointer-events:none;
}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{
  padding:6px 11px;border-radius:999px;border:1px solid var(--border);
  background:transparent;color:var(--muted);font-size:12.5px;font-weight:500;
  cursor:pointer;transition:all .12s ease;
}
.chip:hover{border-color:var(--accent);color:var(--accent)}
.chip.active{background:var(--accent-bg);border-color:var(--accent);color:var(--accent)}
.count{color:var(--muted);font-size:12.5px;margin-left:auto;white-space:nowrap}

/* ── Table ─────────────────────────────────────────────── */
.table-scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13.5px}
thead th{
  position:sticky;top:0;z-index:1;background:var(--panel);
  text-align:left;font-size:11.5px;font-weight:700;letter-spacing:.04em;
  text-transform:uppercase;color:var(--muted);
  padding:10px 16px;border-bottom:1px solid var(--border);white-space:nowrap;user-select:none;
}
th[data-key]{cursor:pointer}
th[data-key]:hover{color:var(--accent)}
th.sorted{color:var(--text)}
th .arrow{font-size:9px;margin-left:4px;opacity:.9}
tbody td{padding:10px 16px;border-bottom:1px solid var(--border-soft);vertical-align:middle}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:var(--bg)}
td.empty{text-align:center;color:var(--muted);padding:32px 16px}

button.cmd{
  font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  font-size:12.5px;background:var(--accent-bg);color:var(--accent);
  border:1px solid transparent;border-radius:6px;padding:3px 8px;cursor:pointer;
  transition:all .12s ease;
}
button.cmd:hover{border-color:var(--accent)}
button.cmd.copied{background:var(--green-bg);color:var(--green);border-color:transparent}

.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.badge.yes{background:var(--green-bg);color:var(--green)}
.badge.no{background:var(--red-bg);color:var(--red)}

.states{display:flex;align-items:center;gap:8px}
.states-num{font-variant-numeric:tabular-nums;min-width:38px;text-align:right;font-weight:600}
.states-bar{flex:0 0 60px;height:6px;border-radius:999px;background:var(--border-soft);overflow:hidden}
.states-bar i{display:block;height:100%;background:var(--accent);border-radius:999px}

/* ── Missing lists ─────────────────────────────────────── */
.missing-list{display:flex;flex-wrap:wrap;gap:8px;padding:16px 18px}
.missing-item{
  border:1px solid var(--border);border-radius:8px;padding:6px 10px;
  font-size:12.5px;background:var(--bg);
}
.missing-item code{color:var(--accent);margin-right:6px}
.all-good{padding:16px 18px;color:var(--green);font-weight:600}

footer{color:var(--muted);font-size:12.5px;text-align:center;padding:8px 24px 40px}
footer code{color:var(--text)}

@media print{
  .topbar{position:static}
  .toolbar,.chips,.search{display:none}
  body{background:#fff}
  .panel,.card{box-shadow:none;break-inside:avoid}
}
`;

// ─── Client-side behaviour (embedded verbatim, no template literals used) ───
const CLIENT_JS = `
(function () {
  "use strict";

  var DATA = window.__MAPS_DATA__ || { maps: [], maxStates: 1 };
  var MAPS = DATA.maps;
  var MAX_STATES = DATA.maxStates || 1;

  var tbody = document.getElementById("rows");
  var visibleEl = document.getElementById("visible-count");
  var searchEl = document.getElementById("search");
  var chips = Array.prototype.slice.call(document.querySelectorAll(".chip"));

  var state = { q: "", filter: "all", sortKey: "mapName", sortDir: 1 };

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function badge(ok) {
    return ok
      ? '<span class="badge yes">Yes</span>'
      : '<span class="badge no">No</span>';
  }

  function matches(m) {
    if (state.q) {
      var hay = (m.command + " " + m.mapName + " " + m.mapCode).toLowerCase();
      if (hay.indexOf(state.q) === -1) return false;
    }
    if (state.filter === "labels") return m.hasLabels;
    if (state.filter === "nolabels") return !m.hasLabels;
    if (state.filter === "capitals") return m.hasCapitals;
    if (state.filter === "nocapitals") return !m.hasCapitals;
    return true;
  }

  function sorted(list) {
    var key = state.sortKey;
    var dir = state.sortDir;
    return list.slice().sort(function (a, b) {
      var av = a[key];
      var bv = b[key];
      if (typeof av === "boolean") { av = av ? 1 : 0; bv = bv ? 1 : 0; }
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv), undefined, { sensitivity: "base" }) * dir;
    });
  }

  function paintSort() {
    var ths = document.querySelectorAll("th[data-key]");
    for (var i = 0; i < ths.length; i++) {
      var th = ths[i];
      var active = th.getAttribute("data-key") === state.sortKey;
      th.className = active ? "sorted" : "";
      var arrow = th.querySelector(".arrow");
      if (arrow) arrow.textContent = active ? (state.sortDir === 1 ? "\\u25B2" : "\\u25BC") : "";
    }
  }

  function render() {
    var list = sorted(MAPS.filter(matches));
    var out = [];

    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      var pct = Math.max(3, Math.round((m.stateCount / MAX_STATES) * 100));
      out.push(
        "<tr>" +
          '<td><button type="button" class="cmd" data-copy="' + esc(m.command) +
            '" title="Click to copy">' + esc(m.command) + "</button></td>" +
          "<td>" + esc(m.mapName) + "</td>" +
          "<td><code>" + esc(m.mapCode) + "</code></td>" +
          '<td><div class="states">' +
            '<span class="states-num">' + m.stateCount.toLocaleString() + "</span>" +
            '<span class="states-bar"><i style="width:' + pct + '%"></i></span>' +
          "</div></td>" +
          '<td>' + badge(m.hasLabels) + "</td>" +
          '<td>' + badge(m.hasCapitals) + "</td>" +
        "</tr>"
      );
    }

    if (!list.length) {
      out.push('<tr><td colspan="6" class="empty">No maps match the current search or filter.</td></tr>');
    }

    tbody.innerHTML = out.join("");
    visibleEl.textContent = list.length + " of " + MAPS.length + " maps";
    paintSort();
  }

  // Sortable headers
  var ths = document.querySelectorAll("th[data-key]");
  for (var t = 0; t < ths.length; t++) {
    (function (th) {
      th.addEventListener("click", function () {
        var key = th.getAttribute("data-key");
        if (state.sortKey === key) state.sortDir = -state.sortDir;
        else { state.sortKey = key; state.sortDir = 1; }
        render();
      });
    })(ths[t]);
  }

  // Filter chips
  for (var c = 0; c < chips.length; c++) {
    (function (chip) {
      chip.addEventListener("click", function () {
        for (var j = 0; j < chips.length; j++) chips[j].classList.remove("active");
        chip.classList.add("active");
        state.filter = chip.getAttribute("data-filter");
        render();
      });
    })(chips[c]);
  }

  // Search
  searchEl.addEventListener("input", function () {
    state.q = searchEl.value.trim().toLowerCase();
    render();
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "/" && document.activeElement !== searchEl) {
      e.preventDefault();
      searchEl.focus();
      searchEl.select();
    }
  });

  // Copy-to-clipboard (event delegation)
  tbody.addEventListener("click", function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest("button.cmd") : null;
    if (!btn) return;

    var text = btn.getAttribute("data-copy");
    var done = function () {
      var old = btn.getAttribute("data-label") || btn.textContent;
      btn.setAttribute("data-label", old);
      btn.classList.add("copied");
      btn.textContent = "Copied!";
      setTimeout(function () {
        btn.classList.remove("copied");
        btn.textContent = old;
      }, 900);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
    } else {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (err) { /* ignore */ }
      document.body.removeChild(ta);
      done();
    }
  });

  render();
})();
`;

// ─── HTML renderer ──────────────────────────────────────────────────────────
function renderHtml({ mapInfos, stats, generatedAt, mapsDirRelative }) {
  const payload = {
    generatedAt,
    maxStates: stats.maxStates,
    maps: mapInfos,
  };
  // Escape "<" so the JSON can never terminate the <script> block early.
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");

  const withoutLabels = mapInfos.filter((m) => !m.hasLabels);
  const withoutCapitals = mapInfos.filter((m) => !m.hasCapitals);

  const labelPct = stats.labelCoverage;
  const capitalPct = stats.capitalCoverage;

  const missingLabelsHtml = withoutLabels.length
    ? `<div class="missing-list">${withoutLabels
        .map(
          (m) =>
            `<span class="missing-item"><code>${escapeHtml(m.command)}</code>${escapeHtml(m.mapName)}</span>`,
        )
        .join("")}</div>`
    : `<p class="all-good">🎉 All maps currently support label placement.</p>`;

  const missingCapitalsHtml = withoutCapitals.length
    ? `<div class="missing-list">${withoutCapitals
        .map(
          (m) =>
            `<span class="missing-item"><code>${escapeHtml(m.command)}</code>${escapeHtml(m.mapName)}</span>`,
        )
        .join("")}</div>`
    : `<p class="all-good">🎉 All maps currently define capitals.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Maps Information Report</title>
<style>${CSS}</style>
</head>
<body>

<header class="topbar">
  <div>
    <h1>🗺️ Maps Information Report</h1>
    <p class="sub">Auto-generated from <code>${escapeHtml(mapsDirRelative)}</code> · ${stats.total} map${stats.total === 1 ? "" : "s"}</p>
  </div>
  <div class="stamp">📅 ${escapeHtml(generatedAt)}</div>
</header>

<main>
  <section class="cards">
    <div class="card">
      <div class="k">Total Maps</div>
      <div class="v">${stats.total}</div>
      <div class="d">${stats.totalStates.toLocaleString()} regions / states tracked</div>
    </div>

    <div class="card">
      <div class="k">Label Coverage</div>
      <div class="v">${labelPct}%</div>
      <div class="d">${stats.withLabels} of ${stats.total} maps · ${stats.withoutLabels} pending</div>
      <div class="bar"><i class="${coverageClass(labelPct)}" style="width:${labelPct}%"></i></div>
    </div>

    <div class="card">
      <div class="k">Capital Coverage</div>
      <div class="v">${capitalPct}%</div>
      <div class="d">${stats.withCapitals} of ${stats.total} maps · ${stats.withoutCapitals} missing</div>
      <div class="bar"><i class="${coverageClass(capitalPct)}" style="width:${capitalPct}%"></i></div>
    </div>

    <div class="card">
      <div class="k">Average Regions</div>
      <div class="v">${stats.total ? Math.round(stats.totalStates / stats.total).toLocaleString() : 0}</div>
      <div class="d">Largest map: ${stats.maxStates.toLocaleString()} regions</div>
    </div>
  </section>

  <section class="panel">
    <div class="toolbar">
      <div class="search">
        <input id="search" type="search" placeholder="Search command, country or code…" autocomplete="off" spellcheck="false">
        <kbd>/</kbd>
      </div>
      <div class="chips">
        <button type="button" class="chip active" data-filter="all">All</button>
        <button type="button" class="chip" data-filter="labels">Has labels</button>
        <button type="button" class="chip" data-filter="nolabels">No labels</button>
        <button type="button" class="chip" data-filter="capitals">Has capitals</button>
        <button type="button" class="chip" data-filter="nocapitals">No capitals</button>
      </div>
      <span class="count" id="visible-count">${stats.total} of ${stats.total} maps</span>
    </div>

    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th data-key="command">Command<span class="arrow"></span></th>
            <th data-key="mapName">Country Name<span class="arrow"></span></th>
            <th data-key="mapCode">Code<span class="arrow"></span></th>
            <th data-key="stateCount">Regions / States<span class="arrow"></span></th>
            <th data-key="hasLabels">Has Labels<span class="arrow"></span></th>
            <th data-key="hasCapitals">Has Capitals<span class="arrow"></span></th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
  </section>

  <section class="panel">
    <header>
      <h2>📝 Maps pending label support</h2>
      <span class="hint">${stats.withoutLabels} of ${stats.total} maps</span>
    </header>
    ${missingLabelsHtml}
  </section>

  <section class="panel">
    <header>
      <h2>💰 Maps without defined capitals</h2>
      <span class="hint">${stats.withoutCapitals} of ${stats.total} maps</span>
    </header>
    ${missingCapitalsHtml}
  </section>

  <footer>
    Generated by <code>generate-maps-report.mjs</code> · click any command to copy it.
  </footer>
</main>

<script>
window.__MAPS_DATA__ = ${json};
${CLIENT_JS}
</script>
</body>
</html>
`;
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  try {
    if (!fs.existsSync(MAPS_DIR)) {
      console.error(`❌ Error: Directory not found at ${MAPS_DIR}`);
      process.exit(1);
    }

    const files = fs
      .readdirSync(MAPS_DIR)
      .filter((file) => file.endsWith(".ts"));

    if (files.length === 0) {
      console.log("⚠️  No .ts map files found in the directory.");
      process.exit(0);
    }

    const mapInfos = files
      .map((file) => {
        const filePath = path.join(MAPS_DIR, file);
        const content = fs.readFileSync(filePath, "utf8");
        return extractMapInfo(content, file);
      })
      .sort((a, b) => a.mapName.localeCompare(b.mapName));

    const totalStates = mapInfos.reduce((sum, m) => sum + m.stateCount, 0);
    const withLabels = mapInfos.filter((m) => m.hasLabels);
    const withCapitals = mapInfos.filter((m) => m.hasCapitals);

    const stats = {
      total: mapInfos.length,
      totalStates,
      withLabels: withLabels.length,
      withoutLabels: mapInfos.length - withLabels.length,
      withCapitals: withCapitals.length,
      withoutCapitals: mapInfos.length - withCapitals.length,
      labelCoverage: Number(
        ((withLabels.length / mapInfos.length) * 100).toFixed(1),
      ),
      capitalCoverage: Number(
        ((withCapitals.length / mapInfos.length) * 100).toFixed(1),
      ),
      maxStates: mapInfos.reduce((mx, m) => Math.max(mx, m.stateCount), 1),
    };

    const generatedAt = new Date().toLocaleString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });

    const html = renderHtml({
      mapInfos,
      stats,
      generatedAt,
      mapsDirRelative: path.relative(process.cwd(), MAPS_DIR) || "maps",
    });

    fs.writeFileSync(OUTPUT_FILE, html, "utf8");

    console.log(`\n✅ Report generated: ${OUTPUT_FILE}`);
    console.log(
      `📊 ${stats.total} map(s) | ${totalStates.toLocaleString()} regions | ` +
        `${stats.labelCoverage}% label coverage | ${stats.capitalCoverage}% capital coverage`,
    );
    if (stats.withoutCapitals > 0) {
      console.log(`💰 Maps without capitals: ${stats.withoutCapitals}`);
    }
    console.log(`\n👉 Open it with:  open "${path.relative(process.cwd(), OUTPUT_FILE)}"\n`);
  } catch (error) {
    console.error("❌ Error generating map report:", error);
    process.exit(1);
  }
}

main();