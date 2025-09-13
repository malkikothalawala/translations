// scripts/translate-json.js
// Node 18+ ESM. No deps. Single-call-per-string.
// Only translates keys whose English value is new or changed vs last run.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Config (env) ----
const SOURCE_JSON = process.env.SOURCE_JSON || 'locales/en.json';
const TARGET_JSON = process.env.TARGET_JSON || 'locales/sv-SE.json';
const SOURCE_LANG = (process.env.SOURCE_LANG || 'en').toLowerCase();  // e.g. en or en-gb
const TARGET_LANG = (process.env.TARGET_LANG || 'sv').toLowerCase();  // e.g. sv or sv-se
const STRIP_SURROUNDING_QUOTES = (process.env.STRIP_QUOTES || 'true') === 'true';

// Where to store "path -> last English text" cache (per target lang)
const CACHE_FILE =
  process.env.I18N_CACHE ||
  path.join(path.dirname(TARGET_JSON), `.i18n-cache.${TARGET_LANG}.json`);

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

function writePretty(fp, obj) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2) + '\n');
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

// ---- Translate (single call per string) ----
async function withRetries(fn, { retries = 3, minDelayMs = 400 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.status;
      const msg = String(err?.message || '');
      const retryable =
        status ? [429, 500, 502, 503, 504].includes(status)
               : /ECONNRESET|ETIMEDOUT|network|fetch/i.test(msg);
      if (!retryable || i === retries) break;
      const wait = minDelayMs * Math.pow(2, i);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function translateOne(text, sl, tl) {
  const params = new URLSearchParams();
  params.set('client', 'gtx');
  params.set('sl', sl);
  params.set('tl', tl);
  params.set('dt', 't');
  params.set('q', text);

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

  // Shape: [ [ [ translatedText, originalText, ... ], ... ], ... ]
  const segs = Array.isArray(data?.[0]) ? data[0] : null;
  if (!Array.isArray(segs)) return text; // fallback to English if weird

  const translated = segs
    .filter(Array.isArray)
    .map(s => s?.[0] ?? '')
    .join('');

  // Safety: if empty, keep English
  return translated && translated.trim() !== '' ? translated : text;
}

function sanitizeSourceString(s) {
  return STRIP_SURROUNDING_QUOTES ? s.replace(/^['"]+|['"]+$/g, '') : s;
}

// ---- Main: only translate changed/added strings ----
(async function main() {
  const srcObj = readJSONSafe(SOURCE_JSON);
  if (!srcObj) {
    console.error(`Source JSON not found: ${SOURCE_JSON}`);
    process.exit(1);
  }

  const flatEn = flatten(srcObj);
  if (Object.keys(flatEn).length === 0) {
    console.log('No string leaves found in source JSON. Nothing to translate.');
    process.exit(0);
  }

  const prevTargetObj = readJSONSafe(TARGET_JSON) || {};
  const flatPrevTarget = flatten(prevTargetObj); // may be empty on first run

  const cache = readJSONSafe(CACHE_FILE) || {}; // path -> last English string we translated

  const outMap = {};
  let translatedCount = 0;
  let reusedCount = 0;

  for (const [pathKey, enValRaw] of Object.entries(flatEn)) {
    const enVal = sanitizeSourceString(enValRaw);
    const lastEn = cache[pathKey];
    const prevTranslated = flatPrevTarget[pathKey];

    if (lastEn === enVal && typeof prevTranslated === 'string' && prevTranslated.trim() !== '') {
      // English unchanged since last translation ⇒ reuse
      outMap[pathKey] = prevTranslated;
      reusedCount++;
      continue;
    }

    // New key or English changed ⇒ translate once
    const svVal = await translateOne(enVal, SOURCE_LANG, TARGET_LANG);
    outMap[pathKey] = svVal;
    cache[pathKey] = enVal;
    translatedCount++;
  }

  // Rebuild nested target and write files
  const targetObj = inflate(outMap);
  const changed = writeIfChanged(TARGET_JSON, targetObj);
  writePretty(CACHE_FILE, cache);

  console.log(
    `Done. Translated: ${translatedCount}, Reused: ${reusedCount}, ` +
    (changed ? `wrote ${TARGET_JSON}.` : `no changes to ${TARGET_JSON}.`)
  );
})().catch(err => {
  console.error(err);
  process.exit(1);
});
