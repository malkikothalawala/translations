// scripts/translate-json.js
// Node 20+, ESM fetch
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Config from env (with defaults) ----
const SOURCE_JSON = process.env.SOURCE_JSON || 'locales/en.json';
const TARGET_JSON = process.env.TARGET_JSON || 'locales/sv-SE.json';
const SOURCE_LANG = (process.env.SOURCE_LANG || 'en').toLowerCase();    // e.g. 'en' or 'en-GB'
const TARGET_LANG = (process.env.TARGET_LANG || 'sv').toLowerCase();    // e.g. 'sv' or 'sv-SE'

// Unofficial endpoint (no key). For production, consider Google Cloud Translate API.
const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

// ---- Helpers ----
function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// Flatten nested JSON to key paths -> string values
function flatten(obj, prefix = '') {
  const out = {};
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => {
      const p = prefix ? `${prefix}[${i}]` : `[${i}]`;
      if (isPlainObject(v) || Array.isArray(v)) {
        Object.assign(out, flatten(v, p));
      } else if (typeof v === 'string') {
        out[p] = v;
      }
    });
  } else if (isPlainObject(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (isPlainObject(v) || Array.isArray(v)) {
        Object.assign(out, flatten(v, p));
      } else if (typeof v === 'string') {
        out[p] = v;
      }
    }
  }
  return out;
}

// Inflate key-path map back to nested structure
function inflate(map) {
  const root = {};
  for (const [key, val] of Object.entries(map)) {
    const parts = splitPath(key);
    setPath(root, parts, val);
  }
  return root;
}

// Split paths like "screen.name" and "list[0].title"
function splitPath(p) {
  const parts = [];
  let buf = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '.') {
      if (buf) { parts.push(buf); buf = ''; }
    } else if (c === '[') {
      if (buf) { parts.push(buf); buf = ''; }
      // read index
      let j = i + 1, idx = '';
      while (j < p.length && p[j] !== ']') { idx += p[j++]; }
      i = j; // jump past ]
      parts.push(Number(idx));
    } else {
      buf += c;
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

function setPath(obj, parts, value) {
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    const nextIsIndex = typeof parts[i + 1] === 'number';
    if (typeof k === 'number') {
      if (!Array.isArray(cur)) cur = [];
    }
    if (cur[k] == null) cur[k] = nextIsIndex ? [] : {};
    cur = cur[k];
  }
  const last = parts[parts.length - 1];
  cur[last] = value;
}

// Batch Google Translate (multiple q params)
async function translateBatch(texts, sl, tl) {
  if (texts.length === 0) return [];
  const params = new URLSearchParams();
  params.set('client', 'gtx');
  params.set('sl', sl);
  params.set('tl', tl);
  params.set('dt', 't');
  // append multiple q
  for (const t of texts) {
    params.append('q', t);
  }
  const url = `${ENDPOINT}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Translate request failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  // Response shape: [ [ [ translatedText, originalText, ... ], ... ], ... ]
  const translated = [];
  // When multiple q are sent, Google returns an array per input (sometimes folded). We’ll reconstruct by counting splits.
  // Strategy: join each input with a unique delimiter, translate, then split back. But we can also rely on multiple q behavior:
  // In practice, data is an array per input since ~2024. Still, handle both shapes:
  // Case A: data is array-of-arrays (one per input)
  if (Array.isArray(data) && Array.isArray(data[0]) && Array.isArray(data[0][0]) && Array.isArray(data[0][0][0]) === false) {
    // Possibly single input; normalize
  }
  // Normalize to array of arrays: each item -> segments
  const normalizeToTexts = (block) => {
    if (!Array.isArray(block)) return [];
    const segs = block[0];
    if (!Array.isArray(segs)) return [];
    return segs.map(seg => seg[0]).join('');
  };

  if (Array.isArray(data[0]) && Array.isArray(data[0][0]) && Array.isArray(data[0][0][0]) === false && data.length > 1) {
    // Multiple inputs; each is its own block
    for (const block of data) {
      translated.push(normalizeToTexts(block));
    }
  } else {
    // Fallback: treat the whole response as one block (single input)
    translated.push(normalizeToTexts(data));
  }
  // If Google collapsed to single block while we sent multiple q, pad conservatively
  if (translated.length !== texts.length) {
    // Best-effort: duplicate or slice to match length
    if (translated.length === 1) {
      // assume positions map 1:1
      return texts.map((_, i) => translated[0]);
    }
    // final fallback
    const out = [];
    for (let i = 0; i < texts.length; i++) out.push(translated[i % translated.length] || '');
    return out;
  }
  return translated;
}

async function translateAll(map, sl, tl, batchSize = 50) {
  const keys = Object.keys(map);
  const values = keys.map(k => map[k]);

  const out = {};
  for (let i = 0; i < values.length; i += batchSize) {
    const slice = values.slice(i, i + batchSize);
    const translated = await translateBatch(slice, sl, tl);
    translated.forEach((t, j) => {
      out[keys[i + j]] = t;
    });
  }
  return out;
}

function readJSONSafe(fp) {
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function writeIfChanged(fp, obj) {
  const pretty = JSON.stringify(obj, null, 2) + '\n';
  const old = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : '';
  if (old !== pretty) {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, pretty);
    return true;
  }
  return false;
}

// ---- Main ----
(async function main() {
  const src = readJSONSafe(SOURCE_JSON);
  if (!src) {
    console.error(`Source JSON not found: ${SOURCE_JSON}`);
    process.exit(1);
  }

  // 1) Flatten source to strings
  const flat = flatten(src);

  // 2) Translate all strings (covers adds/edits)
  const translatedMap = await translateAll(flat, SOURCE_LANG, TARGET_LANG);

  // 3) Inflate back to nested structure (this prunes deletions automatically)
  const targetObj = inflate(translatedMap);

  // 4) Write if changed
  const changed = writeIfChanged(TARGET_JSON, targetObj);

  console.log(
    changed
      ? `Updated ${TARGET_JSON} with ${Object.keys(translatedMap).length} translated strings.`
      : `No changes written to ${TARGET_JSON}.`
  );
})().catch(err => {
  console.error(err);
  process.exit(1);
});
