// Makes the pre-rendered rollover loops of the preset gallery. Run: npm run loops   (ONLY=Red%20peony limits it to some presets, comma separated)
// Output: public/preset-loops/<slug>.mp4 (short loop), <slug>.jpg (poster) and index.json. Nothing is rendered live for these presets in the gallery.
import puppeteer from 'puppeteer-core';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..'), OUT = path.join(ROOT, 'public', 'preset-loops');
const FFMPEG = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = 320, H = 180, FPS = 12, ONLY = process.env.ONLY ? process.env.ONLY.split(',').map(decodeURIComponent) : null;
export const slug = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isFree = (port) => new Promise((ok) => { const c = net.connect(port, '127.0.0.1'); c.on('connect', () => { c.destroy(); ok(false); }); c.on('error', () => ok(true)); });
let PORT = 0; for (const c of [5401, 5402, 5403, 5404]) { if (await isFree(c)) { PORT = c; break; } }
const URL_ = `http://127.0.0.1:${PORT}/`;
fs.mkdirSync(OUT, { recursive: true });
const sv = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js')], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, FW_PORT: String(PORT), FW_PRESETS_DIR: path.join(os.tmpdir(), 'pyb-loop-presets') } });
process.on('exit', () => sv.kill());
for (let i = 0; i < 60; i++) { try { if ((await fetch(URL_)).ok) break; } catch { /* wait */ } await sleep(500); }
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 720 });
await page.goto(URL_); await page.waitForFunction(() => window.__fw?.finalePresets, { timeout: 20000 });
const combos = await page.evaluate(() => window.__fw.presets()), finales = await page.evaluate(() => window.__fw.finalePresets());
const jobs = [...combos.map((name) => ({ name, kind: 'combo' })), ...finales.map((name) => ({ name, kind: 'finale' }))].filter((j) => !ONLY || ONLY.includes(j.name));
const index = fs.existsSync(path.join(OUT, 'index.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'index.json'), 'utf8')) : { width: W, height: H, presets: [] };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pyb-loop-')), stage = path.join(tmp, '_out');   // files go to public/ only at the end: the dev server reloads the page when public/ changes
fs.mkdirSync(stage);
for (const j of jobs) {
  const t0 = await page.evaluate((j) => {
    const fw = window.__fw; fw.setCamera({ view: 'Wide' });
    if (j.kind === 'finale') fw.loadFinalePreset(j.name); else fw.loadShot({ preset: j.name });
    const a = fw.app; a.fire(); while (a.world.burstLog.length === 0 && !a.world.finished && a.world.t < 60) a.world.step();
    return a.world.burstLog[0] ? a.world.burstLog[0].t : 0;
  }, j);
  const start = Math.max(0, t0 - 0.4), dur = j.kind === 'finale' ? 5.5 : 3.6, n = Math.round(dur * FPS);
  const dir = path.join(tmp, slug(j.name)); fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    const d = await page.evaluate((t) => { window.__fw.stepTo(t); return window.__fw.grab({ width: 320, height: 180, samples: 2 }).dataUrl; }, start + i / FPS);
    fs.writeFileSync(path.join(dir, `f${String(i).padStart(4, '0')}.png`), Buffer.from(d.split(',')[1], 'base64'));
  }
  const mp4 = path.join(stage, slug(j.name) + '.mp4'), jpg = path.join(stage, slug(j.name) + '.jpg');
  const r1 = spawnSync(FFMPEG, ['-y', '-v', 'error', '-framerate', String(FPS), '-i', path.join(dir, 'f%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', '-preset', 'slow', '-movflags', '+faststart', '-an', mp4], { encoding: 'utf8' });
  const poster = Math.min(n - 1, Math.round((t0 + 1.1 - start) * FPS));
  const r2 = spawnSync(FFMPEG, ['-y', '-v', 'error', '-i', path.join(dir, `f${String(poster).padStart(4, '0')}.png`), '-q:v', '3', jpg], { encoding: 'utf8' });
  const ok = r1.status === 0 && r2.status === 0;
  console.log(ok ? 'OK' : 'FAIL', j.name, `${n} frames`, (fs.statSync(mp4).size / 1e3).toFixed(0) + ' KB', r1.stderr || r2.stderr || '');
  index.presets = index.presets.filter((p) => p.name !== j.name); index.presets.push({ name: j.name, slug: slug(j.name), kind: j.kind });
}
await browser.close(); sv.kill();
for (const f of fs.readdirSync(stage)) fs.copyFileSync(path.join(stage, f), path.join(OUT, f));
index.presets.sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
fs.rmSync(tmp, { recursive: true, force: true });
