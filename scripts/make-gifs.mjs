// Makes the short README demo GIFs (docs/gifs/*.gif) by driving the real app in headless Chrome and encoding page screenshots with ffmpeg.
// Only the page is captured (no OS windows, no terminal), so no file paths or machine details end up in the pictures. Run: npm run gifs
import puppeteer from 'puppeteer-core';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..'), OUT = path.join(ROOT, 'docs', 'gifs');
const FFMPEG = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });
const isFree = (port) => new Promise((ok) => { const c = net.connect(port, '127.0.0.1'); c.on('connect', () => { c.destroy(); ok(false); }); c.on('error', () => ok(true)); });
let PORT = 0; for (const c of [5371, 5372, 5373, 5374]) { if (await isFree(c)) { PORT = c; break; } }
const URL_ = `http://127.0.0.1:${PORT}/`;
const sv = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js')], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, FW_PORT: String(PORT), FW_PRESETS_DIR: path.join(os.tmpdir(), 'pyb-gif-presets') } });
process.on('exit', () => sv.kill());
for (let i = 0; i < 60; i++) { try { if ((await fetch(URL_)).ok) break; } catch { /* wait */ } await sleep(500); }

const W = 1500, H = 900;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H });
await page.goto(URL_); await page.waitForFunction(() => window.__fw?.app.history, { timeout: 20000 });
// show the mouse pointer in the pictures
await page.evaluate(() => {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;width:16px;height:16px;border-radius:50%;background:rgba(255,255,255,.85);border:2px solid #ee4f48;pointer-events:none;z-index:99999;left:-50px;top:-50px;transform:translate(-50%,-50%)';
  document.body.append(d); document.addEventListener('mousemove', (e) => { d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; }, true);
});
await page.evaluate(() => { const a = window.__fw.app; a.state.loop = true; a.updateGui?.(); });
const box = (sel, n = 0) => page.evaluate((s, n) => { const r = document.querySelectorAll(s)[n].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, l: r.left, w: r.width }; }, sel, n);

