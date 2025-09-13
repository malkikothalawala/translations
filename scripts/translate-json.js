// scripts/translate-json.js
// Node 18+ ESM, no deps. Single-call-per-string.
// Only translates keys whose English value changed since last run.

import fs from 'node:fs';
import path from 'node:path';

// ---------- Config ----------
const SOURCE_JSON = process.env.SOURCE_JSON || 'locales/en.json';
const TARGET_JSON = process.env.TARGET_JSON || 'locales/sv-SE.json';
const SOURCE_LANG = (process.env.SOURCE_LANG || 'en').toLowerCase();
const TARGET_LANG = (process.env.TARGET_LANG || 'sv').toLowerCase();
const STRIP_QUOTES = (process.env.STRIP_QUOTES || 'true') === 'true';
const CACHE_FILE = process.env.I18N_CACHE
  || path.join(path.dirname(TARGET_JSON), `.i18n-cache.${TARGET_LANG}.json`);
const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

// ---------- Small utils ----------
const readJSON = fp => (fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')) : null);
const writeJSON = (fp, obj) => {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2) + '\n');
};
const writeIfChanged = (fp, obj) => {
  const next = JSON.stringify(obj, null, 2) + '\n';
  const prev = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : '';
  if (prev !== next) { writeJSON(fp, obj); return true; }
  return false;
};

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

// Flatten using dot paths and `[i]` for arrays
function flatten(x, base = '', out = {}) {
  if (Array.isArray(x)) {
    x.forEach((v, i) => {
      const p = base ? `${base}[${i}]` : `[${i}]`;
      isObj(v) || Array.isArray(v) ? flatten(v, p, out) : (typeof v === 'string' && (out[p] = v));
    });
  } else if (isObj(x)) {
    for (const [k, v] of Object.entries(x)) {
      const p = base ? `${base}.${k}` : k;
      isObj(v) || Array.isArray(v) ? flatten(v, p, out) : (typeof v === 'string' && (out[p] = v));
    }
  }
  return out;
}

// Parse "a.b[0].c" → ["a","b",0,"c"]
function splitPath(p) {
  const tokens = [];
  const re = /(?:\.?([^[.]+))|(?:\[(\d+)\])/g;
  let m;
  while ((m = re.exec(p))) {
    if (m[1]) tokens.push(m[1]);
    else if (m[2]) tokens.push(Number(m[2]));
  }
  return tokens;
}
function setPath(obj, parts, val) {
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i], nextIsIdx = typeof parts[i + 1] === 'number';
    if (cur[k] == null) cur[k] = nextIsIdx ? [] : {};
    cur = cur[k];
  }
  cur[parts.at(-1)] = val;
}
function inflate(map) {
  const root = {};
  for (const [k, v] of Object.entries(map)) setPath(root, splitPath(k), v);
  return root;
}

// ---------- HTTP / translate ----------
async function withRetries(fn, retries = 3, baseDelay = 400) {
  let err;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      err = e;
      const s = e?.status, msg = String(e?.message || '');
      const retryable = s ? [429,500,502,503,504].includes(s) : /ECONNRESET|ETIMEDOUT|network|fetch/i.test(msg);
      if (!retryable || i === retries) break;
      await new Promise(r => setTimeout(r, baseDelay * 2 ** i));
    }
  }
  throw err;
}

async function translateOne(text, sl, tl) {
  const qs = new URLSearchParams({ client: 'gtx', sl, tl, dt: 't', q: text });
  const url = `${ENDPOINT}?${qs.toString()}`;

  const data = await withRetries(async () => {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const e = new Error(`Translate ${res.status}: ${body.slice(0,200)}`);
      e.status = res.status; throw e;
    }
    return res.json();
  });

  const segs = Array.isArray(data?.[0]) ? data[0] : null;
  if (!Array.isArray(segs)) return text;
  const out = segs.filter(Array.isArray).map(s => s?.[0] ?? '').join('');
  return out.trim() ? out : text; // fallback to English if empty
}

const clean = s => (STRIP_QUOTES ? s.replace(/^['"]+|['"]+$/g, '') : s);

// ---------- Main ----------
(async () => {
  const src = readJSON(SOURCE_JSON);
  if (!src) { console.error(`Missing ${SOURCE_JSON}`); process.exit(1); }

  const flatEn = flatten(src);
  if (!Object.keys(flatEn).length) { console.log('No string leaves to translate.'); process.exit(0); }

  const prevTarget = flatten(readJSON(TARGET_JSON) || {});
  const cache = readJSON(CACHE_FILE) || {}; // path -> last EN string

  const out = {};
  let translated = 0, reused = 0;

  for (const [pathKey, enRaw] of Object.entries(flatEn)) {
    const en = clean(enRaw);
    const lastEn = cache[pathKey];
    const prev = prevTarget[pathKey];

    if (lastEn === en && typeof prev === 'string' && prev.trim()) {
      out[pathKey] = prev; reused++; continue;
    }
    out[pathKey] = await translateOne(en, SOURCE_LANG, TARGET_LANG);
    cache[pathKey] = en; translated++;
  }

  const targetObj = inflate(out);
  const changed = writeIfChanged(TARGET_JSON, targetObj);
  writeJSON(CACHE_FILE, cache);

  console.log(`Translated: ${translated}, Reused: ${reused}, ${changed ? 'updated' : 'no change to'} ${TARGET_JSON}`);
})().catch(e => { console.error(e); process.exit(1); });
