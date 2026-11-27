// Client for the on-disk preset store (dev-server middleware, see server/presets.js)
const HDR = { 'X-FW-Export': '1', 'content-type': 'application/json' };
async function call(url, method = 'GET', body) {
  const r = await fetch(url, { method, headers: HDR, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
  return j;
}
export const listPresets = (kind, onNotice) => call(`/__presets/${kind}`).then((j) => { if (j.notice) onNotice?.(j.notice); return j.presets; });
// overwrite: true replaces an existing preset of that name (Update); without it the server answers 409 for an existing name
export const savePreset = (kind, name, payload, overwrite = false) => call(`/__presets/${kind}`, 'POST', kind === 'cameras' ? { name, preset: payload, overwrite } : { name, data: payload, overwrite });
export const sameName = (a, b) => a.normalize('NFKC').toLowerCase() === b.normalize('NFKC').toLowerCase();
export const deletePreset = (kind, name) => call(`/__presets/${kind}/delete`, 'POST', { name });