async function record(name, fps, script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyb-frames-'));
  let n = 0, run = true; const t0 = Date.now();
  const loop = (async () => { while (run) { await page.screenshot({ path: path.join(dir, `f${String(n++).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 80 }); } })();
  await script(); run = false; await loop;
  const real = n / ((Date.now() - t0) / 1000);
  const gif = path.join(OUT, name + '.gif');
  const vf = `scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`;
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', '-framerate', String(Math.min(fps, real)), '-i', path.join(dir, 'f%05d.jpg'), '-vf', vf, '-loop', '0', gif], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(r.status === 0 ? 'OK' : 'FAIL', name, n, 'frames', (fs.statSync(gif).size / 1e6).toFixed(2), 'MB', r.stderr || '');
}
const drag = async (from, to, steps = 18, ms = 25) => { await page.mouse.move(from.x, from.y); await page.mouse.down(); for (let i = 1; i <= steps; i++) { await page.mouse.move(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps); await sleep(ms); } await page.mouse.up(); };

// 1. Dials
await page.evaluate(() => { window.__fw.setCamera({ view: 'Default' }); window.__fw.fire(); });
await record('dials', 10, async () => {
  const gr = await box('.pyb-dial', 0), wx = await box('.pyb-dial', 1);
  await sleep(1500);
  await drag(gr, { x: gr.x, y: gr.y + 55 });          // less gravity
  await sleep(1200);
  await drag(wx, { x: wx.x, y: wx.y - 70 }, 22);      // wind to the right
  await sleep(1500);
  await page.mouse.click(gr.x, gr.y, { count: 2 }); await page.mouse.click(wx.x, wx.y, { count: 2 });   // double-click resets
  await sleep(1000);
});
await page.evaluate(() => { const p = window.__fw.app.state.physics; p.gravity = 1; p.windX = 0; window.__fw.app.updateDeck(); window.__fw.app.updateGui(); });

// 2. Scrub bar + layer timeline
await page.evaluate(() => { window.__fw.fire(); });
await page.keyboard.press('KeyT'); await sleep(400);
await record('timeline', 10, async () => {
  const s = await box('.pyb-bar input[type=range]');
  await sleep(1000);
  await drag({ x: s.l + s.w * 0.08, y: s.y }, { x: s.l + s.w * 0.5, y: s.y }, 24);
  await sleep(500);
  await drag({ x: s.l + s.w * 0.5, y: s.y }, { x: s.l + s.w * 0.12, y: s.y }, 24);
  await sleep(500);
  const bar = await page.evaluate(() => { const r = document.querySelectorAll('.pyb-tl-bar')[1].getBoundingClientRect(); return { x: r.x + 6, y: r.y + r.height / 2 }; });
  await drag(bar, { x: bar.x + 150, y: bar.y }, 20);   // move layer 2 later
  await sleep(2500);
});
await page.keyboard.press('KeyT');

// 3. Gallery
await record('gallery', 8, async () => {
  await sleep(600);
  await page.keyboard.press('KeyG'); await sleep(3500);
  await page.type('.pyb-gal-head input', 'palm', { delay: 150 }); await sleep(1200);
  const c = await box('.pyb-card'); await page.mouse.move(c.x, c.y, { steps: 10 }); await sleep(500); await page.mouse.click(c.x, c.y);
  await sleep(3500);
});

// 4. Undo and A/B compare
await page.evaluate(() => { const a = window.__fw.app; a.state.physics.gravity = 1; a.state.physics.windX = 0; a.updateDeck(); a.updateGui(); a.fire(); });
await sleep(800);
await record('undo-compare', 10, async () => {
  const gr = await box('.pyb-dial', 0), wx = await box('.pyb-dial', 1);
  await sleep(800);
  await page.keyboard.press('KeyB'); await sleep(700);
  await drag(wx, { x: wx.x, y: wx.y - 80 }, 20); await sleep(900);
  await page.keyboard.press('KeyX'); await sleep(1200);
  await page.keyboard.press('KeyX'); await sleep(1200);
  await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control'); await sleep(1500);
});

// 5. Title safe and action safe
await page.evaluate(() => { const fw = window.__fw, a = fw.app; a.state.camera.keys = []; a.state.camera.baked = null; a.state.camera.view = 'free'; a.camAnim.rebuild(); fw.setCamera({ view: 'Default' }); fw.loadShot({ preset: 'Red peony + gold willow' }); a.state.loop = true; });
await sleep(800);
await record('safe-areas', 8, async () => {
  await sleep(3200); await page.keyboard.press('KeyV'); await sleep(1800); await page.keyboard.press('KeyV'); await sleep(1800);
});

// 6. Camera animation: key the camera on frame 0, look through the Camera view, move to a later frame, orbit (auto-key sets the key), then play it
await page.evaluate(() => { const fw = window.__fw, a = fw.app; a.state.camera.keys = []; a.state.camera.baked = null; a.state.camera.view = 'free'; a.camAnim.rebuild(); fw.setCamera({ view: 'Default' }); fw.loadShot({ preset: 'Red peony + gold willow' }); });
await sleep(600);
await record('camera-animation', 10, async () => {
  await page.keyboard.press('KeyT'); await sleep(700);
  await page.evaluate(() => window.__fw.seek(0)); await sleep(300);
  await page.keyboard.press('KeyK'); await sleep(900);                         // key 1, frame 0
  await page.keyboard.press('Digit2'); await sleep(500);                      // look through the shot camera
  await page.evaluate(() => window.__fw.seek(6)); await sleep(700);
  await drag({ x: 420, y: 260 }, { x: 250, y: 200 }, 22, 30); await sleep(1100);   // orbit: auto-key sets key 2
  await page.evaluate(() => window.__fw.seek(3)); await sleep(1000);          // in between: the camera is in the middle of its move
  await page.keyboard.press('KeyT'); await page.keyboard.press('Home'); await sleep(400);
  await page.evaluate(() => { document.querySelector('.pyb-dock').style.display = 'none'; window.__fw.app.playing = true; });
  await sleep(6500);
  await page.evaluate(() => { document.querySelector('.pyb-dock').style.display = ''; });
});

await browser.close(); sv.kill();
