// scripts/translate-json.js
// Node 18+ (uses built-in fetch). Robust against odd Google responses.
// Translates all string leaves from SOURCE_JSON to TARGET_JSON,
// preserving structure and pruning deleted keys.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Config (env-driven) ----
const SOURCE_JSON = process.env.SOURCE_JSON || 'locales/en.json';
const TARGET_JSON = process.env.TARGET_JSON || 'locales/sv-SE.json';
const SOURCE_LANG = (process.env.SOURCE_LANG || 'en').toLowerCase(); // e.g., 'en' or 'en-gb'
const TARGET_LANG = (process.env.TARGET_LANG || 'sv').toLowerCase(); // e.g., 'sv' or 'sv-se'

// Optional: trim surrounding quotes in source strings (helpful if your data has stray " or ').
const STRIP_SURROUNDING_QUOTES = (process.env.STRIP_QUOTES || 'true') === 'true';

// Unofficial endpoint (no key). For production, prefer Google Cloud Translate API.
const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

// ---- JSON helpers ----
const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

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

function splitPath(p) {
  const parts = [];
  let buf = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '.') {
      if (buf) { parts.push(buf); buf = ''; }
    } else if (c === '[') {
      if (buf) { parts.push(buf); buf = ''; }
      let j = i + 1, idx = '';
      while (j < p.length && p[j] !== ']') idx += p[j++];
      i = j;
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
    if (cur[k] == null) cur[k] = nextIsIndex ? [] : {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

function inflate(map) {
  const root = {};
  for (const [key, val] of Object.entries(map)) {
    setPath(root, splitPath(key), val);
  }
  return root;
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

// ---- Translation helpers ----

// Unique delimiter to chunk results deterministically
const DELIM = '⟦§§__CUT_HERE__§§⟧';

// Retry with exponential backoff for transient HTTP errors/rate limits
async function withRetries(fn, { retries = 4, minDelayMs = 500 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Only back off on network/5xx/429 errors; otherwise, rethrow immediately
      const msg = String(err?.message || '');
      const shouldRetry =
        /ECONNRESET|ETIMEDOUT|502|503|504|429/.test(msg) || (err.status && [429, 500, 502, 503, 504].includes(err.status));
      if (!shouldRetry || i === retries) break;
      const wait = minDelayMs * Math.pow(2, i);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// Safer: translate one big joined string, then split back by markers
async function translateBatchViaJoin(texts, sl, tl) {
  if (!texts.length) return [];

  // Mark each input so we can reconstruct 1:1 even if Google mutates array shape.
  const joined = texts.map((t, i) => `${DELIM}${i}${DELIM}${t}`).join('');

  const params = new URLSearchParams();
  params.set('client', 'gtx');
  params.set('sl', sl);
  params.set('tl', tl);
  params.set('dt', 't');
  params.set('q', joined);

  const url = `${ENDPOINT}?${params.toString()}`;

  const data = await withRetries(async () => {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const error = new Error(`Translate failed (${res.status}): ${body.slice(0, 200)}`);
      error.status = res.status;
      throw error;
    }
    return res.json();
  });

  // data looks like: [ [ [ translatedText, originalText, ... ], ... ], ... ]
  const segs = Array.isArray(data?.[0]) ? data[0] : [];
  const translatedJoined = segs
    .filter(Array.isArray) // skip nulls
    .map(s => (Array.isArray(s) ? (s[0] ?? '') : ''))
    .join('');

  // Re-split to per-input outputs
  const parts = translatedJoined.split(DELIM).slice(1); // drop leading empty
  const out = new Array(texts.length).fill('');
  for (let i = 0; i < parts.length; i += 2) {
    const idx = Number(parts[i]);
    const chunk = parts[i + 1] ?? '';
    if (!Number.isNaN(idx) && idx >= 0 && idx < out.length) out[idx] += chunk;
  }
  return out;
}

function sanitizeSourceString(s) {
  if (STRIP_SURROUNDING_QUOTES) {
    return s.replace(/^['"]+|['"]+$/g, '');
  }
  return s;
}

async function translateAll(map, sl, tl, batchSize = 40) {
  const keys = Object.keys(map);
  const values = keys.map(k => sanitizeSourceString(map[k]));

  const out = {};
  for (let i = 0; i < values.length; i += batchSize) {
    const slice = values.slice(i, i + batchSize);
    const translated = await translateBatchViaJoin(slice, sl, tl);
    translated.forEach((t, j) => {
      out[keys[i + j]] = t;
    });
  }
  return out;
}

// ---- Main ----
(async function main() {
  const src = readJSONSafe(SOURCE_JSON);
  if (!src) {
    console.error(`Source JSON not found: ${SOURCE_JSON}`);
    process.exit(1);
  }

  const flat = flatten(src);

  // Translate
  const translatedMap = await translateAll(flat, SOURCE_LANG, TARGET_LANG);

  // Rebuild nested structure; this also prunes deleted keys automatically
  const targetObj = inflate(translatedMap);

  // Write if changed
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
