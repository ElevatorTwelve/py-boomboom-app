// Saved presets on disk: presets/cameras.json (all camera presets) and presets/finales/<name>.json (one file per finale).
// Writes are atomic (temp file + rename); names are sanitised; bodies are size-limited; a preset file that cannot be parsed is
// moved aside (never overwritten) and the user is told. FW_PRESETS_DIR overrides the folder (used by the verification run).
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.FW_PRESETS_DIR ? path.resolve(process.env.FW_PRESETS_DIR) : path.resolve(import.meta.dirname, '..', 'presets');
const FINALES = path.join(ROOT, 'finales'), CAMERAS = path.join(ROOT, 'cameras.json');
const MAX_BODY = 2 * 1024 * 1024, MAX_NAME = 60;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

// Letters and digits of any script are kept (so non-ASCII names stay distinct); everything else unsafe becomes '_'.
// Returns null for names that are empty, too long, hidden (leading dot) or made only of replacement characters.
export function safeName(n) {
  const raw = String(n ?? '').normalize('NFKC').replace(/[^\p{L}\p{N} _.()+-]/gu, '_').replace(/\s+/g, ' ').trim().replace(/^[.\s]+/, '');
  if (!raw || raw.length > MAX_NAME || /^[_ ]+$/.test(raw) || RESERVED.has(raw)) return null;
  return raw;
}
const key = (n) => n.normalize('NFKC').toLowerCase();   // names that differ only in case are the same preset (case-insensitive file systems)

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Read a JSON file; a file that exists but is unreadable / not an object is renamed to <file>.bad-<timestamp> and reported
function readStrict(file) {
  if (!fs.existsSync(file)) return { data: null, notice: null };
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (d && typeof d === 'object' && !Array.isArray(d)) return { data: d, notice: null };
  } catch { /* falls through to the backup */ }
  const bad = `${file}.bad-${Date.now()}`;
  fs.renameSync(file, bad);
  return { data: null, notice: `${path.basename(file)} could not be read; it was kept as ${path.basename(bad)} and a fresh file is used.` };
}

const cleanMap = (o) => { const m = Object.create(null); if (o && typeof o === 'object') for (const k of Object.keys(o)) if (safeName(k) === k) m[k] = o[k]; return m; };

function readBodyLimited(req) {
  return new Promise((ok, fail) => {
    const b = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { fail(new Error('body too large')); req.destroy(); } else b.push(c); });
    req.on('end', () => ok(Buffer.concat(b).toString()));
    req.on('error', fail);
  });
}

const finite3 = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
const validCamera = (p) => p && typeof p === 'object' && finite3(p.position) && Number.isFinite(p.focal) && p.focal > 0 && p.focal <= 2000
  && (p.target === undefined || finite3(p.target)) && (p.quaternion === undefined || (Array.isArray(p.quaternion) && p.quaternion.length === 4 && p.quaternion.every(Number.isFinite)));
const validFinale = (d) => d && typeof d === 'object' && Array.isArray(d.layers) && d.layers.length > 0 && d.layers.length <= 64 && d.finale && typeof d.finale === 'object';

// route: 'cameras' | 'finales' (+ optional '/delete'); returns [status, body]
export async function handlePresets(req, route) {
  const m = /^\/(cameras|finales)(\/delete)?$/.exec(route);
  if (!m) return [404, { error: 'unknown route' }];
  const kind = m[1], del = !!m[2];
  if (req.method === 'GET' && !del) {
    if (kind === 'cameras') { const r = readStrict(CAMERAS); return [200, { presets: cleanMap(r.data?.presets), notice: r.notice }]; }
    const out = Object.create(null); let notice = null;
    if (fs.existsSync(FINALES)) for (const f of fs.readdirSync(FINALES)) {
      if (!f.endsWith('.json')) continue;
      const name = f.slice(0, -5), r = readStrict(path.join(FINALES, f));
      if (r.notice) notice = r.notice;
      if (safeName(name) === name && validFinale(r.data?.data)) out[name] = r.data.data;
    }
    return [200, { presets: out, notice }];
  }
  if (req.method !== 'POST') return [405, { error: 'method not allowed' }];
  let body; try { body = JSON.parse(await readBodyLimited(req)); } catch (e) { return [400, { error: 'bad request body: ' + e.message }]; }
  if (!body || typeof body !== 'object') return [400, { error: 'bad request body' }];
  const name = safeName(body.name);
  if (!name) return [400, { error: `invalid preset name (1-${MAX_NAME} characters, not hidden, not only symbols)` }];
  if (kind === 'cameras') {
    const r = readStrict(CAMERAS), presets = cleanMap(r.data?.presets);
    const existing = Object.keys(presets).find((k) => key(k) === key(name));
    if (del) { if (!existing) return [404, { error: 'no such preset' }]; delete presets[existing]; }
    else {
      if (!validCamera(body.preset)) return [400, { error: 'invalid camera preset' }];
      if (existing && !body.overwrite) return [409, { error: `a camera preset named "${existing}" already exists`, existing }];
      presets[existing || name] = body.preset;   // an overwrite keeps the existing preset's spelling
    }
    atomicWrite(CAMERAS, JSON.stringify({ version: 1, presets }, null, 2) + '\n');
    return [200, { ok: true, name, notice: r.notice }];
  }
  const names = fs.existsSync(FINALES) ? fs.readdirSync(FINALES).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : [];
  const existing = names.find((k) => key(k) === key(name));
  if (del) { if (!existing) return [404, { error: 'no such preset' }]; fs.unlinkSync(path.join(FINALES, existing + '.json')); return [200, { ok: true, name: existing }]; }
  if (!validFinale(body.data)) return [400, { error: 'invalid finale preset' }];
  if (existing && !body.overwrite) return [409, { error: `a finale preset named "${existing}" already exists`, existing }];
  const file = path.join(FINALES, (existing || name) + '.json');
  const r = readStrict(file);   // an unreadable old file is kept aside before it is replaced
  atomicWrite(file, JSON.stringify({ version: 1, name: existing || name, data: body.data }, null, 2) + '\n');
  return [200, { ok: true, name: existing || name, notice: r.notice }];
}
