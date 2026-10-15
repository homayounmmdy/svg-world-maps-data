#!/usr/bin/env node
/**
 * inject-capitals.js
 *
 * Reads capitals.json, scans the maps folder, matches each map by filename
 * (or its `name:` field as a fallback), then injects/updates a `capitals`
 * property in the map object.
 *
 * The `capitals` value is written as an object { name, x, y } where x/y are
 * pulled from the matching entry inside the map's `labels` array.
 * If no matching label is found, it falls back to a plain string.
 *
 * Usage:
 *   node inject-capitals.js                     # dry run on ./maps
 *   node inject-capitals.js ./maps              # dry run on a folder
 *   node inject-capitals.js ./maps --write      # apply changes
 *   node inject-capitals.js ./maps scripts/capitals.json --write
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ───────────────────────────── CLI ─────────────────────────────

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));

const MAPS_DIR = path.resolve(positional[0] || 'maps');
const CAPITALS_FILE = path.resolve(positional[1] || 'scripts/capitals.json');
const WRITE = flags.has('--write');

// ─────────────────────── Load capitals.json ────────────────────

if (!fs.existsSync(CAPITALS_FILE)) {
  console.error(`✖ capitals.json not found: ${CAPITALS_FILE}`);
  process.exit(1);
}

let capitalsRaw;
try {
  capitalsRaw = JSON.parse(fs.readFileSync(CAPITALS_FILE, 'utf8'));
} catch (err) {
  console.error(`✖ Failed to parse ${CAPITALS_FILE}: ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(capitalsRaw)) {
  console.error('✖ capitals.json must be an array of { filename, capitals }.');
  process.exit(1);
}

// lowercase filename → capitals
const capitalsLookup = new Map();
for (const entry of capitalsRaw) {
  if (!entry || typeof entry.filename !== 'string') continue;
  capitalsLookup.set(entry.filename.toLowerCase(), entry.capitals ?? '');
}

// ───────────────────────────── Helpers ─────────────────────────

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walk(full, out);
    } else if (
      e.isFile() &&
      /\.tsx?$/.test(e.name) &&
      !/\.d\.ts$/.test(e.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

function stripExt(name) {
  return name.replace(/\.tsx?$/i, '');
}

/**
 * Extract every label object from the map source.
 * Returns [{ name, x, y, code }]
 */
