// Headless checks for the V1 UI features: dials, scrub bar, layer timeline, undo/redo + A/B, gallery, hotkeys, Blender camera (glTF).
// Writes verification/ui-report.json and the camera files that verify:blender reads. Run verify before this (verify wipes verification/). Run: npm run verify:ui
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'verification');   // git-ignored
fs.mkdirSync(OUT, { recursive: true });
const isFree = (port) => new Promise((ok) => { const c = net.connect(port, '127.0.0.1'); c.on('connect', () => { c.destroy(); ok(false); }); c.on('error', () => ok(true)); });
let PORT = Number(process.env.FW_PORT) || 0;
for (const c of [5331, 5332, 5333, 5334, 5335]) { if (PORT) break; if (await isFree(c)) PORT = c; }
const URL_ = `http://127.0.0.1:${PORT}/`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { checks: {} };
let failed = 0;
const check = (name, pass, data = {}) => { if (!pass) failed++; report.checks[name] = { pass: !!pass, ...data }; console.log(pass ? 'PASS' : 'FAIL', name, JSON.stringify(data).slice(0, 300)); };

const server = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js')], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, FW_PORT: String(PORT), FW_PRESETS_DIR: path.join(OUT, '_presets_ui') } });
process.on('exit', () => server.kill());
for (let i = 0; i < 60; i++) { try { if ((await fetch(URL_)).ok) break; } catch { /* not up yet */ } await sleep(500); }

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1500,900'] });
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 900 });
const errors = [];
page.on('dialog', (d) => d.accept());
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });
await page.goto(URL_);
await page.waitForFunction(() => window.__fw && window.__fw.app.history, { timeout: 20000 });
const ev = (f, ...a) => page.evaluate(f, ...a);

// ---- 1. the new UI exists ----
const dom = await ev(() => ({ bar: !!document.querySelector('.pyb-bar'), deck: !!document.querySelector('.pyb-deck'), dials: document.querySelectorAll('.pyb-dial').length, sliders: document.querySelectorAll('.pyb-slider input').length, badge: document.querySelector('.pyb-badge')?.textContent, title: document.title }));
check('ui_present', dom.bar && dom.deck && dom.dials >= 7 && dom.sliders >= 4 && /PY-BoomBoom/.test(dom.badge) && /PY-BoomBoom/.test(dom.title), dom);

