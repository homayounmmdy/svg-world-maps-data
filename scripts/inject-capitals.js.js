#!/usr/bin/env node
/**
 * inject-capitals.js
 *
 * Reads capitals.json and, for each entry, finds the matching map file
 * by filename (or by the map's internal `name:` field as a fallback),
 * then injects/updates a `capitals` property in that map object.
 *
 * Transactional behaviour (per entry):
 *   ✅ map found + every capital matched a label  → write map, remove entry from capitals.json
 *   ❌ filename wrong OR capital not in labels    → leave map untouched, keep entry in capitals.json
 *
 * `capitals` is ALWAYS written as an array of { name, x, y } objects so
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

const capitalsRawSource = fs.readFileSync(CAPITALS_FILE, 'utf8');

let capitalsRaw;
try {
  capitalsRaw = JSON.parse(capitalsRawSource);
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
 */
function normalizeCapitals(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .map((v) => (typeof v === 'string' ? v.trim() : String(v).trim()))
    .filter(Boolean);
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
 */
function findCapitalLabel(labels, capitalName) {
  if (!capitalName) return null;
  const target = String(capitalName).trim().toLowerCase();

  let hit = labels.find((l) => l.name.trim().toLowerCase() === target);
  if (hit) return hit;

  hit = labels.find((l) => {
    const n = l.name.trim().toLowerCase();
    return n.includes(target) || target.includes(n);
  });
  return hit || null;
}

/**
 * Format the capitals value as a TS array literal of { name, x, y } objects.
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

// Detect the indentation used by the source JSON so we can rewrite it nicely
function detectJsonIndent(src) {
  const m = src.match(/^(\s+)"/m);
  return m ? m[1].length : 2;
}

// ──────────────────────────── Main ─────────────────────────────

if (!fs.existsSync(MAPS_DIR)) {
  console.error(`✖ Maps folder not found: ${MAPS_DIR}`);
  process.exit(1);
}

// Index every .ts file once so lookups are O(1)
const allFiles = walk(MAPS_DIR);
const fileByBase = new Map(); // lowercase base name → full path
for (const f of allFiles) {
  const base = stripExt(path.basename(f)).toLowerCase();
  if (!fileByBase.has(base)) fileByBase.set(base, f);
}

console.log('');
console.log(`📁 Maps     : ${MAPS_DIR}`);
console.log(`📄 Capitals : ${CAPITALS_FILE}  (${capitalsRaw.length} entr${capitalsRaw.length === 1 ? 'y' : 'ies'})`);
console.log(`🔧 Mode     : ${WRITE ? 'WRITE (changes will be saved)' : 'DRY RUN (no files touched)'}`);
console.log(`   Indexed ${allFiles.length} .ts file(s)\n`);

if (capitalsRaw.length === 0) {
  console.log('Nothing to do.');
  process.exit(0);
}

// Regexes (anchored per-line, multiline)
const RE_EXISTING_CAPITALS =
  /^([ \t]*)capitals\s*:\s*(?:\[[\s\S]*?\]|["'`][^"'`]*["'`])\s*,?[ \t]*$/m;
const RE_CODE = /^([ \t]*)code\s*:\s*["'`][^"'`]*["'`]\s*,?[ \t]*$/m;
const RE_NAME = /^([ \t]*)name\s*:\s*["'`][^"'`]*["'`]\s*,?[ \t]*$/m;
const RE_STATES = /^([ \t]*)states\s*:/m;
const RE_NAME_VALUE = /\bname\s*:\s*["'`]([^"'`]+)["'`]/;

// ── Tracking ───────────────────────────────────────────────────
let processed = 0;   // entries that reached a map file
let injected = 0;    // brand-new capitals property added
let updated = 0;     // existing capitals property replaced
let alreadyOk = 0;   // map already matched the desired output

// Entries that could NOT be safely applied → they stay in capitals.json
const keptEntries = [];
// Reason strings keyed by entry filename, for the summary
const keptReasons = new Map();

// Entries that WERE safely applied → to be removed from capitals.json
const removedEntries = [];

function keepEntry(entry, reason) {
  keptEntries.push(entry);
  keptReasons.set(entry && entry.filename, reason);
}

for (const entry of capitalsRaw) {
  // ── Validate the entry itself ──────────────────────────────
  if (!entry || typeof entry.filename !== 'string') {
    console.log(`✖ Invalid entry (missing "filename")`);
    keepEntry(entry, 'invalid entry (missing "filename")');
    continue;
  }

  const filename = entry.filename;
  const capitalNames = normalizeCapitals(entry.capitals);

  if (capitalNames.length === 0) {
    console.log(`✖ ${filename}  → no capitals listed`);
    keepEntry(entry, 'no capitals listed');
    continue;
  }

  // ── Find the map file ──────────────────────────────────────
  let file = fileByBase.get(filename.toLowerCase());
  let matchedBy = 'filename';

  // Fallback: search by internal `name:` field
  if (!file) {
    for (const f of allFiles) {
      const src = fs.readFileSync(f, 'utf8');
      const m = src.match(RE_NAME_VALUE);
      if (m && m[1].toLowerCase() === filename.toLowerCase()) {
        file = f;
        matchedBy = 'name';
        break;
      }
    }
  }

  if (!file) {
    console.log(`✖ ${filename}  → map file not found (kept in capitals.json)`);
    keepEntry(entry, 'map file not found');
    continue;
  }

  const rel = path.relative(MAPS_DIR, file);
  const code = fs.readFileSync(file, 'utf8');

  // ── Resolve every capital against the labels array ─────────
  //    If ANY capital cannot be matched, we abort this entry entirely
  //    and leave the map file untouched.
  const labels = extractLabels(code);
  const resolved = [];
  const missing = [];

  for (const name of capitalNames) {
    const label = findCapitalLabel(labels, name);
    if (label) {
      resolved.push({ name, x: label.x, y: label.y });
    } else {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    for (const name of missing) {
      console.log(
        `✖ ${rel}: capital "${name}" not found in labels (${labels.length} label(s) scanned) — map untouched, kept in capitals.json`
      );
    }
    keepEntry(entry, `label not found for: ${missing.join(', ')}`);
    continue;
  }

  // Detect indent from existing code/name line, default 4 spaces
  const indentMatch = code.match(/^([ \t]*)(?:code|name)\s*:/m);
  const indent = indentMatch ? indentMatch[1] : '    ';

  // ── Decide the new file contents ───────────────────────────
  let newCode = null;
  let action = null;

  if (RE_EXISTING_CAPITALS.test(code)) {
    newCode = code.replace(
      RE_EXISTING_CAPITALS,
      (_m, ind) => `${ind}capitals: ${formatCapitalsArray(resolved, ind)},`
    );
    action = 'updated';
  } else if (RE_CODE.test(code)) {
    newCode = code.replace(
      RE_CODE,
      (_m, ind) => `${_m}\n${ind}capitals: ${formatCapitalsArray(resolved, ind)},`
    );
    action = 'injected';
  } else if (RE_NAME.test(code)) {
    newCode = code.replace(
      RE_NAME,
      (_m, ind) => `${_m}\n${ind}capitals: ${formatCapitalsArray(resolved, ind)},`
    );
    action = 'injected';
  } else if (RE_STATES.test(code)) {
    newCode = code.replace(
      RE_STATES,
      (_m, ind) => `${ind}capitals: ${formatCapitalsArray(resolved, ind)},\n${_m}`
    );
    action = 'injected';
  }

  // No safe insertion point → abort, keep entry
  if (!newCode || newCode === code) {
    if (action === 'updated' && newCode === code) {
      // The replacement was a no-op → the file already matched the desired output.
      alreadyOk++;
      console.log(`= ${rel}  [${matchedBy}] → already up to date`);
      removedEntries.push(entry);
      continue;
    }
    console.log(`✖ ${rel}  → no safe insertion point (map untouched, kept in capitals.json)`);
    keepEntry(entry, 'no safe insertion point');
    continue;
  }

  // ── All green: write the map, and mark entry for removal ───
  processed++;
  if (action === 'injected') injected++;
  else if (action === 'updated') updated++;

  const verb = action === 'injected' ? '+' : '↻';
  console.log(`${verb} ${rel}  [${matchedBy}] → capitals ${action} (${resolved.length})`);

  if (WRITE) fs.writeFileSync(file, newCode, 'utf8');
  removedEntries.push(entry);
}

// ─────────────────── Rewrite capitals.json ─────────────────────

let jsonRewritten = false;

if (WRITE && removedEntries.length > 0) {
  const indent = detectJsonIndent(capitalsRawSource);
  const newJson =
    keptEntries.length === 0
      ? '[]\n'
      : JSON.stringify(keptEntries, null, indent) + '\n';
  fs.writeFileSync(CAPITALS_FILE, newJson, 'utf8');
  jsonRewritten = true;
}

// ─────────────────────────── Summary ───────────────────────────

console.log('');
console.log('═'.repeat(60));
console.log(`Entries in capitals.json : ${capitalsRaw.length}`);
console.log(`Successfully applied     : ${removedEntries.length}`);
console.log(`  + injected             : ${injected}`);
console.log(`  ↻ updated              : ${updated}`);
console.log(`  = already up to date   : ${alreadyOk}`);
console.log(`Kept in capitals.json    : ${keptEntries.length}`);

if (keptEntries.length) {
  console.log('\n🔒 KEPT (will be retried next run)');
  console.log('─'.repeat(60));
  for (const e of keptEntries) {
    const reason = keptReasons.get(e && e.filename) || 'unknown';
    console.log(`  ${e && e.filename}  ·  ${reason}`);
  }
}

if (WRITE) {
  if (jsonRewritten) {
    console.log(`\n📝 capitals.json rewritten — ${keptEntries.length} entr${keptEntries.length === 1 ? 'y' : 'ies'} remain.`);
  } else {
    console.log('\n📝 capitals.json not modified (nothing to remove).');
  }
} else {
  console.log('\nℹ Dry run only. Re-run with --write to apply changes.');
}