function extractLabels(code) {
  const labelsKeyIdx = code.search(/\blabels\s*:\s*\[/);
  if (labelsKeyIdx === -1) return [];

  const open = code.indexOf('[', labelsKeyIdx);
  if (open === -1) return [];

  // Bracket-match to find the end of the labels array
  let depth = 0;
  let close = -1;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return [];

  const body = code.slice(open + 1, close);

  const labels = [];
  const objRe = /\{([^{}]*)\}/g;
  let m;
  while ((m = objRe.exec(body)) !== null) {
    const obj = m[1];
    const nameM = obj.match(/\bname\s*:\s*["'`]([^"'`]*)["'`]/);
    const xM = obj.match(/\bx\s*:\s*["'`]([^"'`]*)["'`]/);
    const yM = obj.match(/\by\s*:\s*["'`]([^"'`]*)["'`]/);
    const codeM = obj.match(/\bcode\s*:\s*["'`]([^"'`]*)["'`]/);
    if (nameM && xM && yM) {
      labels.push({
        name: nameM[1],
        x: xM[1],
        y: yM[1],
        code: codeM ? codeM[1] : null,
      });
    }
  }
  return labels;
}

/**
 * Find a label whose name matches the capital (case-insensitive).
 * Returns the label or null.
 */
function findCapitalLabel(labels, capitalName) {
  if (!capitalName) return null;
  const target = String(capitalName).trim().toLowerCase();

  // Exact match first
  let hit = labels.find((l) => l.name.trim().toLowerCase() === target);
  if (hit) return hit;

  // Then "contains" match (e.g. "Sana'a" vs "Sana'a City")
  hit = labels.find((l) => {
    const n = l.name.trim().toLowerCase();
    return n.includes(target) || target.includes(n);
  });
  return hit || null;
}

// ──────────────────────────── Main ─────────────────────────────

if (!fs.existsSync(MAPS_DIR)) {
  console.error(`✖ Maps folder not found: ${MAPS_DIR}`);
  process.exit(1);
}

const files = walk(MAPS_DIR);

console.log('');
console.log(`📁 Maps     : ${MAPS_DIR}`);
console.log(`📄 Capitals : ${CAPITALS_FILE}  (${capitalsLookup.size} entr${capitalsLookup.size === 1 ? 'y' : 'ies'})`);
console.log(`🔧 Mode     : ${WRITE ? 'WRITE (changes will be saved)' : 'DRY RUN (no files touched)'}`);
console.log(`   Found ${files.length} .ts file(s)\n`);

if (files.length === 0) {
  console.log('Nothing to do.');
  process.exit(0);
}

// Regexes (anchored per-line, multiline)
const RE_EXISTING_CAPITALS =
  /^([ \t]*)capitals\s*:\s*(?:\{[^{}]*\}|["'`][^"'`]*["'`])\s*,?[ \t]*$/m;
const RE_CODE = /^([ \t]*)code\s*:\s*["'`][^"'`]*["'`]\s*,?[ \t]*$/m;
const RE_NAME = /^([ \t]*)name\s*:\s*["'`][^"'`]*["'`]\s*,?[ \t]*$/m;
const RE_STATES = /^([ \t]*)states\s*:/m;
const RE_NAME_VALUE = /\bname\s*:\s*["'`]([^"'`]+)["'`]/;

let matched = 0;
let injected = 0;
let updated = 0;
let skipped = 0;
let withCoords = 0;
let withoutCoords = 0;
const usedCapitals = new Set();

for (const file of files) {
  const rel = path.relative(MAPS_DIR, file);
  const base = stripExt(path.basename(file));
  const code = fs.readFileSync(file, 'utf8');

  // 1) Try match by filename
  let capitalName = capitalsLookup.get(base.toLowerCase());
  let matchedBy = 'filename';

  // 2) Fallback: match by internal `name:` value
  if (capitalName === undefined) {
    const m = code.match(RE_NAME_VALUE);
    if (m) {
      const byName = capitalsLookup.get(m[1].toLowerCase());
      if (byName !== undefined) {
        capitalName = byName;
        matchedBy = 'name';
      }
    }
  }

  if (capitalName === undefined) {
    console.log(`· ${rel}  → no capital match`);
    skipped++;
    continue;
  }

  matched++;
  usedCapitals.add(String(capitalName).toLowerCase());

  // ── Look up x/y from the labels array ──────────────────────
  const labels = extractLabels(code);
  const label = findCapitalLabel(labels, capitalName);

  let quoted;
  if (label) {
    withCoords++;
    quoted = `{ name: ${JSON.stringify(capitalName)}, x: ${JSON.stringify(
      label.x
    )}, y: ${JSON.stringify(label.y)} }`;
  } else {
    withoutCoords++;
    quoted = JSON.stringify(String(capitalName));
    if (labels.length) {
      console.log(
        `   ⚠ ${rel}: label for "${capitalName}" not found among ${labels.length} label(s)`
      );
    } else {
      console.log(`   ⚠ ${rel}: no labels array found`);
    }
  }

  // Case A: capitals already exists → replace value
  if (RE_EXISTING_CAPITALS.test(code)) {
    const newCode = code.replace(
      RE_EXISTING_CAPITALS,
      (_m, indent) => `${indent}capitals: ${quoted},`
    );
    if (newCode !== code) {
      updated++;
      console.log(`↻ ${rel}  [${matchedBy}] → capitals: ${quoted}  (updated)`);
      if (WRITE) fs.writeFileSync(file, newCode, 'utf8');
    } else {
      skipped++;
      console.log(`= ${rel}  [${matchedBy}] → already up to date`);
    }
    continue;
  }

  // Case B: inject after `code:`, else after `name:`, else before `states:`
  let newCode = null;

  if (RE_CODE.test(code)) {
    newCode = code.replace(
      RE_CODE,
      (_m, indent) => `${_m}\n${indent}capitals: ${quoted},`
    );
  } else if (RE_NAME.test(code)) {
    newCode = code.replace(
      RE_NAME,
      (_m, indent) => `${_m}\n${indent}capitals: ${quoted},`
    );
  } else if (RE_STATES.test(code)) {
    newCode = code.replace(
      RE_STATES,
      (_m, indent) => `${indent}capitals: ${quoted},\n${_m}`
    );
  }

  if (!newCode || newCode === code) {
    console.log(`⚠ ${rel}  matched "${capitalName}" but no safe insertion point`);
    skipped++;
    continue;
  }

  injected++;
  console.log(`+ ${rel}  [${matchedBy}] → capitals: ${quoted}  (injected)`);
  if (WRITE) fs.writeFileSync(file, newCode, 'utf8');
}

// ─────────────────────────── Summary ───────────────────────────

console.log('');
console.log('═'.repeat(60));
console.log(
  `Matched: ${matched}  ·  Injected: ${injected}  ·  Updated: ${updated}  ·  Skipped: ${skipped}`
);
console.log(
  `With coords (label found): ${withCoords}  ·  Without coords: ${withoutCoords}`
);

// Which entries in capitals.json were never used?
const unused = [...capitalsLookup.keys()].filter((k) => !usedCapitals.has(k));
if (unused.length) {
  console.log(`\n⚠ Capitals with no matching map file (${unused.length}):`);
  for (const k of unused) console.log(`   - ${k}`);
}

if (!WRITE) {
  console.log('\nℹ Dry run only. Re-run with --write to apply changes.');
}