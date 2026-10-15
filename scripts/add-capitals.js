#!/usr/bin/env node
/**
 * analyze-maps.js
 *
 * Scans a folder of .ts map files and logs a structural report for each one.
 *
 * Usage:
 *   node analyze-maps.js                     # scans ./maps
 *   node analyze-maps.js ./maps              # scans a given folder
 *   node analyze-maps.js ./maps --json out.json
 *   node analyze-maps.js ./maps --full       # dump raw analysis per file
 *
 * No dependencies. Static analysis only — files are never executed.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ───────────────────────────── CLI ─────────────────────────────

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));

const ROOT = path.resolve(positional[0] || 'maps');
const FULL = flags.has('--full');

const jsonFlagIndex = argv.indexOf('--json');
const JSON_OUT =
  jsonFlagIndex !== -1 && argv[jsonFlagIndex + 1]
    ? path.resolve(argv[jsonFlagIndex + 1])
    : null;

if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) {
  console.error(`✖ Folder not found: ${ROOT}`);
  process.exit(1);
}

// ─────────────────────────── Helpers ───────────────────────────

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full, out);
    } else if (
      entry.isFile() &&
      /\.tsx?$/.test(entry.name) &&
      !/\.d\.ts$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function countMatches(str, re) {
  const m = str.match(re);
  return m ? m.length : 0;
}

function unique(arr) {
  return [...new Set(arr)];
}

// Keys that usually describe a map's geometry
const HINT_KEYS = [
  'width',
  'height',
  'cols',
  'columns',
  'rows',
  'tileSize',
  'tileWidth',
  'tileHeight',
  'mapWidth',
  'mapHeight',
  'scale',
];

// ──────────────────────── Static analysis ──────────────────────

function analyzeSource(code) {
  const lines = code.split(/\r?\n/);

  const report = {
    lines: lines.length,
    codeLines: lines.filter((l) => {
      const t = l.trim();
      return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    }).length,
    chars: code.length,

    imports: [],
    exports: [],
    interfaces: [],
    typeAliases: [],

    // Detected geometry / config values
    hints: {},

    // Rough structural counts
    counts: {
      objects: countMatches(code, /\{/g),
      arrays: countMatches(code, /\[/g),
      strings: countMatches(code, /(['"`])(?:\\.|(?!\1).)*\1/g),
      numbers: countMatches(code, /(?<![\w$.])-?\d+(?:\.\d+)?(?![\w$])/g),
    },
  };

  // ── imports ────────────────────────────────────────────────
  const importRe = /^\s*import\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
  let m;
  while ((m = importRe.exec(code)) !== null) report.imports.push(m[1]);

  // ── exports: `export const X`, `export default`, ... ───────
  const exportRe =
    /\bexport\s+(?:(default)\s+)?(?:(const|let|var|function|class|interface|type|enum)\s+)?([A-Za-z_$][\w$]*)?/g;
  while ((m = exportRe.exec(code)) !== null) {
    const [, isDefault, kind, name] = m;
    const label = name || (isDefault ? 'default' : null);
    if (!label) continue;
    report.exports.push(kind ? `${kind} ${label}` : label);
  }

  // ── exports: `export { a, b as c }` ────────────────────────
  const namedExportRe = /\bexport\s*\{([^}]*)\}/g;
  while ((m = namedExportRe.exec(code)) !== null) {
    for (const piece of m[1].split(',')) {
      const name = piece.trim().split(/\s+as\s+/).pop().trim();
      if (name) report.exports.push(name);
    }
  }
  report.exports = unique(report.exports);

  // ── interfaces / type aliases ──────────────────────────────
  const ifaceRe = /\binterface\s+([A-Za-z_$][\w$]*)/g;
  while ((m = ifaceRe.exec(code)) !== null) report.interfaces.push(m[1]);

  const typeRe = /\btype\s+([A-Za-z_$][\w$]*)\s*=/g;
  while ((m = typeRe.exec(code)) !== null) report.typeAliases.push(m[1]);

  // ── geometry hints: width: 100, tileSize = 16 ... ──────────
  const keyAlt = HINT_KEYS.join('|');
  const hintRe = new RegExp(
    `\\b(${keyAlt})\\b\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?)`,
    'gi'
  );
  while ((m = hintRe.exec(code)) !== null) {
    const key = m[1].toLowerCase();
    const value = Number(m[2]);
    if (!report.hints[key]) report.hints[key] = [];
    report.hints[key].push(value);
  }
  for (const key of Object.keys(report.hints)) {
    report.hints[key] = unique(report.hints[key]);
  }

  // ── tile maps stored as string rows: rows: ["....", "...."] ─
  const rowsMatch = code.match(/\brows\s*:\s*\[/);
  if (rowsMatch) {
    const start = rowsMatch.index;
    const slice = code.slice(start, start + 500_000);
    const end = slice.indexOf(']');
    const segment = end !== -1 ? slice.slice(0, end) : slice;
    const strings = segment.match(/(['"`])(?:\\.|(?!\1).)*\1/g) || [];
    if (strings.length > 1) {
      report.hints.stringRows = strings.length;
      report.hints.rowWidths = unique(strings.map((s) => s.length - 2));
    }
  }

  return report;
}

// ──────────────────────────── Main ─────────────────────────────

const files = walk(ROOT);

console.log('');
console.log(`📁 Scanning: ${ROOT}`);
console.log(`   Found ${files.length} .ts file(s)\n`);

if (files.length === 0) {
  console.log('Nothing to analyze.');
  process.exit(0);
}

const results = [];
const seenHashes = new Map();

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const code = fs.readFileSync(file, 'utf8');
  const stat = fs.statSync(file);
  const hash = crypto.createHash('sha1').update(code).digest('hex');

  const analysis = analyzeSource(code);

  const duplicateOf = seenHashes.get(hash) || null;
  if (!duplicateOf) seenHashes.set(hash, rel);

  const record = {
    file: rel,
    bytes: stat.size,
    hash,
    duplicateOf,
    ...analysis,
  };
  results.push(record);

  // ── per-file log ──────────────────────────────────────────
  console.log(`── ${rel}`);
  console.log(
    `   ${humanBytes(stat.size)} · ${analysis.lines} lines ` +
      `(${analysis.codeLines} code) · ${analysis.exports.length} export(s) · ${hash.slice(0, 8)}`
  );

  if (analysis.exports.length) {
    console.log(`   exports : ${analysis.exports.join(', ')}`);
  }
  if (analysis.imports.length) {
    console.log(`   imports : ${unique(analysis.imports).join(', ')}`);
  }
  if (analysis.interfaces.length || analysis.typeAliases.length) {
    const parts = [];
    if (analysis.interfaces.length) parts.push(`interfaces: ${analysis.interfaces.join(', ')}`);
    if (analysis.typeAliases.length) parts.push(`types: ${analysis.typeAliases.join(', ')}`);
    console.log(`   types   : ${parts.join(' | ')}`);
  }

  const hintEntries = Object.entries(analysis.hints);
  if (hintEntries.length) {
    const rendered = hintEntries
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') : v}`)
      .join('  ');
    console.log(`   hints   : ${rendered}`);
  }

  const c = analysis.counts;
  console.log(
    `   counts  : ${c.objects} object(s) · ${c.arrays} array(s) · ` +
      `${c.strings} string(s) · ${c.numbers} number(s)`
  );

  if (duplicateOf) console.log(`   ⚠ duplicate of ${duplicateOf}`);
  if (FULL) console.log(JSON.stringify(analysis, null, 2));

  console.log('');
}

// ─────────────────────────── Summary ───────────────────────────

const totalBytes = results.reduce((a, r) => a + r.bytes, 0);
const totalLines = results.reduce((a, r) => a + r.lines, 0);
const duplicates = results.filter((r) => r.duplicateOf);

// group by top-level subfolder
const groups = new Map();
for (const r of results) {
  const top = r.file.includes(path.sep) ? r.file.split(path.sep)[0] : '(root)';
  if (!groups.has(top)) groups.set(top, { count: 0, bytes: 0 });
  const g = groups.get(top);
  g.count += 1;
  g.bytes += r.bytes;
}

console.log('═'.repeat(60));
console.log('SUMMARY');
console.log('═'.repeat(60));
console.log(`Files        : ${results.length}`);
console.log(`Total size   : ${humanBytes(totalBytes)}`);
console.log(`Total lines  : ${totalLines.toLocaleString()}`);
console.log(`Duplicates   : ${duplicates.length}`);
console.log(`Interfaces   : ${unique(results.flatMap((r) => r.interfaces)).length} unique`);
console.log('');

console.log('By folder:');
for (const [name, g] of [...groups.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  ${String(g.count).padStart(4)}  ${humanBytes(g.bytes).padStart(10)}  ${name}`);
}
console.log('');

// biggest files
const biggest = [...results].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
if (biggest.length) {
  console.log('Largest files:');
  for (const r of biggest) {
    console.log(`  ${humanBytes(r.bytes).padStart(10)}  ${r.file}`);
  }
  console.log('');
}

// ─────────────────────────── JSON out ──────────────────────────

if (JSON_OUT) {
  const payload = {
    scannedAt: new Date().toISOString(),
    root: ROOT,
    fileCount: results.length,
    totalBytes,
    totalLines,
    groups: Object.fromEntries(groups),
    files: results,
  };
  fs.writeFileSync(JSON_OUT, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`📄 JSON report written to ${JSON_OUT}`);
}