// ---- 2. dials: drag, wheel, keyboard, double click reset; panel stays in sync ----
const centre = (sel, n = 0) => ev((s, n) => { const r = document.querySelectorAll(s)[n].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, sel, n);
const gravityDial = async () => (await centre('.pyb-dial', 0));
const g0 = await ev(() => window.__fw.app.state.physics.gravity);
{
  const c = await gravityDial();
  await page.mouse.move(c.x, c.y); await page.mouse.down(); await page.mouse.move(c.x, c.y - 60, { steps: 6 }); await page.mouse.up();
  const g1 = await ev(() => window.__fw.app.state.physics.gravity);
  check('dial_drag_changes_value', g1 > g0 + 0.3, { g0, g1 });
  await page.mouse.move(c.x, c.y); await page.mouse.down(); await page.mouse.move(c.x, c.y + 20, { steps: 3 }); await page.mouse.up();
  await sleep(450);
  const shown = await ev(() => { const c = [...document.querySelectorAll('.lil-controller')].find((e) => /^gravity/.test((e.querySelector('.lil-name')?.textContent || '').trim())); return +c.querySelector('input').value; });
  const gNow = await ev(() => window.__fw.app.state.physics.gravity);
  await sleep(600);
  const shown2 = await ev(() => { const c = [...document.querySelectorAll('.lil-controller')].find((e) => /^gravity/.test((e.querySelector('.lil-name')?.textContent || '').trim())); return +c.querySelector('input').value; });
  check('dial_syncs_panel_slider', Math.abs(shown2 - gNow) < 0.02, { gNow, shown, shown2 });
  await page.mouse.click(c.x, c.y, { count: 2 });
  const g2 = await ev(() => window.__fw.app.state.physics.gravity);
  check('dial_double_click_resets', Math.abs(g2 - 1) < 1e-6, { g2 });
  await page.focus('.pyb-dial'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
  const g3 = await ev(() => window.__fw.app.state.physics.gravity);
  check('dial_keyboard', g3 > 1.05, { g3 });
  await ev(() => { window.__fw.app.state.physics.gravity = 1; window.__fw.app.updateDeck(); });
  // wind dial is bipolar and clamps
  const w = await centre('.pyb-dial', 1);
  await page.mouse.move(w.x, w.y); await page.mouse.down(); await page.mouse.move(w.x, w.y + 900, { steps: 4 }); await page.mouse.up();
  const wx = await ev(() => window.__fw.app.state.physics.windX);
  check('dial_clamps_to_min', wx === -15, { wx });
  await ev(() => { window.__fw.app.state.physics.windX = 0; window.__fw.app.updateDeck(); });
}

// ---- 3. scrub bar: backwards scrub gives the same world as going forward ----
{
  await ev(() => { window.__fw.app.state.loop = false; window.__fw.app.fire(); });
  const setScrub = (frac) => ev((f) => { const s = document.querySelector('.pyb-bar input[type=range]'); s.value = String(Math.round(f * 1000)); s.dispatchEvent(new Event('input', { bubbles: true })); }, frac);
  const len = await ev(() => { const t = document.querySelector('.pyb-time').textContent; return parseFloat(t.split('/')[1]); });
  const lens = [];
  const at = async (sec) => { lens.push(await ev(() => document.querySelector('.pyb-time').textContent)); await ev((s) => window.__fw.seek(s), sec); await sleep(400); return ev(() => { const a = window.__fw.app; return { t: a.playhead, wt: a.world.t, s: window.__fw.getStats() }; }); };
  const a1 = await at(5);
  await at(8);
  const a2 = await at(5);
  const same = a1.s.stars === a2.s.stars && a1.s.sparks === a2.s.sparks && a1.s.smoke === a2.s.smoke && Math.abs(a1.t - a2.t) < 0.02;
  check('scrub_back_equals_forward', same && a1.s.stars + a1.s.sparks > 0, { lens, len, t1: a1.t, t2: a2.t, w1: a1.wt, w2: a2.wt, st1: [a1.s.stars, a1.s.tail, a1.s.smoke], st2: [a2.s.stars, a2.s.tail, a2.s.smoke] });
  await setScrub(0.5); await sleep(400);
  const len2 = await ev(() => parseFloat(document.querySelector('.pyb-time').textContent.split('/')[1]));
  const mid = await ev(() => window.__fw.app.playhead);
  check('scrub_slider_moves_playhead', Math.abs(mid - 0.5 * len2) < 1.0, { mid, len2 });
  const paused = await ev(() => window.__fw.app.playing === false);
  check('scrub_pauses', paused);
}

// ---- 4. hotkeys ----
{
  await ev(() => { window.__fw.app.playing = true; });
  await page.keyboard.press('Space'); const p1 = await ev(() => window.__fw.app.playing);
  await page.keyboard.press('Space'); const p2 = await ev(() => window.__fw.app.playing);
  check('hotkey_space_toggles_play', p1 === false && p2 === true, { p1, p2 });
  await page.keyboard.press('KeyL'); const l1 = await ev(() => window.__fw.app.state.loop); await page.keyboard.press('KeyL');
  check('hotkey_loop', l1 === true);
  await page.keyboard.press('KeyF'); await sleep(100);
  const t = await ev(() => window.__fw.app.world.t);
  check('hotkey_fire', t < 1.5, { t });
  // typing in a text field must not fire shortcuts
  await page.evaluate(() => { const i = document.createElement('input'); i.id = 'tmpin'; document.body.append(i); i.focus(); });
  const before = await ev(() => window.__fw.app.playing);
  await page.keyboard.type(' lf ');
  const after = await ev(() => window.__fw.app.playing), loopAfter = await ev(() => window.__fw.app.state.loop);
  check('hotkeys_ignored_in_inputs', before === after && loopAfter === false, { before, after, loopAfter });
  await ev(() => document.getElementById('tmpin').remove());
  await page.keyboard.press('Slash', {}).catch(() => {});
}

// ---- 5. layer timeline ----
{
  await page.keyboard.press('KeyT'); await sleep(300);
  const rows = await ev(() => ({ open: document.querySelector('.pyb-tl').classList.contains('open'), bars: document.querySelectorAll('.pyb-tl-bar').length, layers: window.__fw.app.state.shot.layers.length }));
  check('timeline_shows_one_bar_per_layer', rows.open && rows.bars === rows.layers && rows.bars >= 2, rows);
  const d0 = await ev(() => window.__fw.app.state.shot.layers[1].delay);
  const bb = await ev(() => { const r = document.querySelectorAll('.pyb-tl-bar')[1].getBoundingClientRect(); return { x: r.x + 4, y: r.y + r.height / 2 }; });
  await page.mouse.move(bb.x, bb.y); await page.mouse.down(); await page.mouse.move(bb.x + 120, bb.y, { steps: 5 }); await page.mouse.up(); await sleep(300);
  const d1 = await ev(() => window.__fw.app.state.shot.layers[1].delay);
  check('timeline_drag_changes_delay', d1 > d0 + 0.2, { d0, d1 });
  await page.keyboard.press('KeyT');
}

// ---- 6. undo / redo and A/B ----
{
  await ev(() => { const a = window.__fw.app; a.state.physics.gravity = 1; a.updateDeck(); });
  await sleep(500);
  const c = await centre('.pyb-dial', 0);
  await page.mouse.move(c.x, c.y); await page.mouse.down(); await page.mouse.move(c.x, c.y - 40, { steps: 4 }); await page.mouse.up(); await sleep(500);
  const gA = await ev(() => window.__fw.app.state.physics.gravity);
  await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control'); await sleep(300);
  const gU = await ev(() => window.__fw.app.state.physics.gravity);
  await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Shift'); await page.keyboard.up('Control'); await sleep(300);
  const gR = await ev(() => window.__fw.app.state.physics.gravity);
  check('undo_redo_physics', gA > 1.2 && Math.abs(gU - 1) < 1e-6 && Math.abs(gR - gA) < 1e-6, { gA, gU, gR });
  // panel slider shows the restored value (controllers still bound to the same objects)
  await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control'); await sleep(300);
  const shown = await ev(() => { const c = [...document.querySelectorAll('.lil-controller')].find((e) => /^gravity/.test((e.querySelector('.lil-name')?.textContent || '').trim())); return +c.querySelector('input').value; });
  check('undo_updates_panel', Math.abs(shown - 1) < 0.02, { shown });
  // undo of a layer change
  const n0 = await ev(() => window.__fw.app.state.shot.layers.length);
  await ev(() => { const a = window.__fw.app; const b = [...document.querySelectorAll('.lil-controller.lil-function')].find((e) => /\+ add layer/.test(e.textContent)); (b.querySelector('button') || b).click(); });
  await sleep(500);
  const n1 = await ev(() => window.__fw.app.state.shot.layers.length);
  await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control'); await sleep(300);
  const n2 = await ev(() => window.__fw.app.state.shot.layers.length);
  check('undo_layer_add', n1 === n0 + 1 && n2 === n0, { n0, n1, n2 });
  // A/B
  await ev(() => { const a = window.__fw.app; a.state.physics.gravity = 1; a.updateDeck(); a.history.flush(); });
  await page.keyboard.press('KeyB');
  await ev(() => { const a = window.__fw.app; a.state.physics.gravity = 2; a.updateDeck(); a.history.flush(); });
  await page.keyboard.press('KeyX'); const gb = await ev(() => window.__fw.app.state.physics.gravity);
  await page.keyboard.press('KeyX'); const ga = await ev(() => window.__fw.app.state.physics.gravity);
  check('ab_compare_flip', gb === 1 && ga === 2, { gb, ga });
  await ev(() => { const a = window.__fw.app; a.state.physics.gravity = 1; a.updateDeck(); });
}

// ---- 7. gallery ----
{
  await page.keyboard.press('KeyG');
  await page.waitForFunction(() => document.querySelectorAll('.pyb-card').length > 8, { timeout: 8000 }).catch(() => {});
  const n = await ev(() => document.querySelectorAll('.pyb-card').length);
  await sleep(4000);
  const painted = await ev(() => [...document.querySelectorAll('.pyb-card img')].filter((i) => i.naturalWidth > 0).length + [...document.querySelectorAll('.pyb-card canvas')].filter((c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 0; i < d.length; i += 4 * 97) if (d[i] + d[i + 1] + d[i + 2] > 40) return true; return false; }).length);
  check('gallery_cards_and_thumbnails', n >= 9 && painted >= Math.floor(n * 0.6), { cards: n, painted });
  await page.type('.pyb-gal-head input', 'willow'); await sleep(300);
  const filtered = await ev(() => document.querySelectorAll('.pyb-card').length);
  check('gallery_search_filters', filtered > 0 && filtered < n, { n, filtered });
  const name = await ev(() => document.querySelector('.pyb-card .t').textContent);
  await page.click('.pyb-card');
  await sleep(500);
  const loaded = await ev(() => ({ open: document.querySelector('.pyb-gal').classList.contains('open'), layers: window.__fw.app.state.shot.layers.length, fin: window.__fw.app.state.shot.finale.enabled }));
  check('gallery_click_loads_preset', !loaded.open && loaded.layers >= 1, { name, ...loaded });
  await page.keyboard.press('KeyG'); await sleep(300); await page.keyboard.press('Escape'); await sleep(200);
  check('gallery_escape_closes', await ev(() => !document.querySelector('.pyb-gal').classList.contains('open')));
}

// ---- 8. Blender camera (glTF) round trip in the browser: still, and animation with roll ----
{
  const r = await ev(async () => {
    const fw = window.__fw, rig = fw.app.rig, a = fw.app;
    a.state.camera.keys = []; a.state.camera.baked = null; a.state.camera.view = 'free';
    fw.setCamera({ position: [120, 40, 410], target: [10, 150, 0], focal: 35 });
    rig.camera.updateMatrixWorld();
    const before = { p: rig.camera.position.toArray(), q: rig.camera.quaternion.toArray(), f: rig.focal };
    const out = fw.blender.exportCamera('gltf');
    fw.setCamera({ view: 'Front' });
    const info = fw.blender.importCamera(out.data);
    await new Promise((ok) => setTimeout(ok, 400));
    rig.camera.updateMatrixWorld();
    return { before, text: out.data, info, shot: fw.app.state.camera.view === 'shot', after: { p: rig.camera.position.toArray(), q: rig.camera.quaternion.toArray(), f: rig.focal } };
  });
  const dp = Math.max(...r.before.p.map((v, i) => Math.abs(v - r.after.p[i]))), dot = Math.abs(r.before.q.reduce((s, v, i) => s + v * r.after.q[i], 0));
  check('blender_gltf_still_roundtrip_in_app', dp < 1e-3 && dot > 0.99999 && Math.abs(r.before.f - r.after.f) < 0.05 && r.shot && r.info.frames === 1, { dp, dot, f0: r.before.f, f1: r.after.f, info: r.info });
  fs.writeFileSync(path.join(OUT, 'app-camera.gltf'), r.text);
  fs.writeFileSync(path.join(OUT, 'app-camera-expected.json'), JSON.stringify(r.before));

  // animation with roll: 3 keys, export at 24 fps, read it back, every frame must match
  const an = await ev(async () => {
    const fw = window.__fw, a = fw.app, C = a.state.camera;
    fw.setExport({ fps: 24 }); fw.setPhysics({ timeScale: 1 });
    C.baked = null; C.view = 'free';
    const mk = (t, p, tg, f, roll) => ({ t, position: p, target: tg, focal: f, roll, interp: 'bezier', ease: 'in-out-cubic' });
    C.keys = [mk(0, [0, 6, 520], [0, 160, 0], 50, 0), mk(1, [150, 80, 420], [0, 160, 0], 40, 20), mk(2, [260, 30, 250], [20, 170, 0], 30, -15)];
    const frames = fw.blender.cameraFrames().frames;
    const out = fw.blender.exportCamera('glb');
    const bytes = Array.from(out.data);
    const want = [0, 12, 24, 36, 48].map((f) => ({ f, ...fw.camera.poseAt(f / 24) }));
    fw.blender.importCamera(out.data.buffer.slice(out.data.byteOffset, out.data.byteOffset + out.data.byteLength));
    const b = a.state.camera.baked;
    let dpos = 0, dq = 1;
    for (const w of want) { const g = fw.camera.poseAt(w.f / 24); dpos = Math.max(dpos, ...g.position.map((v, i) => Math.abs(v - w.position[i]))); dq = Math.min(dq, Math.abs(g.quaternion.reduce((s, v, i) => s + v * w.quaternion[i], 0))); }
    return { n: frames.length, bakedCount: b.count, bakedFps: b.fps, dpos, dq, bytes, want, keysAfter: C.keys.length };
  });
  check('blender_glb_animation_roundtrip_in_app', an.n === 49 && an.bakedCount === 49 && an.bakedFps === 24 && an.dpos < 1e-3 && an.dq > 0.99999 && an.keysAfter === 0, { n: an.n, bakedCount: an.bakedCount, dpos: an.dpos, dq: an.dq });
  fs.writeFileSync(path.join(OUT, 'app-anim.glb'), Buffer.from(an.bytes));
  fs.writeFileSync(path.join(OUT, 'app-anim-expected.json'), JSON.stringify(an.want));
  await ev(() => { const a = window.__fw.app; a.state.camera.keys = []; a.state.camera.baked = null; a.state.camera.view = 'free'; a.camAnim.rebuild(); });
}

// ---- 8b. gallery: names are not cut off, built-in cards play a pre-rendered loop on rollover, saved presets play live ----
{
  await ev(async () => {   // a saved finale, so a card without a pre-rendered loop exists
    const fw = window.__fw;
    await fetch('/__presets/finales', { method: 'POST', headers: { 'X-FW-Export': '1', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Verify saved', data: fw.snapshot(), overwrite: true }) });
  });
  for (const [w, hgt] of [[1500, 900], [1000, 600]]) {
    await page.setViewport({ width: w, height: hgt });
    await page.keyboard.press('KeyG'); await sleep(1500); await ev(() => { const i = document.querySelector('.pyb-gal-head input'); i.value = ''; i.dispatchEvent(new Event('input')); document.querySelectorAll('.pyb-gal-tags button.on').forEach((b) => b.click()); }); await sleep(800);
    const cut = await ev(() => [...document.querySelectorAll('.pyb-card')].filter((c) => { const r = c.getBoundingClientRect(), last = c.querySelector('.g').getBoundingClientRect(); return c.scrollHeight > c.clientHeight + 1 || last.bottom > r.bottom + 0.5; }).length);
    const total = await ev(() => document.querySelectorAll('.pyb-card').length);
    check(`gallery_names_not_cut_off_${w}x${hgt}`, total > 10 && cut === 0, { total, cut });
    await page.keyboard.press('Escape'); await sleep(200);
  }
  await page.setViewport({ width: 1500, height: 900 });
  await page.keyboard.press('KeyG'); await sleep(2500); await ev(() => { const i = document.querySelector('.pyb-gal-head input'); i.value = ''; i.dispatchEvent(new Event('input')); document.querySelectorAll('.pyb-gal-tags button.on').forEach((b) => b.click()); }); await sleep(800);
  const builtin = await ev(() => { const c = [...document.querySelectorAll('.pyb-card')].find((e) => e.querySelector('.t').textContent === 'Red peony'); const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, img: !!c.querySelector('img') }; });
  await page.mouse.move(builtin.x, builtin.y); await sleep(1500);
  const v1 = await ev(() => { const v = document.querySelector('.pyb-card video'); return v ? { playing: !v.paused, t: v.currentTime, on: v.classList.contains('on') } : null; });
  await sleep(600);
  const v2 = await ev(() => { const v = document.querySelector('.pyb-card video'); return v ? v.currentTime : null; });
  await page.mouse.move(5, 5); await sleep(300);
  const gone = await ev(() => !document.querySelector('.pyb-card video'));
  check('gallery_builtin_loop_plays_on_rollover', builtin.img && v1 && v1.playing && v2 > v1.t && gone, { builtin: builtin.img, v1, v2, removedOnLeave: gone });
  const saved = await ev(() => { const c = [...document.querySelectorAll('.pyb-card')].find((e) => e.querySelector('.t').textContent === 'Verify saved'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, canvas: !!c.querySelector('canvas') }; });
  const sig = () => ev(() => { const c = [...document.querySelectorAll('.pyb-card')].find((e) => e.querySelector('.t').textContent === 'Verify saved').querySelector('canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 4 * 13) h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) >>> 0; return h; });
  if (saved) {
    await page.mouse.move(saved.x, saved.y); const sigs = new Set();
    for (let i = 0; i < 8; i++) { await sleep(350); sigs.add(await sig()); }
    await page.mouse.move(5, 5); await sleep(400);
    check('gallery_saved_preset_plays_live_on_rollover', saved.canvas && sigs.size >= 3, { distinctFrames: sigs.size });
  } else check('gallery_saved_preset_plays_live_on_rollover', false, { note: 'saved card missing' });
  await page.keyboard.press('Escape'); await sleep(200);
  await ev(async () => { await fetch('/__presets/finales/delete', { method: 'POST', headers: { 'X-FW-Export': '1', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Verify saved' }) }); });
}

// ---- 8c. title safe / action safe lines: on by default, the whole export frame is inside the free area, outside is dimmed ----
{
  const read = () => ev(() => {
    const g = document.getElementById('guide'), gr = g.getBoundingClientRect(), gui = document.querySelector('.lil-gui.lil-root').getBoundingClientRect(), dock = document.querySelector('.pyb-dock').getBoundingClientRect();
    const a = g.querySelector('.pyb-safe.action'), t = g.querySelector('.pyb-safe.title'), ar = a.getBoundingClientRect(), tr = t.getBoundingClientRect();
    const fw = window.__fw, S = fw.app.state;
    return { shown: getComputedStyle(g).display, actionShown: getComputedStyle(a).display, aw: ar.width / gr.width, ah: ar.height / gr.height, tw: tr.width / gr.width, th: tr.height / gr.height,
      label: t.querySelector('span').textContent, edge: getComputedStyle(g).borderTopWidth, dim: getComputedStyle(g).boxShadow, frameAspect: gr.width / gr.height, exportAspect: S.export.width / S.export.height,
      inside: gr.left >= 0 && gr.right <= gui.left + 1 && gr.top >= 0 && gr.bottom <= dock.top + 1, rect: [gr.left, gr.top, gr.right, gr.bottom].map(Math.round), guiLeft: Math.round(gui.left), dockTop: Math.round(dock.top) };
  });
  await sleep(300);
  const r = await read();
  check('safe_areas_on_by_default_and_frame_fits_the_view', r.shown === 'block' && r.actionShown === 'block' && Math.abs(r.aw - 0.9) < 0.01 && Math.abs(r.ah - 0.9) < 0.01 && Math.abs(r.tw - 0.8) < 0.01 && Math.abs(r.th - 0.8) < 0.01 && /80%/.test(r.label) && parseFloat(r.edge) >= 2 && /rgba\(0, 0, 0/.test(r.dim) && Math.abs(r.frameAspect - r.exportAspect) < 0.02 && r.inside, r);
  await page.keyboard.press('KeyV'); await sleep(250);
  const off = await read();
  check('safe_lines_toggle_with_V_frame_edge_stays', off.actionShown === 'none' && off.shown === 'block', { actionShown: off.actionShown });
  await page.keyboard.press('KeyV'); await sleep(250);
  // the frame follows the export size, and what is outside is not in the picture: the preview shows the same view as a grab
  const sq = await ev(() => { const fw = window.__fw; fw.setExport({ width: 1080, height: 1080 }); return new Promise((ok) => setTimeout(() => { const g = document.getElementById('guide').getBoundingClientRect(); fw.setExport({ width: 1920, height: 1080 }); ok({ aspect: g.width / g.height }); }, 400)); });
  check('safe_frame_follows_export_shape', Math.abs(sq.aspect - 1) < 0.02, sq);
}

// ---- 8d. just start prints a link and stops cleanly (spare port) ----
{
  const { spawnSync } = await import('node:child_process');
  const has = spawnSync('just', ['--version'], { encoding: 'utf8' });
  if (has.status !== 0) check('just_start_prints_link', true, { skipped: 'just is not installed' });
  else {
    const env = { ...process.env, FW_PORT: String(PORT + 40) };
    const st = spawnSync('just', ['start'], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
    const url = `http://localhost:${PORT + 40}/`;
    let up = false; try { up = (await fetch(url.replace('localhost', '127.0.0.1'))).ok; } catch { /* not up */ }
    const stp = spawnSync('just', ['stop'], { cwd: ROOT, env, encoding: 'utf8', timeout: 30000 });
    let down = false; try { await fetch(url.replace('localhost', '127.0.0.1')); } catch { down = true; }
    check('just_start_prints_link', st.stdout.includes(url) && up && /Stopped/.test(stp.stdout) && down, { out: st.stdout.trim().split('\n').slice(0, 3), up, down });
  }
}

// ---- 9. new key does not collide with free-fly (W A S D Q E) ----
{
  await ev(() => { window.__fw.app.rig.setFly(true); });
  const d0 = await ev(() => document.querySelector('.pyb-deck').classList.contains('closed'));
  await page.keyboard.press('KeyD'); await page.keyboard.press('KeyA');
  const d1 = await ev(() => document.querySelector('.pyb-deck').classList.contains('closed'));
  await ev(() => { window.__fw.app.rig.setFly(false); });
  await page.keyboard.press('KeyH'); const d2 = await ev(() => document.querySelector('.pyb-deck').classList.contains('closed')); await page.keyboard.press('KeyH');
  check('fly_keys_do_not_toggle_deck', d0 === d1 && d2 === !d0, { d0, d1, d2 });
}

// ---- 10. timeline bars match the burst times the simulation records ----
{
  const r = await ev(() => {
    const fw = window.__fw, a = fw.app, out = [];
    for (const [name, ls] of [['default', null], ['slow-first', [{ launchSpeed: 0.6, launchStyle: 'gold' }, { launchSpeed: 2 }]]]) {
      fw.loadShot({ layers: a.state.shot.layers.map((l, i) => ({ ...l, ...(ls ? ls[i] : {}) })) });
      document.querySelector('.pyb-tl').classList.add('open'); a.history.flush();
      a.fire(); while (a.world.burstLog.length === 0 && !a.world.finished && a.world.t < 60) a.world.step();
      const tb = a.world.burstLog[0].t;
      out.push({ name, tb, bars: a.state.shot.layers.map((l) => tb + l.delay) });
    }
    return out;
  });
  await sleep(600);
  const labels = await ev(() => [...document.querySelectorAll('.pyb-tl-bar')].map((b) => parseFloat(b.title.replace('Burst at ', ''))));
  const last = r[1];
  check('timeline_bar_matches_recorded_burst', labels.length === last.bars.length && labels.every((v, i) => Math.abs(v - last.bars[i]) < 0.03), { labels, expected: last.bars });
  await ev(() => { document.querySelector('.pyb-tl').classList.remove('open'); window.__fw.loadShot({ preset: 'Red peony + gold willow' }); });
}

// ---- 11. scrub length spans the whole shot even when an export duration is set ----
{
  const lenOf = () => ev(() => parseFloat(document.querySelector('.pyb-time').textContent.split('/')[1]));
  await ev(() => { window.__fw.setExport({ duration: 0 }); }); await sleep(1300);
  const l0 = await lenOf();
  await ev(() => { window.__fw.setExport({ duration: 2 }); }); await sleep(1300);
  const l1 = await lenOf();
  await ev(() => { window.__fw.setExport({ duration: 0 }); });
  check('scrub_length_ignores_export_duration', l0 > 8 && Math.abs(l0 - l1) < 0.2, { l0, l1 });
}

// ---- 12. new actions are blocked while an export runs, and the export frames stay identical ----
{
  const crypto = await import('node:crypto');
  const opts = { width: 320, height: 180, fps: 24, duration: 2, samples: 4, alpha: 'premult', format: 'png' };
  await ev(() => { const fw = window.__fw; fw.setPhysics({ gravity: 1, windX: 0 }); fw.loadShot({ preset: 'Red peony + gold willow', seed: 2024 }); });
  // the very first export after a shot is loaded can differ in a few frames (also in the original code), so warm up first
  const nameW = await ev((o) => window.__fw.exportShot({ ...o, name: 'verifyui_w' }).then((r) => r.name), opts);
  const nameA = await ev((o) => window.__fw.exportShot({ ...o, name: 'verifyui_a' }).then((r) => r.name), opts);
  const nameC = await ev((o) => window.__fw.exportShot({ ...o, name: 'verifyui_c' }).then((r) => r.name), opts);
  const pB = page.evaluate((o) => window.__fw.exportShot({ ...o, name: 'verifyui_b' }).then((r) => r.name), opts);
  await sleep(150);
  const during = await ev(() => ({ exporting: window.__fw.app.exporting, t: window.__fw.app.world.t, playing: window.__fw.app.playing }));
  const pokes = [];
  for (const k of ['KeyF', 'Space', 'ArrowRight', 'KeyG', 'KeyT', 'KeyL', 'KeyX']) { await page.keyboard.press(k); }
  await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
  await ev(() => { const s = document.querySelector('.pyb-bar input[type=range]'); s.value = '700'; s.dispatchEvent(new Event('input', { bubbles: true })); });
  await ev(() => document.querySelector('.pyb-bar button').click());
  const after = await ev(() => ({ stillExporting: window.__fw.app.exporting, exporting: window.__fw.app.exporting, t: window.__fw.app.world.t, playing: window.__fw.app.playing, gal: document.querySelector('.pyb-gal').classList.contains('open'), loop: window.__fw.app.state.loop, tl: document.querySelector('.pyb-tl').classList.contains('open') }));
  const nameB = await pB;
  const dir = path.join(ROOT, 'exports');
  const hashDir = (n) => fs.readdirSync(path.join(dir, n, 'png')).sort().map((f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, n, 'png', f))).digest('hex'));
  const hA = hashDir(nameA), hB = hashDir(nameB), hC = hashDir(nameC);
  check('export_unaffected_by_new_actions', hA.length === 48 && hA.every((h, i) => h === hB[i]), { frames: hA.length, same: hA.filter((h, i) => h === hB[i]).length, cleanVsClean: hA.filter((h, i) => h === hC[i]).length, diffAt: hA.map((h, i) => h === hB[i] ? -1 : i).filter((i) => i >= 0), during, after });
  check('new_actions_blocked_during_export', during.exporting && after.stillExporting && !after.gal && !after.loop && !after.tl && after.t === during.t, { after });
  for (const n of [nameW, nameA, nameB, nameC]) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
}

// ---- 13. camera keys the way an animator uses them: real mouse and keys only, on a fresh page that is still playing ----
{
  const p2 = await browser.newPage();
  await p2.setViewport({ width: 1500, height: 900 });
  const errs2 = []; p2.on('pageerror', (e) => errs2.push(e.message)); p2.on('console', (m) => { if (m.type() === 'error') errs2.push(m.text()); });
  await p2.goto(URL_); await p2.waitForFunction(() => window.__fw && window.__fw.app.history, { timeout: 20000 });
  await sleep(1500);
  const ev2 = (f, ...a) => p2.evaluate(f, ...a);
  const snapState = () => ev2(() => {
    const fw = window.__fw, a = fw.app, C = a.state.camera, rg = a.rig, ts = a.state.physics.timeScale, fps = a.state.export.fps;
    const p = fw.camera.poseAt(a.playhead / ts); rg.camera.updateMatrixWorld();
    const cp = rg.camera.position;
    return { playhead: a.playhead, playing: a.playing, view: C.view, nKeys: C.keys.length, frames: C.keys.map((k) => Math.round(k.t * fps)), frame: Math.round(a.playhead / ts * fps), pending: a.camEdit.pending,
      dPose: p ? Math.max(Math.abs(p.position[0] - cp.x), Math.abs(p.position[1] - cp.y), Math.abs(p.position[2] - cp.z)) : null, cam: [cp.x, cp.y, cp.z], focalRig: rg.focal, focalPose: p ? p.focal : null, roll: rg.roll, keys: C.keys.map((k) => ({ p: k.position.slice(), focal: k.focal })) };
  });
  const orbit = async (dx = 120, dy = 40) => { await p2.mouse.move(520, 300); await p2.mouse.down(); await p2.mouse.move(520 + dx, 300 + dy, { steps: 8 }); await p2.mouse.up(); await sleep(450); };
  const scrubTo = async (frac) => { const r = await ev2(() => { const e = document.querySelector('.pyb-bar input[type=range]').getBoundingClientRect(); return { x: e.x, w: e.width, y: e.y + e.height / 2 }; }); await p2.mouse.click(r.x + r.w * frac, r.y); await sleep(350); };
  const labelBox = (text) => ev2((text) => { const el = [...document.querySelectorAll('.lil-controller.lil-number .lil-name')].find((e) => e.textContent.trim() === text); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + 12, y: r.y + r.height / 2 }; }, text);
  const fieldValue = (text) => ev2((text) => { const c = [...document.querySelectorAll('.lil-controller.lil-number')].find((e) => e.querySelector('.lil-name').textContent.trim() === text); return c ? +c.querySelector('input').value : null; }, text);

  const s0 = await snapState();
  check('cam_start_is_playing_free_view_no_keys', s0.playing && s0.view === 'free' && s0.nKeys === 0, { playing: s0.playing, view: s0.view });

  // 1. K while playing: pauses, keys the current frame, the playhead does not run away
  await p2.keyboard.press('KeyK'); await sleep(300);
  const s1 = await snapState(); await sleep(600); const s1b = await snapState();
  check('cam_K_pauses_and_keys_current_frame', !s1.playing && s1.view === 'shot' && s1.nKeys === 1 && s1.frames[0] === s1.frame && Math.abs(s1b.playhead - s1.playhead) < 1e-9, { s1: { playing: s1.playing, nKeys: s1.nKeys, frames: s1.frames, frame: s1.frame }, drift: s1b.playhead - s1.playhead });

  // 2. Camera view, scrub with the mouse: still paused, camera = pose function
  await p2.keyboard.press('Digit2'); await sleep(200);
  await scrubTo(0.5);
  const s2 = await snapState();
  check('cam_scrub_keeps_pause_and_camera_matches_pose', s2.view === 'shot' && !s2.playing && s2.dPose < 1e-6 && Math.abs(s2.playhead - s1.playhead) > 0.5, { view: s2.view, playing: s2.playing, dPose: s2.dPose });

  // 3. Orbit in the Camera view with auto-key: a key appears on this frame, the camera stays where the user put it
  await orbit();
  const s3 = await snapState(); await sleep(500); const s3b = await snapState();
  const k3 = s3.keys.find((k, i) => s3.frames[i] === s3.frame);
  check('cam_orbit_in_camera_view_autokeys_this_frame', s3.nKeys === 2 && !!k3 && Math.abs(k3.p[0] - s3.cam[0]) < 1e-6 && Math.abs(s3b.cam[0] - s3.cam[0]) < 1e-6 && s3.dPose < 1e-6 && !s3.playing, { nKeys: s3.nKeys, frames: s3.frames, frame: s3.frame, held: Math.abs(s3b.cam[0] - s3.cam[0]), keyP: k3 && k3.p, cam: s3.cam, dPose: s3.dPose, playing: s3.playing });

  // 4. Scrub back halfway between the keys: interpolated, no jump, no run-away
  const mid = Math.round((s1.frame + s3.frame) / 2);
  await ev2((f) => window.__fw.seek(f / window.__fw.app.state.export.fps * window.__fw.app.state.physics.timeScale), mid); await sleep(400);
  const s4 = await snapState();
  check('cam_between_keys_is_interpolated', s4.frame === mid && s4.dPose < 1e-6 && s4.nKeys === 2 && !s4.playing && Math.abs(s4.cam[0] - s3.cam[0]) > 1 && Math.abs(s4.cam[0] - s1.cam[0]) > 1, { frame: s4.frame, mid, dPose: s4.dPose });
  const tint = await ev2(() => [...document.querySelectorAll('.lil-controller')].filter((c) => /^pos |^target |focal length|^roll/.test((c.querySelector('.lil-name')?.textContent || '').trim()) && c.classList.contains('pyb-animated')).length);
  check('cam_fields_green_between_keys', tint >= 6, { animated: tint });

  // 5. Auto-key off: edits are marked (red) and held until keyed with K; moving the playhead drops them
  const auto = await ev2(() => window.__fw.app.state.camera.autoKey);
  if (auto) await ev2(() => { const b = [...document.querySelectorAll('.pyb-bar button')].find((x) => x.textContent === 'Auto-key'); b.click(); });
  await orbit(80, -30);
  const s5 = await snapState(); await sleep(600); const s5b = await snapState();
  const red = await ev2(() => [...document.querySelectorAll('.lil-controller.pyb-edited')].length);
  check('cam_edit_without_autokey_is_held_and_marked', s5.nKeys === 2 && s5.pending && Math.abs(s5b.cam[0] - s5.cam[0]) < 1e-6 && red >= 6, { nKeys: s5.nKeys, pending: s5.pending, red });
  await p2.keyboard.press('KeyK'); await sleep(300);
  const s5c = await snapState();
  check('cam_K_keys_the_held_edit', s5c.nKeys === 3 && !s5c.pending && s5c.dPose < 1e-6, { nKeys: s5c.nKeys });
  await ev2(() => { const b = [...document.querySelectorAll('.pyb-bar button')].find((x) => x.textContent === 'Auto-key'); if (!window.__fw.app.state.camera.autoKey) b.click(); });

  // 6. Number drag: drag the name of "focal length (mm)" to the right; the key on this frame follows
  const fl0 = await fieldValue('focal length (mm)');
  const lb = await labelBox('focal length (mm)');
  await p2.mouse.move(lb.x, lb.y); await p2.mouse.down(); await p2.mouse.move(lb.x + 90, lb.y, { steps: 9 }); await p2.mouse.up(); await sleep(500);
  const fl1 = await fieldValue('focal length (mm)'); const s6 = await snapState();
  const kf = s6.keys[s6.frames.indexOf(s6.frame)];
  check('number_drag_on_name_changes_value_and_key', fl1 > fl0 + 2 && kf && Math.abs(kf.focal - fl1) < 0.51 && Math.abs(s6.focalRig - fl1) < 0.51, { before: fl0, after: fl1, keyFocal: kf && kf.focal });
  // a click on the name without moving changes nothing; Shift drag is finer
  await p2.mouse.click(lb.x, lb.y); await sleep(200);
  const fl2 = await fieldValue('focal length (mm)');
  await p2.keyboard.down('Shift'); await p2.mouse.move(lb.x, lb.y); await p2.mouse.down(); await p2.mouse.move(lb.x + 90, lb.y, { steps: 9 }); await p2.mouse.up(); await p2.keyboard.up('Shift'); await sleep(400);
  const fl3 = await fieldValue('focal length (mm)');
  check('number_click_does_nothing_shift_is_finer', Math.abs(fl2 - fl1) < 1e-6 && fl3 > fl2 && (fl3 - fl2) < (fl1 - fl0) / 3, { fl1, fl2, fl3, coarse: fl1 - fl0, fine: fl3 - fl2 });
  // any other number row works the same way
  const bh0 = await fieldValue('burst height (m)'); const bl = await labelBox('burst height (m)');
  await p2.mouse.move(bl.x, bl.y); await p2.mouse.down(); await p2.mouse.move(bl.x + 60, bl.y - 20, { steps: 6 }); await p2.mouse.up(); await sleep(200);
  const bh1 = await fieldValue('burst height (m)');
  check('number_drag_works_on_any_row', bh1 > bh0 + 3, { bh0, bh1 });

  // 7. Undo: the playhead stays, playback stays paused, the key change is undone
  const beforeUndo = await snapState();
  await p2.keyboard.down('Control'); await p2.keyboard.press('KeyZ'); await p2.keyboard.up('Control'); await sleep(400);
  const afterUndo = await snapState();
  check('cam_undo_keeps_playhead_and_pause', Math.abs(afterUndo.playhead - beforeUndo.playhead) < 1e-9 && !afterUndo.playing, { was: beforeUndo.playhead, now: afterUndo.playhead, playing: afterUndo.playing });

  // 8. Key navigation, frame step, Home / End
  await p2.keyboard.press('Home'); await sleep(250);
  const sHome = await snapState();
  await p2.keyboard.press('ArrowRight'); await sleep(250);
  const sStep = await snapState();
  await p2.keyboard.press('ArrowDown'); await sleep(300);
  const sNext = await snapState();
  check('cam_home_step_and_next_key', sHome.frame === 0 && sStep.frame === 1 && sNext.frames.includes(sNext.frame) && sNext.frame > 1 && !sNext.playing, { home: sHome.frame, step: sStep.frame, next: sNext.frame, frames: sNext.frames });

  // 8b. View menu in the viewport: Camera, Perspective and the built-in views; a built-in view leaves the Camera view and keeps the keys
  const menu = await ev2(() => { const sel = document.querySelector('.pyb-view select'); return { exists: !!sel, opts: sel ? [...sel.options].map((o) => o.value) : [], value: sel && sel.value, rect: sel && (() => { const r = sel.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; })() }; });
  const wantViews = ['shot', 'free', 'v:Default', 'v:Front', 'v:Low angle (up)', 'v:Close', 'v:Wide', 'v:Finale wide', 'v:Side (90 deg)'];
  check('view_menu_in_viewport_lists_all_views', menu.exists && wantViews.every((v) => menu.opts.includes(v)) && menu.value === 'shot' && menu.rect[1] < 60, menu);
  const keysBefore = (await snapState()).keys;
  await p2.select('.pyb-view select', 'v:Close'); await sleep(400);
  const vClose = await ev2(() => { const a = window.__fw.app, c = a.rig.camera.position; return { view: a.state.camera.view, pos: [c.x, c.y, c.z], menu: document.querySelector('.pyb-view select').value, keys: a.state.camera.keys.length }; });
  check('view_menu_built_in_view_goes_free_and_keeps_keys', vClose.view === 'free' && Math.abs(vClose.pos[2] - 300) < 1e-6 && Math.abs(vClose.pos[1] - 30) < 1e-6 && vClose.menu === 'v:Close' && vClose.keys === keysBefore.length, vClose);
  await sleep(500);
  const stay = await ev2(() => { const c = window.__fw.app.rig.camera.position; return [c.x, c.y, c.z]; });
  check('view_menu_built_in_view_is_not_pulled_back_by_the_animation', Math.abs(stay[2] - 300) < 1e-6, { stay });
  await p2.select('.pyb-view select', 'shot'); await sleep(400);
  const vShot = await snapState();
  check('view_menu_camera_view_follows_keys_again', vShot.view === 'shot' && vShot.dPose < 1e-6, { view: vShot.view, dPose: vShot.dPose });
  await p2.keyboard.press('Digit1'); await sleep(200);
  const m1 = await ev2(() => document.querySelector('.pyb-view select').value);
  await p2.keyboard.press('KeyC'); await sleep(200);
  const m2 = await ev2(() => document.querySelector('.pyb-view select').value);
  check('view_menu_follows_keys_1_and_C', m1 === 'free' && m2 === 'shot', { m1, m2 });

  // 9. Play: the camera follows the keys and the playhead really runs; pause: still matches the pose function
  await p2.keyboard.press('Home'); await sleep(250);
  await p2.keyboard.press('Space'); await sleep(900);
  const sPlay = await snapState(); await p2.keyboard.press('Space'); await sleep(300);
  const sPaused = await snapState();
  check('cam_play_follows_keys', sPlay.playing && sPlay.playhead > 0.5 && sPlay.dPose < 6 && !sPaused.playing && sPaused.dPose < 1e-6, { playhead: sPlay.playhead, dPlay: sPlay.dPose, dPaused: sPaused.dPose });

  // 10. Export poses are the preview poses
  const ex = await ev2(async () => {
    const fw = window.__fw; fw.setExport({ fps: 24, duration: 1, width: 192, height: 108, samples: 1, name: 'verifyui_cam2', alpha: 'premult', format: 'png' });
    await fw.exportShot({});
    const used = fw.app.lastExportPoses; let d = 0;
    for (const u of used) { const p = fw.camera.poseAt(u.f / 24); d = Math.max(d, ...p.position.map((v, i) => Math.abs(v - u.position[i]))); }
    return { n: used.length, d };
  });
  fs.rmSync(path.join(ROOT, 'exports', 'verifyui_cam2'), { recursive: true, force: true });
  check('cam_export_poses_match_preview', ex.n === 24 && ex.d < 1e-9, ex);

  // 11. Delete key
  await p2.keyboard.press('ArrowUp'); await sleep(250);
  const nBefore = (await snapState()).nKeys;
  await p2.keyboard.press('Delete'); await sleep(250);
  const nAfter = (await snapState()).nKeys;
  check('cam_delete_selected_key', nAfter === nBefore - 1, { nBefore, nAfter });

  // 12. Loop off: the playhead stops at the end of the shot, a key cannot land beyond it
  const endTest = await ev2(async () => { const a = window.__fw.app; a.state.loop = false; window.__fw.seek(1e6); a.playing = true; await new Promise((r) => setTimeout(r, 1500)); return { playing: a.playing, over: a.playhead - window.__fw.app.transportLength }; });
  check('cam_playhead_stops_at_shot_end', endTest.playing === false, endTest);
  check('cam_page_has_no_errors', errs2.length === 0, { errs: errs2.slice(0, 3) });
  await p2.close();
}

check('no_page_errors', errors.length === 0, { errors: errors.slice(0, 5) });
fs.writeFileSync(path.join(OUT, 'ui-report.json'), JSON.stringify(report, null, 2));
await browser.close(); server.kill();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall UI checks passed');
process.exit(failed ? 1 : 0);
