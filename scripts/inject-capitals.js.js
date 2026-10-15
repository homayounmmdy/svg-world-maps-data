#!/usr/bin/env node
/**
 * inject-capitals.js
 *
 * Reads capitals.json, scans the maps folder, matches each map by filename
 * (or its `name:` field as a fallback), then injects/updates a `capitals`
 * property in the map object.
 *
 * `capitals` is ALWAYS written as an array of { name, x, y } objects so that
 * countries with multiple capitals (e.g. South Africa) work naturally.
 *
 * capitals.json accepts either form per entry:
 *   { "filename": "GERMANY",        "capitals": "Berlin" }
 *   { "filename": "SOUTH_AFRICA",   "capitals": ["Pretoria", "Cape Town", "Bloemfontein"] }
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

/**
 * Normalize a capitals entry into an array of non-empty strings.
 *   "Berlin"                          → ["Berlin"]
 *   ["Pretoria","Cape Town"]          → ["Pretoria","Cape Town"]
 */
function normalizeCapitals(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .map((v) => (typeof v === 'string' ? v.trim() : String(v).trim()))
    .filter(Boolean);
}

// lowercase filename → [capitalName, ...]
const capitalsLookup = new Map();
for (const entry of capitalsRaw) {
  if (!entry || typeof entry.filename !== 'string') continue;
  const list = normalizeCapitals(entry.capitals);
  capitalsLookup.set(entry.filename.toLowerCase(), list);
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

/**
 * Format the capitals value as a TS array literal of { name, x, y } objects.
 * `resolved` is [{ name, x, y }] (x/y may be null if no label found).
 */
function formatCapitalsArray(resolved, indent) {
  if (resolved.length === 0) return '[]';

  const inner = indent + '    ';
  const lines = resolved.map((c) => {
    const parts = [`name: ${JSON.stringify(c.name)}`];
    if (c.x != null) parts.push(`x: ${JSON.stringify(c.x)}`);
    if (c.y != null) parts.push(`y: ${JSON.stringify(c.y)}`);
    return `${inner}{ ${parts.join(', ')} }`;
  });

  return `[\n${lines.join(',\n')}\n${indent}]`;
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
// Matches an existing capitals value that is either a string OR an array literal.
const RE_EXISTING_CAPITALS =
  /^([ \t]*)capitals\s*:\s*(?:\[[\s\S]*?\]|["'`][^"'`]*["'`])\s*,?[ \t]*$/m;
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
  let capitalNames = capitalsLookup.get(base.toLowerCase());
  let matchedBy = 'filename';

  // 2) Fallback: match by internal `name:` value
  if (capitalNames === undefined) {
    const m = code.match(RE_NAME_VALUE);
    if (m) {
      const byName = capitalsLookup.get(m[1].toLowerCase());
      if (byName !== undefined) {
        capitalNames = byName;
        matchedBy = 'name';
      }
    }
  }

  if (capitalNames === undefined) {
    console.log(`· ${rel}  → no capital match`);
    skipped++;
    continue;
  }

  matched++;
  for (const c of capitalNames) usedCapitals.add(c.toLowerCase());

  // ── Look up x/y for each capital from the labels array ─────
  const labels = extractLabels(code);
  const resolved = capitalNames.map((name) => {
    const label = findCapitalLabel(labels, name);
    if (label) {
      withCoords++;
      return { name, x: label.x, y: label.y };
    }
    withoutCoords++;
    if (labels.length) {
      console.log(
        `   ⚠ ${rel}: label for "${name}" not found among ${labels.length} label(s)`
      );
    } else {
      console.log(`   ⚠ ${rel}: no labels array found for "${name}"`);
    }
    return { name, x: null, y: null };
  });

  // Detect indent by looking at existing code/name line, default 4 spaces
  const indentMatch = code.match(/^([ \t]*)(?:code|name)\s*:/m);
  const indent = indentMatch ? indentMatch[1] : '    ';

  const quoted = formatCapitalsArray(resolved, indent);

  // Case A: capitals already exists → replace value
  if (RE_EXISTING_CAPITALS.test(code)) {
    const newCode = code.replace(
      RE_EXISTING_CAPITALS,
      (_m, ind) => `${ind}capitals: ${formatCapitalsArray(resolved, ind)},`
    );
    if (newCode !== code) {
      updated++;
      console.log(`↻ ${rel}  [${matchedBy}] → capitals updated (${capitalNames.length})`);
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
      (_m, ind) => `${_m}\n${ind}capitals: ${formatCapitalsArray(resolved, ind)},`
    );
  } else if (RE_NAME.test(code)) {
    newCode = code.replace(
      RE_NAME,
      (_m, ind) => `${_m}\n${ind}capitals: ${formatCapitalsArray(resolved, ind)},`
    );
  } else if (RE_STATES.test(code)) {
    newCode = code.replace(
      RE_STATES,
      (_m, ind) => `${ind}capitals: ${formatCapitalsArray(resolved, ind)},\n${_m}`
    );
  }

  if (!newCode || newCode === code) {
    console.log(`⚠ ${rel}  matched but no safe insertion point`);
    skipped++;
    continue;
  }

  injected++;
  console.log(`+ ${rel}  [${matchedBy}] → capitals injected (${capitalNames.length})`);
  if (WRITE) fs.writeFileSync(file, newCode, 'utf8');
}

// ─────────────────────────── Summary ───────────────────────────

console.log('');
console.log('═'.repeat(60));
console.log(
  `Matched: ${matched}  ·  Injected: ${injected}  ·  Updated: ${updated}  ·  Skipped: ${skipped}`
);
console.log(
  `Capitals resolved with coords: ${withCoords}  ·  Without coords: ${withoutCoords}`
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