// Headless verification: stills, alpha/linear checks, contact sheet, real exports (720p, 4K, auto), ffprobe tags,
// resolution parity, export safety, and real UI interaction. Writes verification/ and report.json.
import puppeteer from 'puppeteer-core';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'verification'), EXP = path.join(ROOT, 'exports');
// verify always starts (and later stops) its own dev server on a free port, so it never touches a server the user may be running
const isFree = (port) => new Promise((ok) => { const c = net.connect(port, '127.0.0.1'); c.on('connect', () => { c.destroy(); ok(false); }); c.on('error', () => ok(true)); });
let PORT = Number(process.env.FW_PORT) || 0;
for (const c of [5317, 5318, 5319, 5320, 5321, 5322]) { if (PORT) break; if (await isFree(c)) PORT = c; }
const URL_ = `http://127.0.0.1:${PORT}/`;
const PRESETS_DIR = path.join(OUT, '_presets');   // the server stores presets here during verification, so the user's own presets are never touched
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FFMPEG = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const FFPROBE = fs.existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(EXP, { recursive: true });
for (const d of fs.readdirSync(EXP)) if (/^(verify_|ui_export|stills)/.test(d)) fs.rmSync(path.join(EXP, d), { recursive: true, force: true });

const report = { generated: new Date().toISOString(), checks: {}, measurements: {} };
const check = (name, pass, data = {}) => { report.checks[name] = { pass: !!pass, ...data }; console.log(pass ? 'PASS' : 'FAIL', name, JSON.stringify(data).slice(0, 300)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function up() { try { return (await fetch(URL_)).ok; } catch { return false; } }
const startServer = async () => {
  const sv = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js')], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, FW_PORT: String(PORT), FW_PRESETS_DIR: PRESETS_DIR } });
  for (let i = 0; i < 60 && !(await up()); i++) await sleep(500);
  return sv;
};
let server = await startServer();
process.on('exit', () => server.kill());   // we only ever stop the server this script started, also when a check throws
report.devServer = `started by verify on port ${PORT} (pid ${server.pid})`;

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 1800000,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1400,800'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 800 });
const errors = [], dialogs = [];
page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });   // confirm() prompts (overwrite) are answered with OK and recorded
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });
await page.goto(URL_);
await page.waitForFunction(() => window.__fw, { timeout: 20000 });
const info = await page.evaluate(() => window.__fw.info());
report.gpu = info;
check('webgl2_real_gpu', info.webgl2 && !/swiftshader|llvmpipe|software/i.test(info.renderer), info);

await page.evaluate(() => { const fw = window.__fw, raw = fw.loadShot; fw.loadShotRaw = raw; fw.loadShot = (s, o) => raw(s, o ?? { slow: true }); });   // existing checks: layers without launchSpeed use 0.4 = apex bursts, the timing they were written for
const save = (name, dataUrl) => fs.writeFileSync(path.join(OUT, name), Buffer.from(dataUrl.split(',')[1], 'base64'));
const still = (t, o = {}) => page.evaluate((t, o) => { window.__fw.stepTo(t); const g = window.__fw.grab({ width: 1280, height: 720, stats: true, ...o }); const { dataUrl, ...m } = g; return { d: dataUrl, ...m, stats: window.__fw.getStats() }; }, t, o);
const load = (shot, view = 'Default') => page.evaluate((s, v) => { window.__fw.setCamera({ view: v }); window.__fw.setToggle('smoke', true); window.__fw.setToggle('glow', true); window.__fw.loadShot({ launch: true, ...s }); }, shot, view);

// 1. single shell at several times
await load({ seed: 4242, layers: [{ type: 'chrysanthemum', palette: 'Green' }] });
const phases = { '1_rise': 3.5, '2_after_burst': 6.3, '3_mid_burst': 8.0, '4_late_smoke': 13.5 };
const m1 = {};
for (const [k, t] of Object.entries(phases)) { const r = await still(t); save(`single_${k}.png`, r.d); m1[k] = { t, mean: +r.meanValue.toFixed(5), max: +r.maxValue.toFixed(3), stats: r.stats }; }
report.measurements.single_shell = m1;
check('single_shell_stills', m1['1_rise'].stats.tail > 50 && m1['3_mid_burst'].stats.stars > 100 && m1['4_late_smoke'].stats.smoke > 50 && m1['1_rise'].mean > 0, { rise_tail: m1['1_rise'].stats.tail, mid_stars: m1['3_mid_burst'].stats.stars, late_smoke: m1['4_late_smoke'].stats.smoke });

// late smoke: must be measurably non-black in both alpha modes, and differ from the smoke-off frame
const lateLum = await still(13.5, { alpha: 'premult' }), lateSmokeOnly = await still(13.5, { alpha: 'smoke' });
save('late_smoke_luminance_alpha.png', lateLum.d); save('late_smoke_smokeonly_alpha.png', lateSmokeOnly.d);
await page.evaluate(() => window.__fw.setToggle('smoke', false)); const lateOff = await still(13.5, { alpha: 'premult' }); save('late_smoke_off.png', lateOff.d);
await page.evaluate(() => window.__fw.setToggle('smoke', true));
const lateM = { luminance_mode: { mean_rgb: lateLum.meanValue, alpha_mean: lateLum.alphaMean, alpha_nonzero_frac: lateLum.alphaNonzeroFrac }, smoke_only_mode: { mean_rgb: lateSmokeOnly.meanValue, alpha_mean: lateSmokeOnly.alphaMean, alpha_nonzero_frac: lateSmokeOnly.alphaNonzeroFrac }, smoke_off: { mean_rgb: lateOff.meanValue, alpha_mean: lateOff.alphaMean } };
report.measurements.late_smoke = lateM;
check('late_smoke_visible', lateLum.meanValue > 0.003 && lateLum.alphaMean > 0.003 && lateSmokeOnly.alphaMean > 0.003 && lateOff.meanValue < lateLum.meanValue * 0.1, lateM);
// the two premultiplied modes must be distinguishable when stars are alive: luminance alpha is raised by light, smoke-only is not
await load({ seed: 4242, layers: [{ type: 'chrysanthemum', palette: 'Green' }] });
const midLum = await still(8.0, { alpha: 'premult' }), midSmk = await still(8.0, { alpha: 'smoke' });
check('alpha_modes_differ_with_stars', midLum.alphaMean > midSmk.alphaMean * 1.5, { luminance_alpha_mean: midLum.alphaMean, smoke_only_alpha_mean: midSmk.alphaMean });

// 2. three cameras, same moment
const cams = { default: { view: 'Default' }, closer: { view: 'Close' }, orbit90: { view: 'Side (90 deg)' } };
const camMean = {};
for (const [k, c] of Object.entries(cams)) {
  await page.evaluate((c) => window.__fw.setCamera(c), c);
  const r = await still(8.0); save(`camera_${k}.png`, r.d); camMean[k] = +r.meanValue.toFixed(5);
}
check('three_cameras_differ', new Set(Object.values(camMean)).size === 3 && Object.values(camMean).every((v) => v > 0), camMean);

// 3. combined shot
await load({ seed: 77, layers: [{ type: 'pistil', palette: 'Red' }, { type: 'willow', palette: 'Gold', delay: 0.15, expanse: 0.9 }, { type: 'ring', palette: 'Aqua', delay: 0.3, expanse: 0.6, offset: [10, 5, 0] }] });
const comb = await still(8.2); save('combined_shot.png', comb.d);
check('combined_shot', comb.stats.stars > 400, { stars: comb.stats.stars, sparks: comb.stats.sparks });

// 4. each element toggle must remove (>= 90%) the luminance that element contributes, measured with the other elements off
const tog = await page.evaluate(async () => {
  const fw = window.__fw, out = {};
  const all = ['smoke', 'stars', 'trails', 'flash', 'glow'];
  const only = (on) => all.forEach((k) => fw.setToggle(k, on.includes(k)));
  const mean = () => fw.grab({ width: 640, height: 360, stats: true }).meanValue;
  const lumPixels = async (g) => { const im = new Image(); im.src = g.dataUrl; await im.decode(); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const x = c.getContext('2d'); x.drawImage(im, 0, 0); return x.getImageData(0, 0, im.width, im.height).data; };
  const rem = (on, off) => (on > 0 ? 1 - off / on : 0);
  fw.loadShot({ seed: 4242, launch: true, layers: [{ type: 'chrysanthemum', palette: 'Green' }] }); fw.stepTo(8.0);
  only(['smoke']); out.smoke_on = mean(); only([]); out.smoke_off = mean();
  only(['stars']); out.stars_on = mean(); only([]); out.stars_off = mean();
  only(['trails']); out.trails_on = mean(); only([]); out.trails_off = mean();
  only(['stars', 'trails']);
  const gOff = fw.grab({ width: 640, height: 360 }); only(['stars', 'trails', 'glow']); const gOn = fw.grab({ width: 640, height: 360 });
  const a = await lumPixels(gOn), b = await lumPixels(gOff);
  let sOn = 0, sOff = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) { if (b[i] + b[i + 1] + b[i + 2] < 12) { sOn += a[i] + a[i + 1] + a[i + 2]; sOff += b[i] + b[i + 1] + b[i + 2]; n++; } }
  out.glow_dark_region_on = sOn / n; out.glow_dark_region_off = sOff / n;
  fw.loadShot({ seed: 6, launch: false, layers: [{ type: 'peony' }] }); fw.stepTo(0.2);
  only(['flash']); out.flash_on = mean(); only([]); out.flash_off = mean();
  all.forEach((k) => fw.setToggle(k, true));
  out.removal = { smoke: rem(out.smoke_on, out.smoke_off), stars: rem(out.stars_on, out.stars_off), trails: rem(out.trails_on, out.trails_off), flash: rem(out.flash_on, out.flash_off) };
  return out;
});
report.measurements.toggles = tog;
check('toggles_remove_their_element', ['smoke', 'stars', 'trails', 'flash'].every((k) => tog.removal[k] >= 0.9) && tog.smoke_on > 0.0005 && tog.stars_on > 0.0005 && tog.trails_on > 0.0005 && tog.flash_on > 0.0005 && tog.glow_dark_region_on > 2 * Math.max(tog.glow_dark_region_off, 0.5), { removal: tog.removal, glow_dark_region_on: +tog.glow_dark_region_on.toFixed(2), glow_dark_region_off: +tog.glow_dark_region_off.toFixed(2) });
// launch trail off also removes the launch smoke column
await load({ seed: 4242, layers: [{ type: 'chrysanthemum' }] });
const rise = await still(4.0); await page.evaluate(() => window.__fw.setToggle('launchTrail', false)); const riseOff = await still(4.0); await page.evaluate(() => window.__fw.setToggle('launchTrail', true));
check('launch_trail_off_hides_tail_and_smoke', riseOff.meanValue < rise.meanValue * 0.05, { on: rise.meanValue, off: riseOff.meanValue });

// smoke is secondary to the stars at burst peak (smoke-only vs stars-only mean luminance, glow off)
const peak = await page.evaluate(() => {
  const fw = window.__fw, out = {}, mean = () => fw.grab({ width: 1280, height: 720, stats: true }).meanValue;
  for (const [name, shot, t] of [['chrysanthemum', { seed: 4242, layers: [{ type: 'chrysanthemum', palette: 'Green' }] }, 8.0], ['combined', { seed: 77, layers: [{ type: 'pistil', palette: 'Red' }, { type: 'willow', palette: 'Gold', delay: 0.15, expanse: 0.9 }, { type: 'ring', palette: 'Aqua', delay: 0.3, expanse: 0.6, offset: [10, 5, 0] }] }, 8.2], ['kamuro', { seed: 3, layers: [{ type: 'kamuro' }] }, 8.0]]) {
    for (const k of ['smoke', 'stars', 'trails', 'flash']) fw.setToggle(k, true);
    fw.setToggle('glow', false); fw.loadShot({ launch: true, ...shot }); fw.stepTo(t);
    for (const k of ['stars', 'trails', 'flash']) fw.setToggle(k, false);
    const smoke = mean();
    for (const k of ['stars', 'trails', 'flash']) fw.setToggle(k, true);
    fw.setToggle('smoke', false); const stars = mean(); fw.setToggle('smoke', true);
    out[name] = { smokeOnly: smoke, starsOnly: stars, ratio: smoke / stars };
  }
  fw.setToggle('glow', true);
  return out;
});
report.measurements.peak_smoke_vs_stars = peak;
check('peak_smoke_secondary_to_stars', peak.chrysanthemum.ratio < 0.3 && peak.kamuro.ratio < 0.3 && peak.combined.ratio < 0.6, Object.fromEntries(Object.entries(peak).map(([k, v]) => [k, +v.ratio.toFixed(3)])));

// ring orientation as RENDERED from the default camera (minor/major axis from image moments), vs the geometric prediction
const ring = await page.evaluate(async () => {
  const fw = window.__fw;
  for (const k of ['smoke', 'glow', 'flash', 'trails']) fw.setToggle(k, false);
  const cl = Math.hypot(164, 520);   // burst (0,170,0) -> default camera (0,6,520)
  const measure = async (layer, seed) => {
    fw.setCamera({ view: 'Default' }); fw.loadShot({ seed, launch: false, layers: [layer] }); fw.stepTo(1.0);
    const g = fw.grab({ width: 1280, height: 720 }); const im = new Image(); im.src = g.dataUrl; await im.decode();
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const x = c.getContext('2d'); x.drawImage(im, 0, 0);
    const d = x.getImageData(0, 0, im.width, im.height).data; let m = 0, mx = 0, my = 0, a = 0, b = 0, cc = 0;
    for (let i = 0; i < d.length; i += 4) { const l = d[i] + d[i + 1] + d[i + 2]; if (l > 90) { const X = (i / 4) % im.width, Y = Math.floor(i / 4 / im.width); m += l; mx += l * X; my += l * Y; } }
    mx /= m; my /= m;
    for (let i = 0; i < d.length; i += 4) { const l = d[i] + d[i + 1] + d[i + 2]; if (l > 90) { const X = (i / 4) % im.width - mx, Y = Math.floor(i / 4 / im.width) - my; a += l * X * X; b += l * X * Y; cc += l * Y * Y; } }
    const tr = (a + cc) / 2, dd = Math.sqrt(Math.max(0, tr * tr - (a * cc - b * b)));
    return Math.sqrt((tr - dd) / (tr + dd));
  };
  const predict = (tiltDeg, rotDeg) => { const t = tiltDeg * Math.PI / 180, r = rotDeg * Math.PI / 180; const n = [-Math.sin(t) * Math.sin(r), Math.sin(t) * Math.cos(r), Math.cos(t)]; return Math.abs((n[1] * -164 + n[2] * 520) / cl); };
  const out = {
    default_ring: await measure({ type: 'ring' }, 5), default_ring_predicted: predict(40, 180),
    tilt0: await measure({ type: 'ring', randomTilt: false, tilt: 0, rotation: 0 }, 5), tilt0_predicted: predict(0, 0),
    tilt55: await measure({ type: 'ring', randomTilt: false, tilt: 55, rotation: 0 }, 5), tilt55_predicted: predict(55, 0),
    tilt50_rot180: await measure({ type: 'ring', randomTilt: false, tilt: 50, rotation: 180 }, 5), tilt50_rot180_predicted: predict(50, 180),
  };
  for (const k of ['smoke', 'glow', 'flash', 'trails']) fw.setToggle(k, true);
  return out;
});
report.measurements.ring_orientation_from_default_camera = ring;
check('ring_reads_as_ring_from_default_camera', ring.default_ring > 0.8 && ['tilt0', 'tilt55', 'tilt50_rot180'].every((k) => Math.abs(ring[k] - ring[k + '_predicted']) < 0.1), Object.fromEntries(Object.entries(ring).map(([k, v]) => [k, +v.toFixed(3)])));

// 5. contact sheet
const sheet = await page.evaluate(async () => {
  const fw = window.__fw; const { LIST } = await import('/src/library/index.js');
  const cols = 4, tw = 640, th = 360, rows = Math.ceil(LIST.length / cols);
  const c = document.createElement('canvas'); c.width = cols * tw; c.height = rows * th; const x = c.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height);
  fw.setCamera({ view: 'Default' });
  let i = 0, alive = 0;
  for (const t of LIST) {
    fw.loadShot({ seed: 11 + i, launch: false, layers: [{ type: t.id }] });
    fw.stepTo(0.15 + t.best);
    if (fw.getStats().total > 20) alive++;
    const g = fw.grab({ width: tw, height: th });
    const im = new Image(); im.src = g.dataUrl; await im.decode();
    x.drawImage(im, (i % cols) * tw, Math.floor(i / cols) * th);
    x.fillStyle = '#8a8f98'; x.font = '14px monospace'; x.fillText(t.name, (i % cols) * tw + 8, Math.floor(i / cols) * th + 18);
    i++;
  }
  return { d: c.toDataURL('image/png'), n: LIST.length, alive };
});
save('contact_sheet.png', sheet.d);
check('contact_sheet_all_types', sheet.n >= 15 && sheet.alive === sheet.n, { types: sheet.n, alive: sheet.alive });

// 6. resolution parity of the glare/bloom: 1280x720 vs 2560x1440 downsampled
await load({ seed: 909, launch: false, layers: [{ type: 'peony', palette: 'Red / Green' }, { type: 'willow', palette: 'Gold', delay: 0.2, expanse: 0.8 }] });
await page.evaluate(() => window.__fw.stepTo(2.4));
const par = await page.evaluate(() => window.__fw.parity(1280, 720, 2));
report.measurements.resolution_parity = par;
check('resolution_parity', Math.abs(par.energyRatio - 1) < 0.05 && par.relDiff < 0.25, par);

// glare PSF parity: radial energy profile around a single bright star at 720p, 1080p and 4K (radii are fractions of frame height)
await load({ seed: 12, launch: false, layers: [{ type: 'peony', stars: 0.003 }] });
await page.evaluate(() => { for (const k of ['smoke', 'trails', 'flash']) window.__fw.setToggle(k, false); window.__fw.stepTo(0.5); });
const prof = {};
for (const [w, h] of [[1280, 720], [1920, 1080], [3840, 2160]]) prof[`${w}x${h}`] = await page.evaluate((w, h) => window.__fw.glareProfile(w, h), w, h);
await page.evaluate(() => { for (const k of ['smoke', 'trails', 'flash']) window.__fw.setToggle(k, true); });
const refF = prof['1920x1080'].fractions;
const diffs = Object.fromEntries(Object.entries(prof).map(([k, v]) => [k, v.fractions.map((f, i) => (refF[i] > 0.005 ? +(Math.abs(f - refF[i]) / refF[i]).toFixed(3) : null))]));
report.measurements.glare_profile = { radii_frame_heights: prof['1920x1080'].radii, fractions: Object.fromEntries(Object.entries(prof).map(([k, v]) => [k, v.fractions.map((f) => +f.toFixed(4))])), rel_diff_vs_1080p: diffs };
const maxDiff = Math.max(...Object.values(diffs).flat().filter((v) => v !== null));
check('glare_profile_resolution_parity', maxDiff <= 0.08 && refF.filter((f) => f > 0.005).length >= 4, { max_rel_diff_per_annulus: maxDiff, rel_diff: diffs });

// 7. real export 1280x720 / 24 fps / 5 s, ProRes 4444 + PNG
const ex1 = await page.evaluate(() => window.__fw.exportShot({ name: 'verify_export', width: 1280, height: 720, fps: 24, duration: 5, samples: 4, alpha: 'premult', format: 'both' }).then((r) => ({ name: r.name, dir: r.dir, frames: r.frames, files: r.files, seconds: r.seconds, elapsed: r.elapsed })));
const dir = path.join(EXP, ex1.name), mov = path.join(dir, `${ex1.name}.mov`);
const probe = JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,profile,pix_fmt,width,height,r_frame_rate,nb_read_frames,duration,color_space,color_transfer,color_primaries,color_range', '-of', 'json', mov], { encoding: 'utf8' }).stdout).streams[0];
const pngs = fs.readdirSync(path.join(dir, 'png')).filter((f) => f.endsWith('.png')).sort();
report.measurements.export = { exportResult: ex1, ffprobe: probe, png_frames: pngs.length };
check('prores_has_alpha', /^yuva/.test(probe.pix_fmt) && probe.codec_name === 'prores' && probe.profile === '4444', { pix_fmt: probe.pix_fmt, profile: probe.profile });
check('mov_color_tags', probe.color_transfer === 'iec61966-2-1' && probe.color_primaries === 'bt709' && probe.color_space === 'bt709', { color_transfer: probe.color_transfer, color_primaries: probe.color_primaries, color_space: probe.color_space, color_range: probe.color_range });
check('export_frame_count_duration', +probe.nb_read_frames === 120 && Math.abs(+probe.duration - 5) < 0.05 && pngs.length === 120, { frames: +probe.nb_read_frames, duration: +probe.duration, png_frames: pngs.length });

const raw = (args) => spawnSync(FFMPEG, ['-v', 'error', ...args, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba64le', '-'], { maxBuffer: 1 << 29 }).stdout;
const eotf = (v) => { v /= 65535; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const analyse = (buf, w, h) => {
  const u = new Uint16Array(buf.buffer, buf.byteOffset, buf.length / 2), px = (x, y) => { const i = (y * w + x) * 4; return [u[i], u[i + 1], u[i + 2], u[i + 3]]; };
  const corners = [px(0, 0), px(w - 1, 0), px(0, h - 1), px(w - 1, h - 1)];
  let nz = 0, maxA = 0, over = 0, hi = 0;
  for (let i = 0; i < u.length; i += 4) {
    const a = u[i + 3]; if (a > 0) nz++; if (a > 655) hi++; if (a > maxA) maxA = a;
    const m = Math.max(u[i], u[i + 1], u[i + 2]);
    if (m && eotf(m) > a / 65535 + 0.0025) over++;      // linear-light premultiplication check (RGB below ~1/512 is valid additive data)
  }
  const n = w * h;
  return { corners, alpha_nonzero_fraction: +(nz / n).toFixed(5), alpha_over_1pct_fraction: +(hi / n).toFixed(5), max_alpha: maxA, linear_rgb_exceeds_alpha_pixels: over };
};
const mid = pngs[60];
fs.copyFileSync(path.join(dir, 'png', mid), path.join(OUT, 'export_mid_frame.png'));
const aPng = analyse(raw(['-i', path.join(dir, 'png', mid)]), 1280, 720), aMov = analyse(raw(['-i', mov, '-vf', 'select=eq(n\\,60)', '-fps_mode', 'passthrough']), 1280, 720);
report.measurements.export.mid_frame_png = aPng; report.measurements.export.mid_frame_mov = aMov;
const exactBlack = (a) => a.corners.every((c) => c.every((v) => v === 0));
check('png_corners_black_alpha0', exactBlack(aPng) && aPng.alpha_over_1pct_fraction > 0.005, { corners: aPng.corners, alpha_nonzero_fraction: aPng.alpha_nonzero_fraction, alpha_over_1pct_fraction: aPng.alpha_over_1pct_fraction });
check('mov_corners_black_alpha0', exactBlack(aMov) && aMov.alpha_over_1pct_fraction > 0.005, { corners: aMov.corners, alpha_nonzero_fraction: aMov.alpha_nonzero_fraction });
check('alpha_not_a_full_frame_veil', aPng.alpha_nonzero_fraction < 0.6, { png_nonzero: aPng.alpha_nonzero_fraction, mov_nonzero: aMov.alpha_nonzero_fraction });
check('png_linear_premultiplied_consistent', aPng.linear_rgb_exceeds_alpha_pixels === 0, { exceeds: aPng.linear_rgb_exceeds_alpha_pixels });

// 8. export safety: same name again must never overwrite; smoke-only alpha mode export works
const stamp = fs.statSync(mov).mtimeMs;
const ex2 = await page.evaluate(() => window.__fw.exportShot({ name: 'verify_export', width: 640, height: 360, fps: 24, duration: 3.5, samples: 1, alpha: 'smoke', format: 'png' }).then((r) => ({ name: r.name, frames: r.frames, files: r.files })));
check('export_never_overwrites', ex2.name !== ex1.name && fs.existsSync(mov) && fs.statSync(mov).mtimeMs === stamp && fs.existsSync(path.join(EXP, ex2.name)) && !fs.readdirSync(EXP).some((d) => d.endsWith('.partial')), { first: ex1.name, second: ex2.name });
{
  const files = fs.readdirSync(path.join(EXP, ex2.name, 'png')).sort();
  const early = new Uint16Array(raw(['-i', path.join(EXP, ex2.name, 'png', files[30])]).buffer), late = new Uint16Array(raw(['-i', path.join(EXP, ex2.name, 'png', files[80])]).buffer);
  let bright = 0, brightLowAlpha = 0, brightHighAlpha = 0, smokePix = 0;
  for (let i = 0; i < early.length; i += 4) {   // bright stars (early frame) carry no alpha in smoke-only mode
    const m = Math.max(early[i], early[i + 1], early[i + 2]) / 65535, a = early[i + 3] / 65535;
    if (m > 0.35) { bright++; if (a < 0.05) brightLowAlpha++; if (a > 0.5) brightHighAlpha++; }
  }
  for (let i = 3; i < late.length; i += 4) if (late[i] / 65535 > 0.02) smokePix++;   // smoke (late frame) has coverage
  report.measurements.smoke_only_alpha = { frames: ex2.frames, bright_pixels: bright, bright_with_alpha_below_5pct: brightLowAlpha, bright_with_alpha_above_50pct: brightHighAlpha, smoke_pixels_alpha_above_2pct: smokePix };
  check('smoke_only_alpha_mode_export', ex2.frames === 84 && bright >= 20 && brightLowAlpha / bright >= 0.8 && smokePix >= 200, report.measurements.smoke_only_alpha);
}

// 9. determinism
const det = await page.evaluate(() => { const fw = window.__fw; const h = () => { const w = fw.app.world; let s = 0; for (let i = 0; i < w.nL * 35; i += 7) s += w.L[i]; return s; }; fw.loadShot({ seed: 909, launch: false, layers: [{ type: 'peony' }] }); fw.stepTo(2); const a = h(); fw.loadShot({ seed: 909, launch: false, layers: [{ type: 'peony' }] }); fw.stepTo(2); return [a, h()]; });
check('deterministic_same_seed', det[0] === det[1], { a: det[0], b: det[1] });
// separate RNG streams keyed by stable layer ids: smoke amount, another layer's star count and removing a layer must not move the untouched layer's stars
const iso = await page.evaluate(() => {
  const fw = window.__fw;
  const redStars = () => { const w = fw.app.world, o = []; for (let i = 0; i < w.nL; i++) if (w.L[i * 35 + 18] === 0 && w.L[i * 35 + 11] > 0.9) o.push([w.L[i * 35], w.L[i * 35 + 1], w.L[i * 35 + 2]].map((v) => v.toFixed(4)).join(',')); return o.sort().join('|'); };
  const run = (layers, smoke) => { fw.setPhysics({ smokeAmount: smoke }); fw.loadShot({ seed: 5, launch: false, layers }); fw.stepTo(1.2); return redStars(); };
  const A = { id: 11, type: 'peony', palette: 'Red' }, R = { id: 12, type: 'ring', palette: 'Aqua', delay: 0.3 }, C = { id: 13, type: 'crossette', palette: 'Green' };
  const base = run([A, R, C], 1), smoke = run([A, R, C], 2.5), count = run([A, { ...R, stars: 0.5 }, C], 1), removed = run([A, R], 1), removedFirst = run([R, A, C].filter((l) => l.id !== 12), 1);
  fw.setPhysics({ smokeAmount: 1 });
  return { n: base.split('|').length, smoke: base === smoke, otherLayerCount: base === count, otherLayerRemoved: base === removed, reorderedAndRemoved: base === removedFirst };
});
report.measurements.rng_isolation = iso;
check('rng_streams_isolated', iso.n > 50 && iso.smoke && iso.otherLayerCount && iso.otherLayerRemoved && iso.reorderedAndRemoved, iso);

// export is isolated from UI actions: Fire/seed/physics/layer edits during an export must not change a single byte of the frames
await page.evaluate(() => { window.__fw.setPhysics({ burstVel: 1, drag: 1, windX: 0, gravity: 1 }); window.__fw.setRender({ exposure: 0 }); });
await load({ seed: 2024, launch: false, layers: [{ id: 21, type: 'peony', palette: 'Red / Green' }, { id: 22, type: 'ring', palette: 'Aqua', delay: 0.2 }] });
const isoOpts = { width: 320, height: 180, fps: 24, duration: 0.5, samples: 4, alpha: 'premult', format: 'png' };
const isoA = await page.evaluate((o) => window.__fw.exportShot({ ...o, name: 'verify_iso_a' }).then((r) => r.name), isoOpts);
const isoB = await page.evaluate(async (o) => {
  const fw = window.__fw, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const p = fw.exportShot({ ...o, name: 'verify_iso_b' });
  await sleep(40); fw.app.state.seed = 999; fw.setPhysics({ burstVel: 0.5, drag: 2, windX: 9 }); fw.app.state.shot.layers[0].stars = 0.2; fw.setRender({ exposure: 2 });
  fw.fire(); await sleep(40); fw.setPhysics({ gravity: 0.2 }); fw.fire();
  return (await p).name;
}, isoOpts);
await page.evaluate(() => { window.__fw.setPhysics({ burstVel: 1, drag: 1, windX: 0, gravity: 1 }); window.__fw.setRender({ exposure: 0 }); });
const hashDir = (n) => fs.readdirSync(path.join(EXP, n, 'png')).sort().map((f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(EXP, n, 'png', f))).digest('hex'));
const hA = hashDir(isoA), hB = hashDir(isoB);
check('export_isolated_from_ui', hA.length === 12 && hA.every((h, i) => h === hB[i]), { frames: hA.length, identical: hA.filter((h, i) => h === hB[i]).length });

// export API is not reachable without the custom header or from a foreign Origin, and the server survives; cancel leaves nothing behind
const call = (method, p, headers = {}) => new Promise((ok) => { const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, (res) => { res.resume(); res.on('end', () => ok(res.statusCode)); }); r.on('error', () => ok(0)); r.end(method === 'POST' ? '{}' : undefined); });
const sec = {
  start_no_header: await call('POST', '/__export/start'),
  start_foreign_origin: await call('POST', '/__export/start', { 'X-FW-Export': '1', Origin: 'http://evil.example' }),
  start_null_origin: await call('POST', '/__export/start', { 'X-FW-Export': '1', Origin: 'null' }),
  frame_no_header: await call('POST', '/__export/frame'),
  ffmpeg_ok: await call('GET', '/__export/ffmpeg', { 'X-FW-Export': '1' }),
};
check('export_api_rejects_foreign_requests', [sec.start_no_header, sec.start_foreign_origin, sec.start_null_origin, sec.frame_no_header].every((c) => c >= 400 && c < 500) && sec.ffmpeg_ok === 200 && await up(), sec);
await page.evaluate(() => { window.__fw.exportShot({ name: 'verify_cancel', width: 640, height: 360, fps: 24, duration: 8, samples: 1, alpha: 'premult', format: 'both' }).catch(() => {}); });
await sleep(1500);
await page.evaluate(() => window.__fw.app.cancelExport());
await sleep(2000);
const leftovers = fs.readdirSync(EXP).filter((d) => d.endsWith('.partial') || d === 'verify_cancel');
const procs = spawnSync('pgrep', ['-f', 'verify_cancel']).stdout.toString().trim();
check('export_cancel_cleans_up', leftovers.length === 0 && procs === '' && !(await page.evaluate(() => window.__fw.app.exporting)), { leftovers, ffmpeg_processes: procs });

// 10. 4K export, ~2 s, 4 motion-blur samples
await load({ seed: 909, launch: false, layers: [{ type: 'peony', palette: 'Red / Green' }, { type: 'willow', palette: 'Gold', delay: 0.2, expanse: 0.8 }] });
const ex4k = await page.evaluate(() => window.__fw.exportShot({ name: 'verify_4k', width: 3840, height: 2160, fps: 24, duration: 2, samples: 4, alpha: 'premult', format: 'both' }).then((r) => ({ name: r.name, frames: r.frames, seconds: r.seconds, elapsed: r.elapsed, width: r.width, height: r.height })));
const p4k = JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,pix_fmt,nb_frames', '-of', 'json', path.join(EXP, ex4k.name, `${ex4k.name}.mov`)], { encoding: 'utf8' }).stdout).streams[0];
report.measurements.export_4k = { ...ex4k, probe: p4k };
check('export_4k_2s_4samples', ex4k.frames === 48 && p4k.width === 3840 && p4k.height === 2160, { frames: ex4k.frames, seconds_of_video: ex4k.seconds, wall_seconds: +ex4k.elapsed.toFixed(1) });

// 11. auto-duration export with launch enabled
await load({ seed: 31, layers: [{ type: 'peony', palette: 'Red' }] });
const exAuto = await page.evaluate(() => window.__fw.exportShot({ name: 'verify_auto', width: 640, height: 360, fps: 24, duration: 0, samples: 1, alpha: 'premult', format: 'prores' }).then((r) => ({ name: r.name, frames: r.frames, seconds: r.seconds, elapsed: r.elapsed })));
report.measurements.export_auto = exAuto;
check('export_auto_duration_with_launch', exAuto.frames > 24 * 15 && exAuto.frames < 24 * 60, { frames: exAuto.frames, video_seconds: exAuto.seconds, wall_seconds: +exAuto.elapsed.toFixed(1) });

// ============ feature round: split types, colours, grand finale, physics variation, launch styles, strobe smoke ============
await page.evaluate(() => {
  const T = window.__t = {};
  T.decode = async (url) => { const im = new Image(); im.src = url; await im.decode(); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const x = c.getContext('2d'); x.drawImage(im, 0, 0); return x.getImageData(0, 0, im.width, im.height).data; };
  T.diff = (a, b) => { let d = 0, s = 0; for (let i = 0; i < a.length; i += 4) { d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); s += a[i] + a[i + 1] + a[i + 2] + b[i] + b[i + 1] + b[i + 2]; } return s ? d / s : 0; };
  T.hue = (a) => { let sx = 0, sy = 0, n = 0; for (let i = 0; i < a.length; i += 4) { const r = a[i], g = a[i + 1], b = a[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx < 60 || (mx - mn) / mx < 0.3) continue; let h = mx === r ? ((g - b) / (mx - mn)) % 6 : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4; h *= Math.PI / 3; sx += Math.cos(h); sy += Math.sin(h); n++; } return n ? (Math.atan2(sy, sx) * 180 / Math.PI + 360) % 360 : -1; };
  T.colours = () => { const w = window.__fw.app.world, o = { star: [0, 0, 0, 0], spark: [0, 0, 0, 0] }; for (let i = 0; i < w.nL; i++) { const k = w.L[i * 35 + 18]; const t = k === 0 ? o.star : k === 1 ? o.spark : null; if (!t) continue; const r = w.L[i * 35 + 11], g = w.L[i * 35 + 12], b = w.L[i * 35 + 13]; t[0]++; if (r > g && r > b) t[1]++; else if (g > r && g > b) t[2]++; else if (b > r && b > g) t[3]++; } return o; };   // [count, red-dominant, green-dominant, blue-dominant]
});
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

// 1. the four split types render and look different from each other (image comparison)
const splitTypes = { horsetail: 3.2, waterfall: 4.6, crackle: 1.8, dragoneggs: 3.0 };
const split = await page.evaluate(async (types) => {
  const T = window.__t, fw = window.__fw, urls = {}, data = {}, means = {};
  for (const [id, t] of Object.entries(types)) { fw.setCamera({ view: 'Default' }); fw.loadShot({ seed: 21, launch: false, layers: [{ type: id }] }); fw.stepTo(0.15 + t); const g = fw.grab({ width: 960, height: 540, stats: true }); urls[id] = g.dataUrl; means[id] = g.meanValue; data[id] = await T.decode(g.dataUrl); }
  const ids = Object.keys(types), diffs = {};
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) diffs[ids[i] + ' vs ' + ids[j]] = T.diff(data[ids[i]], data[ids[j]]);
  return { urls, means, diffs };
}, splitTypes);
for (const [id, u] of Object.entries(split.urls)) save(`split_${id}.png`, u);
report.measurements.split_types = { means: split.means, pairwise_diff_ratio: split.diffs };
check('split_types_render_and_differ', Object.values(split.means).every((m) => m > 0.0005) && Object.values(split.diffs).every((d) => d > 0.4), { min_pairwise_diff_ratio: +Math.min(...Object.values(split.diffs)).toFixed(3), means: split.means });

// 2. combo presets load as ordinary, editable layers
const combos = await page.evaluate(() => {
  const fw = window.__fw, st = fw.app.state, out = {};
  for (const [name, types] of [['Horsetail + Waterfall', ['horsetail', 'waterfall']], ['Crackle + Dragon Eggs', ['crackle', 'dragoneggs']]]) {
    fw.setCamera({ view: 'Default' }); fw.loadShot({ seed: 3, launch: false, preset: name });
    const L = st.shot.layers, both = L.length === 2 && L[0].type === types[0] && L[1].type === types[1] && L.every((l) => l.id != null && l.palette);
    fw.stepTo(3.0); const base = fw.grab({ width: 480, height: 270, stats: true }).meanValue;
    L[0].palette = 'Blue'; L[0].enabled = false; fw.fire(); fw.stepTo(3.0); const edited = fw.grab({ width: 480, height: 270, stats: true }).meanValue;
    out[name] = { two_layers: both, mean_before_edit: base, mean_after_edit: edited, edit_changes_image: base !== edited };
  }
  return out;
});
report.measurements.combo_presets = combos;
check('combo_presets_load_as_two_editable_layers', Object.values(combos).every((c) => c.two_layers && c.edit_changes_image && c.mean_before_edit > 0), combos);

// 3. per-layer colours: recolouring layer A changes only A (hue) and leaves layer B pixel-identical
const colr = await page.evaluate(async () => {
  const T = window.__t, fw = window.__fw;
  const mk = (pa, pb, ea, eb) => ({ seed: 31, launch: false, layers: [{ id: 1, type: 'peony', palette: pa, offset: [-45, 0, 0], enabled: ea }, { id: 2, type: 'chrysanthemum', palette: pb, offset: [45, 0, 0], enabled: eb }] });
  const render = (shot) => { fw.setCamera({ view: 'Default' }); fw.loadShot(shot); fw.stepTo(1.95); return fw.grab({ width: 960, height: 540 }).dataUrl; };
  const aRed = render(mk('Red', 'Blue', true, false)), aGreen = render(mk('Green', 'Blue', true, false));
  const bBefore = render(mk('Red', 'Blue', false, true)), bAfter = render(mk('Green', 'Blue', false, true));
  const both = render(mk('Green', 'Blue', true, true)), bothRed = render(mk('Red', 'Blue', true, true));
  return { hueRed: T.hue(await T.decode(aRed)), hueGreen: T.hue(await T.decode(aGreen)), hueB: T.hue(await T.decode(bBefore)), bIdentical: bBefore === bAfter, combinedChanges: both !== bothRed, bothUrl: both };
});
save('layer_colours_recoloured_A.png', colr.bothUrl);
report.measurements.layer_colours = { hue_A_red: colr.hueRed, hue_A_green: colr.hueGreen, hue_B_blue: colr.hueB, B_pixels_identical_after_recolouring_A: colr.bIdentical };
check('recolouring_one_layer_changes_only_its_hue', hueDist(colr.hueRed, colr.hueGreen) > 80 && colr.bIdentical && colr.combinedChanges && colr.hueB > 180 && colr.hueB < 260, report.measurements.layer_colours);

// secondary / trail / custom colour controls (read from the sim's star and spark colours)
const comps = await page.evaluate(() => {
  const T = window.__t, fw = window.__fw, o = {};
  const run = (layer, t) => { fw.loadShot({ seed: 9, launch: false, layers: [{ id: 1, ...layer }] }); fw.stepTo(t); return T.colours(); };
  o.pistil_core_blue = run({ type: 'pistil', palette: 'Green', palette2: 'Blue' }, 0.4).star[3];
  o.pistil_core_red = run({ type: 'pistil', palette: 'Green', palette2: 'Red' }, 0.4).star[1];
  o.saturn_core_gold = run({ type: 'saturn', palette: 'Blue', palette2: 'Gold' }, 0.4).star[1];
  o.saturn_core_green = run({ type: 'saturn', palette: 'Blue', palette2: 'Green' }, 0.4).star[2];
  o.custom_green = run({ type: 'peony', palette: 'Custom', customColor: '#00ff00' }, 0.4).star;
  o.crossette_children_blue = run({ type: 'crossette', palette: 'Red', palette2: 'Blue' }, 2.0).star[3];
  o.crossette_children_inherit_blue = run({ type: 'crossette', palette: 'Red', palette2: null }, 2.0).star[3];
  o.willow_trail_blue = run({ type: 'willow', palette: 'Gold', palette3: 'Blue' }, 2.0).spark[3];
  o.willow_trail_default_blue = run({ type: 'willow', palette: 'Gold', palette3: null }, 2.0).spark[3];
  return o;
});
report.measurements.colour_components = comps;
check('secondary_trail_custom_colour_controls', comps.pistil_core_blue >= 100 && comps.pistil_core_red >= 100 && comps.saturn_core_gold >= 100 && comps.saturn_core_green >= 100 && comps.custom_green[2] >= 0.9 * comps.custom_green[0]
  && comps.crossette_children_blue >= 50 && comps.crossette_children_inherit_blue === 0 && comps.willow_trail_blue >= 100 && comps.willow_trail_default_blue === 0, comps);

// 4. grand finale: schedule, repeats clamp, noise, positions, determinism (sim-level, from the recorded launch plan)
const fin = await page.evaluate(() => {
  const fw = window.__fw;
  const plan = (layers, finale, extra = {}) => { fw.loadShot({ seed: 5, launch: false, layers, finale: { enabled: true, totalTime: 12, spreadX: 200, spreadZ: 100, posSeed: 3, heightVar: 0, ...finale }, ...extra }); return fw.app.world.launchPlan.map((p) => ({ ...p })); };
  const L = (id, o = {}) => ({ id, type: 'peony', ...o });
  const times = (p, id) => p.filter((q) => q.layerId === id).map((q) => q.t);
  const std = (a) => { const m = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
  const gaps = (a) => a.slice(1).map((v, i) => v - a[i]);
  const o = {};
  const p1 = plan([L(1, { repeats: 5 }), L(2, { repeats: 3, startOffset: 2 })], {});
  o.auto = { a: times(p1, 1), b: times(p1, 2) };
  o.manual = times(plan([L(1, { repeats: 4, interval: 0.5, startOffset: 1 })], {}), 1);
  const n0 = times(plan([L(1, { repeats: 8, noise: 0 })], {}), 1), n8 = times(plan([L(1, { repeats: 8, noise: 0.8 })], {}), 1), n8b = times(plan([L(1, { repeats: 8, noise: 0.8 })], {}), 1);
  const n8s = (fw.loadShot({ seed: 6, layers: [L(1, { repeats: 8, noise: 0.8 })], finale: { enabled: true, totalTime: 12 } }), fw.app.world.launchPlan.map((q) => q.t));
  o.noise = { gap_std_no_noise: std(gaps(n0)), gap_std_noise: std(gaps(n8)), same_seed_equal: JSON.stringify(n8) === JSON.stringify(n8b), other_seed_differs: JSON.stringify(n8) !== JSON.stringify(n8s), all_in_range: n8.every((t) => t >= 0 && t <= 12) };
  o.clamped = plan([L(1, { repeats: 50 })], {}).length;
  const p5 = plan([L(1, { repeats: 20 })], {}), p5b = plan([L(1, { repeats: 20 })], {}), p5c = plan([L(1, { repeats: 20 })], { posSeed: 4 });
  const key = (p) => p.map((q) => q.x.toFixed(3) + ',' + q.z.toFixed(3));
  o.positions = { distinct: new Set(key(p5)).size, in_bounds: p5.every((q) => Math.abs(q.x) <= 100 + 1e-6 && Math.abs(q.z) <= 50 + 1e-6), same_seed_equal: JSON.stringify(key(p5)) === JSON.stringify(key(p5b)), other_seed_differs: JSON.stringify(key(p5)) !== JSON.stringify(key(p5c)) };
  // finale off: the single launch matches the previous behaviour (star positions of fixed shots, recorded before the feature round)
  const sum = () => { const w = fw.app.world; let n = 0, x = 0, y = 0, z = 0; for (let i = 0; i < w.nL; i++) { const q = i * 35; if (w.L[q + 18] === 0) { n++; x += w.L[q]; y += w.L[q + 1]; z += w.L[q + 2]; } } return [n, +x.toFixed(3), +y.toFixed(3), +z.toFixed(3)]; };
  fw.loadShot({ seed: 909, launch: false, layers: [{ id: 1, type: 'peony' }] }); fw.stepTo(2.0); const g1 = sum();
  fw.loadShot({ seed: 4242, launch: true, layers: [{ id: 1, type: 'chrysanthemum', palette: 'Green' }] }); fw.stepTo(8.0); const g2 = sum();
  o.legacy = { peony: g1, chrysanthemum: g2 };
  return o;
});
report.measurements.finale_schedule = fin;
const within = (a) => a.every((t) => t >= 0 && t <= 12 + 1e-9);
check('finale_auto_interval_within_total_time', within(fin.auto.a) && within(fin.auto.b) && Math.abs(fin.auto.a[0]) < 1e-9 && Math.abs(fin.auto.a.at(-1) - 12) < 1e-9 && Math.abs(fin.auto.b[0] - 2) < 1e-9 && Math.abs(fin.auto.b.at(-1) - 12) < 1e-9 && fin.auto.a.length === 5 && fin.auto.b.length === 3, fin.auto);
check('finale_manual_interval_honoured', fin.manual.length === 4 && fin.manual.every((t, i) => Math.abs(t - (1 + 0.5 * i)) < 1e-9), { times: fin.manual });
check('finale_interval_noise_seeded', fin.noise.gap_std_no_noise < 1e-9 && fin.noise.gap_std_noise > 0.05 && fin.noise.same_seed_equal && fin.noise.other_seed_differs && fin.noise.all_in_range, fin.noise);
check('finale_repeats_clamped_to_20', fin.clamped === 20, { launches_for_repeats_50: fin.clamped });
check('finale_launch_positions', fin.positions.distinct === 20 && fin.positions.in_bounds && fin.positions.same_seed_equal && fin.positions.other_seed_differs, fin.positions);
// star positions of two fixed shots with finale off. Re-recorded once, after the per-launch streams were moved to mix32 seeding (a requested change); it guards against any later drift
const GOLD = { peony: [379, 407.43, 60818.439, -11.727], chrysanthemum: [300, -798.018, 47660.381, -393.891] };   // chrysanthemum loaded with launchSpeed 0.4 (apex burst); re-recorded when the tail got its own random stream
check('finale_off_matches_recorded_behaviour', JSON.stringify(fin.legacy.peony) === JSON.stringify(GOLD.peony) && JSON.stringify(fin.legacy.chrysanthemum) === JSON.stringify(GOLD.chrysanthemum), { measured: fin.legacy, recorded: GOLD });

// finale exports: same seeds -> byte-identical frames; auto duration continues until the last firework and smoke died
const finShot = { seed: 8, launch: false, finale: { enabled: true, totalTime: 3, spreadX: 160, spreadZ: 80, posSeed: 2, heightVar: 10 }, layers: [{ id: 1, type: 'peony', repeats: 3, noise: 0.3 }, { id: 2, type: 'strobe', repeats: 2, startOffset: 1 }], variation: { enabled: true, seed: 4 } };
const finExp = { width: 320, height: 180, fps: 12, duration: 4, samples: 1, alpha: 'premult', format: 'png' };
await page.evaluate((s) => window.__fw.loadShot(s), finShot);
const fa = await page.evaluate((o) => window.__fw.exportShot({ ...o, name: 'verify_fin_a' }).then((r) => r.name), finExp);
const fb = await page.evaluate((o) => window.__fw.exportShot({ ...o, name: 'verify_fin_b' }).then((r) => r.name), finExp);
const hashes = (n) => fs.readdirSync(path.join(EXP, n, 'png')).sort().map((f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(EXP, n, 'png', f))).digest('hex'));
const hfa = hashes(fa), hfb = hashes(fb);
await page.evaluate((s) => window.__fw.loadShot({ ...s, finale: { ...s.finale, posSeed: 9 } }), finShot);
const fc = await page.evaluate((o) => window.__fw.exportShot({ ...o, name: 'verify_fin_c' }).then((r) => r.name), finExp); const hfc = hashes(fc);
check('finale_same_seeds_identical_export_frames', hfa.length === 48 && hfa.every((h, i) => h === hfb[i]) && new Set(hfa).size > 10 && hfc.filter((h, i) => h !== hfa[i]).length > 5, { frames: hfa.length, identical: hfa.filter((h, i) => h === hfb[i]).length, frames_that_differ_with_other_position_seed: hfc.filter((h, i) => h !== hfa[i]).length });
await page.evaluate((s) => window.__fw.loadShot(s), finShot);
const autoFin = await page.evaluate((o) => window.__fw.exportShot({ ...o, duration: 0, fps: 12, name: 'verify_fin_auto', format: 'prores' }).then((r) => ({ frames: r.frames, seconds: r.seconds, elapsed: r.elapsed, hitCap: r.hitCap })), finExp);
const finEnd = await page.evaluate((s) => { const fw = window.__fw; fw.loadShot(s); const w = fw.app.world; let t = 0; while (!w.finished && t < 200) { t += 1 / 120; w.advanceTo(t); } return { end: w.t, lastBurst: w.burstLog.at(-1).t }; }, finShot);
report.measurements.finale_auto_export = { total_time_s: 3, ...autoFin, simulated_world_finished_at_s: finEnd.end, last_burst_s: finEnd.lastBurst };
check('finale_auto_duration_matches_simulated_end', !autoFin.hitCap && Math.abs(autoFin.seconds - finEnd.end) <= 1 / 12 + 0.02 && autoFin.seconds > finEnd.lastBurst + 8, report.measurements.finale_auto_export);

// 5. physics variation per launch
const pv = await page.evaluate(() => {
  const fw = window.__fw;
  const run = (on, vseed) => {
    fw.loadShot({ seed: 9, launch: false, layers: [{ id: 1, type: 'peony', repeats: 6 }], finale: { enabled: true, totalTime: 6, spreadX: 100, spreadZ: 50, posSeed: 2 }, variation: { enabled: on, burstVel: 50, lifetime: 50, smokeAmount: 50, smokeLife: 50, seed: vseed } });
    fw.stepTo(22); return fw.app.world.fires.map((f) => ({ speed: f.stats.speed / f.stats.n, life: f.stats.life / f.stats.n, radius: f.stats.radius / f.stats.n, smoke: f.stats.smoke }));
  };
  const cv = (arr, k) => { const v = arr.map((x) => x[k]), m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) / m; };
  const on = run(true, 5), on2 = run(true, 5), other = run(true, 6), off = run(false, 5);
  const c = (a) => ({ radius: cv(a, 'radius'), life: cv(a, 'life'), smoke: cv(a, 'smoke') });
  return { launches: on.length, cv_on: c(on), cv_off: c(off), same_seed_equal: JSON.stringify(on) === JSON.stringify(on2), other_seed_differs: JSON.stringify(on) !== JSON.stringify(other) };
});
report.measurements.physics_variation = pv;
check('physics_variation_per_launch', pv.launches === 6 && pv.cv_on.radius > 0.08 && pv.cv_on.life > 0.08 && pv.cv_on.smoke > 0.1 && pv.cv_off.radius < 0.04 && pv.cv_off.life < 0.04 && pv.cv_off.smoke < pv.cv_on.smoke * 0.6 && pv.same_seed_equal && pv.other_seed_differs, pv);

// 6. launch styles
const styles = await page.evaluate(async () => {
  const T = window.__t, fw = window.__fw, o = { urls: {}, mean: {}, dev: {} }, data = {}, names = ['none', 'dark', 'gold', 'silver', 'spiral', 'crackle'];
  for (const st of names) {
    fw.loadShot({ seed: 5, layers: [{ id: 1, type: 'peony', launchStyle: st }] }); fw.setCamera({ position: [0, 40, 260], target: [0, 90, 0], focal: 40 });
    fw.stepTo(3.2); const g = fw.grab({ width: 640, height: 720, stats: true }); o.urls[st] = g.dataUrl; o.mean[st] = g.maxValue; data[st] = await T.decode(g.dataUrl);
    const w = fw.app.world; let s = 0, n = 0; for (let i = 0; i < w.nL; i++) if (w.L[i * 35 + 18] === 4) { s += w.L[i * 35] ** 2 + w.L[i * 35 + 2] ** 2; n++; } o.dev[st] = n ? Math.sqrt(s / n) : 0;
  }
  o.diffs = {}; for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) o.diffs[names[i] + ' vs ' + names[j]] = T.diff(data[names[i]], data[names[j]]);
  fw.setCamera({ view: 'Default' });
  return o;
});
for (const [k, u] of Object.entries(styles.urls)) save(`launch_style_${k}.png`, u);
report.measurements.launch_styles = { max_pixel_value_before_burst: styles.mean, lateral_rms_of_tail_sparks_m: styles.dev, pairwise_diff_ratio: styles.diffs };
check('launch_style_none_invisible_before_burst', styles.mean.none === 0 && styles.mean.gold > 0 && styles.mean.dark > 0, report.measurements.launch_styles.max_pixel_value_before_burst);
check('launch_style_spiral_kinks_more_than_gold', styles.dev.spiral > 1.5 * styles.dev.gold, { spiral: styles.dev.spiral, gold: styles.dev.gold });
check('launch_styles_pairwise_different_images', Object.values(styles.diffs).every((d) => d > 0.05), { min_diff_ratio: +Math.min(...Object.values(styles.diffs)).toFixed(3) });

// 7. strobe: every star leaves a little puff; after strobing ends they show as many separate puffs near the former star positions
const strobe = await page.evaluate(async () => {
  const T = window.__t, fw = window.__fw;
  fw.setCamera({ view: 'Default' }); fw.loadShot({ seed: 3, launch: false, layers: [{ id: 1, type: 'strobe' }] });
  fw.stepTo(0.15 + 3.0); const live = fw.grab({ width: 1280, height: 720 }).dataUrl;
  const cam = fw.app.rig.camera, w = fw.app.world, pts = [];
  for (let i = 0; i < w.nL; i++) if (w.L[i * 35 + 18] === 0) { const v = new cam.position.constructor(w.L[i * 35], w.L[i * 35 + 1], w.L[i * 35 + 2]).project(cam); pts.push([(v.x * 0.5 + 0.5) * 1280, (0.5 - v.y * 0.5) * 720]); }
  const comp = async (smokeOn) => {
    for (const k of ['stars', 'trails', 'flash', 'glow']) fw.setToggle(k, false); fw.setToggle('smoke', smokeOn);
    const g = fw.grab({ width: 1280, height: 720 }); const a = await T.decode(g.dataUrl);
    const W = 1280, H = 720, lab = new Int32Array(W * H), thr = 7; let n = 0; const cents = [];
    for (let s = 0; s < W * H; s++) { if (lab[s] || a[s * 4] + a[s * 4 + 1] + a[s * 4 + 2] < thr * 3) continue; n++; const st = [s]; lab[s] = n; let cx = 0, cy = 0, ar = 0;
      while (st.length) { const q = st.pop(), x = q % W, y = (q / W) | 0; cx += x; cy += y; ar++; for (const d of [-1, 1, -W, W]) { const r = q + d; if (r < 0 || r >= W * H || (d === 1 && x === W - 1) || (d === -1 && x === 0) || lab[r] || a[r * 4] + a[r * 4 + 1] + a[r * 4 + 2] < thr * 3) continue; lab[r] = n; st.push(r); } }
      if (ar >= 6) cents.push([cx / ar, cy / ar, ar]); }
    return { cents, url: g.dataUrl };
  };
  fw.stepTo(0.15 + 9.5); const stats = fw.getStats();
  const on = await comp(true), off = await comp(false);
  for (const k of ['stars', 'trails', 'flash', 'glow', 'smoke']) fw.setToggle(k, true);
  const near = on.cents.filter((c) => pts.some((p) => Math.hypot(p[0] - c[0], p[1] - c[1]) < 22)).length;
  return { live, late: on.url, recorded_star_positions: pts.length, components_smoke_on: on.cents.length, components_smoke_off: off.cents.length, near_recorded_star: near, alive_after: stats.stars };
});
save('strobe_puffs_while_strobing.png', strobe.live); save('strobe_puffs_after_strobing_smoke_only.png', strobe.late);
report.measurements.strobe_puffs = { recorded_star_positions: strobe.recorded_star_positions, separate_puffs_smoke_on: strobe.components_smoke_on, separate_puffs_smoke_off: strobe.components_smoke_off, puffs_near_a_recorded_star: strobe.near_recorded_star, stars_alive: strobe.alive_after };
check('strobe_leaves_separate_puffs', strobe.alive_after === 0 && strobe.components_smoke_on >= 40 && strobe.near_recorded_star >= 0.6 * strobe.components_smoke_on && strobe.components_smoke_off === 0, report.measurements.strobe_puffs);

// 8. heavy finale: 8 layers x >= 4 repeats, no dropped particles, preview frame rate at peak, 1080p export
const HEAVY_TYPES = ['peony', 'chrysanthemum', 'willow', 'kamuro', 'palm', 'crossette', 'strobe', 'crackle'];
const heavyShot = (launch) => ({ seed: 77, launch, finale: { enabled: true, totalTime: 12, spreadX: 320, spreadZ: 140, posSeed: 9, heightVar: 20 }, variation: { enabled: true, seed: 3 },
  layers: HEAVY_TYPES.map((t, i) => ({ id: i + 1, type: t, repeats: i === 5 ? 5 : 4, startOffset: i * 0.8, noise: 0.3, launchStyle: ['gold', 'silver', 'spiral', 'crackle'][i % 4] })) });
const heavy = await page.evaluate(async (shot) => {
  const fw = window.__fw; fw.loadShot(shot); fw.setCamera({ view: 'Finale wide' });
  let peakT = 0, peak = 0; for (let t = 1; t <= 45; t += 1) { fw.stepTo(t); const s = fw.getStats(); if (s.total > peak) { peak = s.total; peakT = t; } if (s.overflow) break; }
  const final = fw.getStats(); const plan = fw.app.world.launchPlan.length;
  fw.loadShot(shot); fw.setCamera({ view: 'Finale wide' }); fw.stepTo(peakT - 0.5);
  const t0 = performance.now(); const N = 30; for (let i = 1; i <= N; i++) fw.stepTo(peakT - 0.5 + i / 60);   // sim step(s) + a real preview render per frame
  const ms = (performance.now() - t0) / N;
  return { launches: plan, peak_total_particles: final.peak.total, peak_lights: final.peak.lights, peak_smoke: final.peak.smoke, overflow: final.overflow, overflow_smoke: final.overflowSmoke, peak_time_s: peakT, ms_per_frame_at_peak: ms, fps_at_peak: 1000 / ms };
}, heavyShot(true));
report.measurements.heavy_finale = heavy;
check('heavy_finale_no_dropped_particles', heavy.launches >= 33 && heavy.overflow === 0 && heavy.overflow_smoke === 0 && heavy.peak_total_particles > 100000, heavy);
const heavyExp = await page.evaluate((shot) => { window.__fw.loadShot(shot); return window.__fw.exportShot({ name: 'verify_heavy', width: 1920, height: 1080, fps: 24, duration: 4, samples: 1, alpha: 'premult', format: 'png' }).then((r) => ({ frames: r.frames, elapsed: r.elapsed, overflow: r.overflow, overflowSmoke: r.overflowSmoke, dropped: r.dropped, hitCap: r.hitCap })); }, heavyShot(false));
report.measurements.heavy_finale_export_1080p = heavyExp;
check('heavy_finale_1080p_export_completes', heavyExp.frames === 96 && heavyExp.overflow === 0 && heavyExp.overflowSmoke === 0 && heavyExp.dropped === 0, heavyExp);

// 9. built-in finale from the wide view, three moments (stills)
const parkMoments = await page.evaluate(async () => {
  const { FINALE_PRESETS } = await import('/src/library/finales.js'); const fw = window.__fw, o = {};
  fw.loadShot(FINALE_PRESETS['Park finale (22 s, wide)']()); fw.setCamera({ view: 'Finale wide' });
  for (const t of [8, 14, 23]) { fw.stepTo(t); const g = fw.grab({ width: 1280, height: 720, stats: true }); o[t] = { url: g.dataUrl, mean: g.meanValue, stats: fw.getStats() }; }
  fw.setCamera({ view: 'Default' });
  return o;
});
for (const [t, v] of Object.entries(parkMoments)) save(`finale_park_wide_t${String(t).padStart(2, '0')}.png`, v.url);
report.measurements.finale_park = Object.fromEntries(Object.entries(parkMoments).map(([t, v]) => [t, { mean: v.mean, stats: v.stats }]));
check('builtin_finale_renders_three_moments', Object.values(parkMoments).every((v) => v.mean > 0.001), report.measurements.finale_park);

// ============ review fixes: ids, validation, pop colours, edge cases, isolation, estimates, spiral irregularity ============
// layer ids: stable across loads, repaired when invalid; unknown types are reported and never half-apply a shot
const ids = await page.evaluate(async () => {
  const fw = window.__fw, { FINALE_PRESETS } = await import('/src/library/finales.js'), o = {};
  const plan = () => JSON.stringify(fw.app.world.launchPlan);
  fw.loadShot(FINALE_PRESETS['Park finale (22 s, wide)']()); const p1 = plan(); const ids1 = fw.app.state.shot.layers.map((l) => l.id);
  fw.loadShot(FINALE_PRESETS['Park finale (22 s, wide)']()); const p2 = plan();
  o.same_session_identical_plan = p1 === p2; o.builtin_ids = ids1;
  const repaired = (layers) => { fw.loadShot({ launch: false, layers }); return fw.app.state.shot.layers.map((l) => l.id); };
  o.repaired = repaired([{ type: 'peony', id: 1 }, { type: 'peony', id: 1 }, { type: 'peony' }, { type: 'peony', id: '3' }, { type: 'peony', id: 2.5 }, { type: 'peony', id: -4 }, { type: 'peony', id: 0 }]);
  const box = document.getElementById('progress');
  fw.loadShot({ layers: [{ type: 'peony' }, { type: 'no_such_type' }] }); o.partial_notice = box.textContent; o.partial_layers = fw.app.state.shot.layers.length;
  fw.loadShot({ launch: false, layers: [{ type: 'peony', id: 5 }] });
  const before2 = JSON.stringify(fw.snapshot());
  const r = fw.loadShot({ seed: 777, layers: [{ type: 'no_such_type' }, { type: 'also_missing' }] });
  o.all_unknown_error = r.error || null; o.all_unknown_notice = box.textContent; o.previous_shot_intact = JSON.stringify(fw.snapshot()) === before2;
  return o;
});
report.measurements.layer_ids = ids;
check('layer_ids_stable_and_repaired', ids.same_session_identical_plan && ids.builtin_ids.join() === '1,2,3,4,5,6,7,8,9' && new Set(ids.repaired).size === 7 && ids.repaired.every((v) => Number.isInteger(v) && v > 0), ids);
check('unknown_layer_type_notice_and_previous_shot_kept', /unknown layer type/i.test(ids.partial_notice) && ids.partial_layers === 1 && !!ids.all_unknown_error && /no usable layer/i.test(ids.all_unknown_notice) && ids.previous_shot_intact, { partial_notice: ids.partial_notice, all_unknown_notice: ids.all_unknown_notice, previous_shot_intact: ids.previous_shot_intact });

// the same built-in finale loaded in a fresh page gives the same launch plan and byte-identical export frames
const planOf = (pg) => pg.evaluate(async () => { const { FINALE_PRESETS } = await import('/src/library/finales.js'); const fw = window.__fw; const d = FINALE_PRESETS['Rapid barrage (9 s)'](); d.launch = false; fw.loadShot(d); return JSON.stringify(fw.app.world.launchPlan); });
const rbExport = { width: 160, height: 90, fps: 12, duration: 4, samples: 1, alpha: 'premult', format: 'png' };
const planA = await planOf(page);
const rbA = await page.evaluate((o) => window.__fw.exportShot({ ...o, name: 'verify_rb_a' }).then((r) => r.name), rbExport);
const freshPg = await browser.newPage(); await freshPg.setViewport({ width: 1400, height: 800 }); await freshPg.goto(URL_); await freshPg.waitForFunction(() => window.__fw);
const planB = await planOf(freshPg);
const rbB = await freshPg.evaluate((o) => window.__fw.exportShot({ ...o, name: 'verify_rb_b' }).then((r) => r.name), rbExport);
await freshPg.close();
const hRbA = hashes(rbA), hRbB = hashes(rbB);
check('builtin_finale_identical_across_loads_and_pages', planA === planB && hRbA.length === 48 && hRbA.every((h, i) => h === hRbB[i]) && new Set(hRbA).size > 8, { plan_equal: planA === planB, frames: hRbA.length, identical: hRbA.filter((h, i) => h === hRbB[i]).length, distinct_frames: new Set(hRbA).size });

// pop colours reach the rendered pixels (Dragon Eggs pop colour, Crackle colour)
const popHue = await page.evaluate(async () => {
  const T = window.__t, fw = window.__fw;
  const hueAt = async (layer, times) => { let sx = 0, sy = 0, n = 0; for (const t of times) { fw.setCamera({ view: 'Default' }); fw.loadShot({ seed: 8, launch: false, layers: [{ id: 1, ...layer }] }); fw.stepTo(0.15 + t); const a = await T.decode(fw.grab({ width: 640, height: 360 }).dataUrl);
    for (let i = 0; i < a.length; i += 4) { const r = a[i], g = a[i + 1], b = a[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx < 90 || (mx - mn) / mx < 0.18) continue; let h = mx === r ? ((g - b) / (mx - mn)) % 6 : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4; h *= Math.PI / 3; sx += Math.cos(h); sy += Math.sin(h); n++; } }
    return n > 20 ? (Math.atan2(sy, sx) * 180 / Math.PI + 360) % 360 : -1; };
  const eggTimes = [2.0, 2.2, 2.4, 2.6, 2.8, 3.0, 3.2, 3.4], crTimes = [0.8, 1.1, 1.4, 1.7, 2.0, 2.3];
  return { eggs_blue: await hueAt({ type: 'dragoneggs', palette2: 'Blue' }, eggTimes), eggs_green: await hueAt({ type: 'dragoneggs', palette2: 'Green' }, eggTimes),
    crackle_blue: await hueAt({ type: 'crackle', palette: 'Blue' }, crTimes), crackle_green: await hueAt({ type: 'crackle', palette: 'Green' }, crTimes) };
});
report.measurements.pop_colours = popHue;
check('pop_colour_controls_change_rendered_hue', popHue.eggs_blue > 0 && popHue.eggs_green > 0 && hueDist(popHue.eggs_blue, popHue.eggs_green) > 50 && popHue.crackle_blue > 0 && popHue.crackle_green > 0 && hueDist(popHue.crackle_blue, popHue.crackle_green) > 50, popHue);

// negative / tiny burst heights: every shell bursts and the world finishes
const edge = await page.evaluate(() => {
  const fw = window.__fw;
  fw.loadShot({ seed: 3, burstHeight: 60, finale: { enabled: true, totalTime: 6, spreadX: 100, spreadZ: 50, heightVar: 80, posSeed: 4 }, layers: [{ id: 1, type: 'peony', repeats: 8 }, { id: 2, type: 'willow', repeats: 5 }] });
  const w = fw.app.world; let nan = false; w.advanceTo(160);
  for (let i = 0; i < w.nL; i++) if (!Number.isFinite(w.L[i * 35])) nan = true;
  return { planned: w.launchPlan.length, bursts: w.burstLog.length, finished: w.finished, advanced_to_s: +w.t.toFixed(1), min_planned_height: Math.min(...w.launchPlan.map((p) => p.H)), nan };
});
report.measurements.burst_height_edge = edge;
check('burst_height_60_with_variation_80_finishes', edge.planned === 13 && edge.bursts === 13 && edge.finished && !edge.nan && edge.min_planned_height >= 20, edge);

// smoke amount 0 leaves no smoke at all (burst clouds, star paths, death puffs, launch trail)
const smoke0 = await page.evaluate(() => {
  const fw = window.__fw, run = (amount) => { fw.setPhysics({ smokeAmount: amount }); fw.loadShot({ seed: 5, layers: [{ id: 1, type: 'strobe' }, { id: 2, type: 'peony' }, { id: 3, type: 'willow' }] }); const w = fw.app.world; let max = 0; for (let t = 0.5; t <= 26; t += 0.5) { w.advanceTo(t); max = Math.max(max, w.nM, w.peak.smoke); } return max; };
  const a = run(0), b = run(1); fw.setPhysics({ smokeAmount: 1 }); return { zero: a, one: b };
});
report.measurements.smoke_amount_zero = smoke0;
check('smoke_amount_0_leaves_no_smoke', smoke0.zero === 0 && smoke0.one > 500, smoke0);

// launch styles: 'none' is black at every sampled time before the burst (including the ground flash at t~0), 'dark' is quicker, all-disabled shots are empty
const quiet = await page.evaluate(() => {
  const fw = window.__fw, o = { none: {}, burst: {} };
  const maxAt = (t) => { fw.stepTo(t); return fw.grab({ width: 480, height: 270, stats: true }).maxValue; };
  for (const st of ['none', 'gold', 'dark']) {
    fw.loadShot({ seed: 5, layers: [{ id: 1, type: 'peony', launchStyle: st }] }); fw.app.world.advanceTo(10); o.burst[st] = fw.app.world.burstLog[0].t;
    fw.loadShot({ seed: 5, layers: [{ id: 1, type: 'peony', launchStyle: st }] }); fw.setCamera({ position: [0, 30, 300], target: [0, 70, 0], focal: 28 });   // frames the ground launch point and the climb
    const vals = {};
    for (const t of [0.0, 0.02, 0.1, 0.3, 0.8, 1.5, 2.5, 3.5, 4.5, 5.2]) { if (t >= o.burst[st] - 0.05) break; vals[t] = maxAt(t); }
    o.none[st] = vals;
  }
  fw.loadShot({ seed: 5, layers: [{ id: 1, type: 'peony', enabled: false }, { id: 2, type: 'willow', enabled: false }] });
  const w = fw.app.world, empty = [];
  for (const t of [0, 0.5, 2, 5, 8, 12]) { empty.push(maxAt(t), w.shells.length, w.nL, w.nM); }
  o.disabled = { values: empty, finished: w.finished, plan: w.launchPlan.length };
  fw.loadShot({ seed: 5, finale: { enabled: true, totalTime: 4 }, layers: [{ id: 1, type: 'peony', enabled: false, repeats: 5 }] }); o.disabled_finale_plan = fw.app.world.launchPlan.length;
  return o;
});
report.measurements.launch_style_edge = quiet;
check('launch_style_none_black_at_every_time_before_burst', Object.values(quiet.none.none).length >= 7 && Object.values(quiet.none.none).every((v) => v === 0) && quiet.none.gold['0.1'] > 0 && quiet.none.gold['0.8'] > 0 && quiet.none.dark['0.8'] > 0, { none: quiet.none.none, gold: quiet.none.gold, dark: quiet.none.dark });
check('dark_style_bursts_sooner_than_gold', quiet.burst.dark < quiet.burst.gold - 1, { dark_burst_s: quiet.burst.dark, gold_burst_s: quiet.burst.gold, none_burst_s: quiet.burst.none });
check('all_layers_disabled_renders_nothing', quiet.disabled.values.every((v) => v === 0) && quiet.disabled.finished && quiet.disabled.plan === 0 && quiet.disabled_finale_plan === 0, quiet.disabled);

// layer isolation: the particles of one layer (stars, trail sparks, pops AND smoke puffs) are identical whatever other layers exist
const iso2 = await page.evaluate(() => {
  const fw = window.__fw;
  const rows = (layers, t) => {
    fw.loadShot({ seed: 6, layers }); const w = fw.app.world; w.advanceTo(t);
    const mine = new Set(w.fires.filter((f) => f.layerId === 1).map((f) => f.id)), out = [], sm = [];
    for (let i = 0; i < w.nL; i++) { const o = i * 35, k = w.L[o + 18]; if (k === 4 || k === 3 || !mine.has(w.L[o + 31] | 0)) continue; out.push([k, w.L[o], w.L[o + 1], w.L[o + 2], w.L[o + 6]].map((v) => (+v).toFixed(3)).join(',')); }
    for (let i = 0; i < w.nM; i++) { const o = i * 16; if (mine.has(w.M[o + 15] | 0)) sm.push([w.M[o], w.M[o + 1], w.M[o + 2], w.M[o + 6]].map((v) => (+v).toFixed(3)).join(',')); }
    return { rows: out.sort(), smoke: sm.sort() };
  };
  const A = { id: 1, type: 'willow', palette: 'Gold' };
  const a = rows([A, { id: 2, type: 'peony' }], 8.0), b = rows([A, { id: 3, type: 'kamuro' }, { id: 4, type: 'crossette' }, { id: 5, type: 'strobe' }], 8.0), c = rows([{ ...A, stars: 1.01 }, { id: 2, type: 'peony' }], 8.0);
  const kinds = {}; for (const r of a.rows) { const k = r.split(',')[0]; kinds[k] = (kinds[k] || 0) + 1; }
  return { rows: a.rows.length, smoke: a.smoke.length, kinds, equal_rows: JSON.stringify(a.rows) === JSON.stringify(b.rows), equal_smoke: JSON.stringify(a.smoke) === JSON.stringify(b.smoke), control_differs: JSON.stringify(a.rows) !== JSON.stringify(c.rows) };
});
report.measurements.layer_isolation = iso2;
check('layer_isolation_includes_trails_and_smoke', iso2.rows > 5000 && iso2.smoke > 100 && iso2.kinds['1.000'] > 1000 && iso2.equal_rows && iso2.equal_smoke && iso2.control_differs, iso2);

// spiral launch trail: irregular (non-periodic) lateral path, and no two launches alike
const spiral = await page.evaluate(() => {
  const fw = window.__fw;
  const trace = (style, seed) => {
    fw.loadShot({ seed, layers: [{ id: 1, type: 'peony', launchStyle: style }] }); fw.app.world.advanceTo(3.4); const w = fw.app.world, pts = [];
    for (let i = 0; i < w.nL; i++) { const o = i * 35; if (w.L[o + 18] === 4) pts.push([w.L[o + 1], w.L[o]]); }
    pts.sort((p, q) => p[0] - q[0]); const y0 = pts[0][0], y1 = pts.at(-1)[0], BIN = 0.75, n = Math.floor((y1 - y0) / BIN), s = [];
    for (let b = 0; b < n; b++) { const sel = pts.filter((p) => p[0] >= y0 + b * BIN && p[0] < y0 + (b + 1) * BIN); if (sel.length) s.push(sel.reduce((a, p) => a + p[1], 0) / sel.length); else s.push(s.length ? s.at(-1) : 0); }
    return s;
  };
  // share of the variance explained by the best single sinusoid (free frequency, phase, amplitude): ~1 for a regular corkscrew, low for an irregular trace
  const sineR2 = (s) => { const N = s.length, m = s.reduce((a, v) => a + v, 0) / N, sst = s.reduce((a, v) => a + (v - m) ** 2, 0); let best = 0; for (let f = 0.03; f <= 0.45; f += 0.004) { let cc = 0, ss = 0, cs = 0, yc = 0, ys = 0; for (let n = 0; n < N; n++) { const c = Math.cos(2 * Math.PI * f * n), sn = Math.sin(2 * Math.PI * f * n), y = s[n] - m; cc += c * c; ss += sn * sn; cs += c * sn; yc += y * c; ys += y * sn; } const det = cc * ss - cs * cs; if (Math.abs(det) < 1e-9) continue; const a = (yc * ss - ys * cs) / det, b = (ys * cc - yc * cs) / det; let sse = 0; for (let n = 0; n < N; n++) { const r = s[n] - m - a * Math.cos(2 * Math.PI * f * n) - b * Math.sin(2 * Math.PI * f * n); sse += r * r; } best = Math.max(best, 1 - sse / sst); } return best; };
  const corr = (a, b) => { const n = Math.min(a.length, b.length), ma = a.slice(0, n).reduce((s, v) => s + v, 0) / n, mb = b.slice(0, n).reduce((s, v) => s + v, 0) / n; let sab = 0, sa = 0, sb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; } return sab / Math.sqrt(sa * sb); };
  const segAngleStd = (s) => { const a = []; for (let i = 2; i < s.length; i++) a.push(Math.atan2(s[i] - s[i - 1], 0.75) - Math.atan2(s[i - 1] - s[i - 2], 0.75)); const m = a.reduce((x, v) => x + v, 0) / a.length; return Math.sqrt(a.reduce((x, v) => x + (v - m) ** 2, 0) / a.length); };
  const seeds = [5, 6, 7, 8, 9], tr = seeds.map((sd) => trace('spiral', sd)), sg = trace('gold', 5);
  const ideal = tr[0].map((_, i) => 5.5 * Math.sin(2 * Math.PI * i / 16));
  const r2 = tr.map(sineR2), kink = tr.map(segAngleStd), cors = []; for (let i = 1; i < tr.length; i++) cors.push(Math.abs(corr(tr[0], tr[i])));
  return { points: tr[0].length, sine_fit_r2_per_launch: r2, sine_fit_r2_mean: r2.reduce((a, v) => a + v, 0) / r2.length, sine_fit_r2_ideal_sine: sineR2(ideal), kink_angle_std_mean: kink.reduce((a, v) => a + v, 0) / kink.length, kink_angle_std_ideal: segAngleStd(ideal), abs_corr_between_launches_mean: cors.reduce((a, v) => a + v, 0) / cors.length, rms_spiral: Math.sqrt(tr[0].reduce((a, v) => a + v * v, 0) / tr[0].length), rms_gold: Math.sqrt(sg.reduce((a, v) => a + v * v, 0) / sg.length) };
});
report.measurements.spiral_irregularity = spiral;
check('spiral_trail_is_irregular_not_a_sine', spiral.points > 40 && spiral.sine_fit_r2_ideal_sine > 0.95 && spiral.sine_fit_r2_mean < 0.65 && Math.max(...spiral.sine_fit_r2_per_launch) < 0.9 && spiral.kink_angle_std_mean > 1.4 * spiral.kink_angle_std_ideal && spiral.abs_corr_between_launches_mean < 0.5, spiral);

// long finale (> 90 s of video): the auto export ends because the world finished, not at the cap; the estimate predicts the length
const longShot = { seed: 14, launch: false, finale: { enabled: true, totalTime: 100, spreadX: 120, spreadZ: 60, posSeed: 2, heightVar: 0 }, layers: [{ id: 1, type: 'peony', repeats: 4 }, { id: 2, type: 'strobe', repeats: 3 }] };
await page.evaluate((s) => { const fw = window.__fw; fw.loadShot(s); fw.setExport({ width: 160, height: 90, fps: 2, duration: 0, samples: 1, format: 'PNG sequence (16-bit)', alpha: 'premult' }); }, longShot);
const est = await page.evaluate(() => window.__fw.estimate());
const simEnd = await page.evaluate((s) => { const fw = window.__fw; fw.loadShot(s); const w = fw.app.world; let t = 0; while (!w.finished && t < 700) { t += 1 / 120; w.advanceTo(t); } return w.t; }, longShot);
const longExp = await page.evaluate((s) => { const fw = window.__fw; fw.loadShot(s); return fw.exportShot({ name: 'verify_long', width: 160, height: 90, fps: 2, duration: 0, samples: 1, alpha: 'premult', format: 'png' }).then((r) => ({ frames: r.frames, seconds: r.seconds, hitCap: r.hitCap, overflow: r.overflow, overflowSmoke: r.overflowSmoke, dropped: r.dropped })); }, longShot);
report.measurements.long_finale_export = { estimate: est, simulated_end_s: simEnd, export: longExp };
check('long_finale_auto_export_ends_when_world_finished', longExp.seconds > 90 && !longExp.hitCap && Math.abs(longExp.seconds - simEnd) <= 1 / 2 + 0.05 && longExp.overflow === 0 && longExp.overflowSmoke === 0, { video_s: longExp.seconds, simulated_world_finished_at_s: +simEnd.toFixed(2), hit_cap: longExp.hitCap });
check('export_estimate_predicts_frame_count', est.frames >= longExp.frames * 0.95 && est.frames <= longExp.frames * 1.6 && est.bytes > 0, { estimated_frames: est.frames, real_frames: longExp.frames, ratio: +(est.frames / longExp.frames).toFixed(2), estimated_bytes: est.bytes });

// ============ launch speed: per-layer control, per-type defaults, per-launch variation, old presets, estimate ============
const lsBase = await page.evaluate(() => {
  const fw = window.__fw, o = {};
  const flight = (layers, extra = {}) => { fw.loadShotRaw({ seed: 5, layers, ...extra }); const w = fw.app.world; w.advanceTo(14); const b = w.burstLog[0]; return { t: b.t, y: b.origin[1], plan: w.launchPlan[0].flight }; };
  o.speeds = {}; for (const m of [0.5, 1, 2]) o.speeds[m] = flight([{ id: 1, type: 'chrysanthemum', launchSpeed: m }]);
  o.types = {}; for (const t of ['kamuro', 'willow', 'peony', 'crackle']) o.types[t] = flight([{ id: 1, type: t }]).t;
  o.heights = {}; for (const H of [100, 170, 300]) o.heights[H] = flight([{ id: 1, type: 'chrysanthemum', launchSpeed: 2 }], { burstHeight: H }).y / H;
  fw.loadShotRaw({ seed: 5, layers: [{ id: 1, type: 'chrysanthemum', launchSpeed: 2 }] });   // the layer folder shows the read-only time for this one
  o.measured_t2 = o.speeds[2].t;
  return o;
});
await page.evaluate(() => { const t = [...document.querySelectorAll('.lil-title')].find((e) => /^1\. /.test(e.textContent.trim())); if (t && t.parentElement.classList.contains('lil-closed')) t.click(); });
await sleep(600);
const shownTime = await page.evaluate(() => { const c = [...document.querySelectorAll('.lil-controller')].find((e) => /ground-to-burst/.test(e.textContent)); return c ? c.querySelector('input').value : null; });
const shownSeconds = parseFloat(shownTime);
report.measurements.launch_speed = { by_multiplier: lsBase.speeds, by_type_at_multiplier_1: lsBase.types, burst_y_over_set_height_at_speed_2: lsBase.heights, ui_readonly_text: shownTime };
const ys = Object.values(lsBase.speeds).map((v) => v.y);
check('launch_speed_keeps_burst_height_and_shortens_flight', Math.max(...ys) - Math.min(...ys) < 1.5 && lsBase.speeds[0.5].t > lsBase.speeds[1].t + 0.5 && lsBase.speeds[1].t > lsBase.speeds[2].t + 0.5 && Object.values(lsBase.heights).every((r) => r > 1.02 && r < 1.06) && Object.values(lsBase.speeds).every((v) => Math.abs(v.t - v.plan) < 0.05), { burst_y: ys.map((y) => +y.toFixed(2)), flight_s: Object.fromEntries(Object.entries(lsBase.speeds).map(([k, v]) => [k, +v.t.toFixed(2)])), y_over_set_height: lsBase.heights });
check('launch_speed_readonly_value_matches_burst_time', Number.isFinite(shownSeconds) && Math.abs(shownSeconds - lsBase.measured_t2) < 0.05, { ui_text: shownTime, measured_s: +lsBase.measured_t2.toFixed(3) });
check('launch_speed_type_defaults_differ', lsBase.types.kamuro > lsBase.types.willow - 0.01 && lsBase.types.willow > lsBase.types.peony + 0.5 && lsBase.types.peony > lsBase.types.crackle + 0.3 && lsBase.types.kamuro - lsBase.types.crackle > 1.5, lsBase.types);

const lsVar = await page.evaluate(() => {
  const fw = window.__fw, o = {};
  const flights = (variation) => { fw.loadShotRaw({ seed: 9, launch: true, layers: [{ id: 1, type: 'chrysanthemum', repeats: 6 }], finale: { enabled: true, totalTime: 12, spreadX: 100, spreadZ: 50, posSeed: 2, heightVar: 0 }, ...(variation ? { variation } : {}) });   // heightVar 0: all launches burst at the same height, so flight differences come from speed only
    const w = fw.app.world; w.advanceTo(40); return w.launchLog.map((l) => w.burstLog.find((b) => b.layerId === l.layerId && b.k === l.k).t - l.t); };
  const std = (a) => { const m = a.reduce((x, v) => x + v, 0) / a.length; return Math.sqrt(a.reduce((x, v) => x + (v - m) ** 2, 0) / a.length); };
  const v = (amt, seed) => ({ enabled: true, burstVel: 0, lifetime: 0, smokeAmount: 0, smokeLife: 0, launchSpeed: amt, seed });
  const a = flights(v(40, 5)), a2 = flights(v(40, 5)), b = flights(v(40, 6)), zero = flights(v(0, 5)), dflt = flights(null);
  fw.loadShotRaw({ seed: 9, launch: true, layers: [{ id: 1, type: 'chrysanthemum' }, { id: 2, type: 'peony' }], variation: v(100, 5) });
  const single = fw.app.world; single.advanceTo(14); const plan = single.launchPlan[0].flight, real = single.burstLog[0].t;
  return { flights_40pct: a, std_40: std(a), std_0: std(zero), std_default: std(dflt), same_seed_equal: JSON.stringify(a) === JSON.stringify(a2), other_seed_differs: JSON.stringify(a) !== JSON.stringify(b), single_shot_exact: Math.abs(plan - real) < 0.05 };
});
report.measurements.launch_speed_variation = lsVar;
check('launch_speed_variation_per_launch', lsVar.std_40 > 0.2 && lsVar.std_0 < 0.01 && lsVar.std_default > 0.03 && lsVar.same_seed_equal && lsVar.other_seed_differs && lsVar.single_shot_exact, lsVar);

// an old preset (no launchSpeed anywhere) loads with defaults and bursts at the height it always did
const oldp = await page.evaluate(() => {
  const fw = window.__fw, g = 9.81, k = 0.0006, H = 1 / 120;
  fw.loadShotRaw({ seed: 3, burstHeight: 170, layers: [{ type: 'chrysanthemum', palette: 'Green' }], variation: { enabled: true, burstVel: 10, lifetime: 10, smokeAmount: 10, smokeLife: 10, seed: 2 } });
  const st = fw.snapshot(); const w = fw.app.world; w.advanceTo(12);
  // the previous shell: apex at 1.03 x burst height, burst when the vertical speed drops below 4 m/s
  let vy = Math.sqrt(g * (Math.exp(2 * k * 170 * 1.03) - 1) / k), y = 1.5; while (vy >= 4) { vy += (-g - k * Math.abs(vy) * vy) * H; y += vy * H; }
  return { layer_launchSpeed: st.layers[0].launchSpeed, variation_launchSpeed: st.variation.launchSpeed, burst_y: w.burstLog[0].origin[1], previous_burst_y: y };
});
report.measurements.old_preset = oldp;
check('old_preset_without_launch_speed_keeps_burst_height', oldp.layer_launchSpeed === 1 && oldp.variation_launchSpeed === 8 && Math.abs(oldp.burst_y - oldp.previous_burst_y) < 1.5, oldp);

// the export estimate accounts for the slowest flight: slow shells (apex bursts) in a long finale
const slowShot = { seed: 21, launch: true, finale: { enabled: true, totalTime: 60, spreadX: 100, spreadZ: 50, posSeed: 3, heightVar: 0 }, variation: { enabled: false, launchSpeed: 25 }, layers: [{ id: 1, type: 'kamuro', repeats: 4, launchSpeed: 0.4 }, { id: 2, type: 'waterfall', repeats: 3, launchSpeed: 0.4 }] };
await page.evaluate((s) => { const fw = window.__fw; fw.loadShotRaw(s); fw.setExport({ width: 160, height: 90, fps: 2, duration: 0, samples: 1, format: 'PNG sequence (16-bit)', alpha: 'premult' }); }, slowShot);
const slowEst = await page.evaluate(() => window.__fw.estimate());
const slowReal = await page.evaluate((s) => { window.__fw.loadShotRaw(s); return window.__fw.exportShot({ name: 'verify_slow', width: 160, height: 90, fps: 2, duration: 0, samples: 1, alpha: 'premult', format: 'png' }).then((r) => ({ frames: r.frames, seconds: r.seconds, hitCap: r.hitCap })); }, slowShot);
report.measurements.slow_shell_estimate = { estimate: slowEst, real: slowReal };
check('export_estimate_with_slow_shells', !slowReal.hitCap && slowEst.frames >= slowReal.frames * 0.95 && slowEst.frames <= slowReal.frames * 1.6, { estimated_frames: slowEst.frames, real_frames: slowReal.frames, ratio: +(slowEst.frames / slowReal.frames).toFixed(2) });

// stills: a fast and a slow rise at the same moment
for (const [tag, tNow] of [['t0p8', 0.8], ['t1p3', 1.3]]) {
const riseUrl = await page.evaluate(async (tNow) => {
  const fw = window.__fw, T = window.__t, W = 640, Hh = 720, c = document.createElement('canvas'); c.width = W * 2; c.height = Hh; const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height);
  let i = 0;
  for (const [label, m] of [['launch speed x 2.2 (fast)', 2.2], ['launch speed x 0.4 (slowest: apex burst)', 0.4]]) {
    fw.loadShotRaw({ seed: 5, layers: [{ id: 1, type: 'peony', launchSpeed: m }] }); fw.setCamera({ position: [0, 40, 520], target: [0, 100, 0], focal: 32 }); fw.stepTo(tNow);
    const g = fw.grab({ width: W, height: Hh }); const im = new Image(); im.src = g.dataUrl; await im.decode(); x.drawImage(im, i * W, 0);
    x.fillStyle = '#9aa0a6'; x.font = '16px monospace'; x.fillText(label + `  at t = ${tNow} s`, i * W + 10, 22); i++;
  }
  fw.setCamera({ view: 'Default' }); void T;
  return c.toDataURL('image/png');
}, tNow);
save(`launch_speed_fast_vs_slow_rise_${tag}.png`, riseUrl);
}

// 12. drive the REAL UI with mouse / keyboard
await page.reload(); await page.waitForFunction(() => window.__fw); await sleep(1200);
await page.evaluate(() => { window.__fw.setExport({ width: 640, height: 360, duration: 1, samples: 1, fps: 24, name: 'ui_export', format: 'ProRes 4444 + PNG', alpha: 'premult' }); window.__fw.app.state.shot.launch = true; });
const pos = () => page.evaluate(() => window.__fw.app.rig.camera.position.toArray());
const quat = () => page.evaluate(() => window.__fw.app.rig.camera.quaternion.toArray());
const boxOf = async (sel, text, nth = 0) => page.evaluate((sel, text, nth) => {
  const els = [...document.querySelectorAll(sel)].filter((e) => (e.querySelector('.lil-name')?.textContent || e.textContent).trim() === text || (e.querySelector('.lil-name')?.textContent || '').includes(text));
  const e = els[nth]; if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}, sel, text, nth);
const clickText = async (sel, text, nth = 0) => { const b = await boxOf(sel, text, nth); if (!b) throw new Error('UI element not found: ' + text); await page.mouse.click(b.x, b.y); await sleep(150); };
const ui = {};
// click Save still, then Export
await clickText('.lil-controller.lil-function', 'Save still (PNG)'); await sleep(2500);
ui.stills = fs.existsSync(path.join(EXP, 'stills')) ? fs.readdirSync(path.join(EXP, 'stills')).filter((f) => f.endsWith('.png')) : [];
await clickText('.lil-controller.lil-function', 'Export');
for (let i = 0; i < 120; i++) { await sleep(500); const done = fs.existsSync(path.join(EXP, 'ui_export', 'ui_export.mov')) && !(await page.evaluate(() => window.__fw.app.exporting)); if (done) break; }
ui.export_files = fs.existsSync(path.join(EXP, 'ui_export')) ? fs.readdirSync(path.join(EXP, 'ui_export')) : [];
ui.png_count = fs.existsSync(path.join(EXP, 'ui_export', 'png')) ? fs.readdirSync(path.join(EXP, 'ui_export', 'png')).length : 0;
// orbit drag + wheel dolly on the canvas
const p0 = await pos();
await page.mouse.move(400, 450); await page.mouse.down(); await page.mouse.move(520, 470, { steps: 12 }); await page.mouse.up(); await sleep(200);
const p1 = await pos();
await page.mouse.move(400, 450); await page.mouse.wheel({ deltaY: -400 }); await sleep(300);
const p2 = await pos();
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
ui.orbit_moved = dist(p0, p1); ui.dolly_moved = dist(p1, p2);
// free-fly: toggle via UI, rotate by drag, move with W, edit numeric field and confirm rotation preserved
await clickText('.lil-controller.lil-boolean', 'free-fly'); await sleep(200);
await page.mouse.move(400, 450); await page.mouse.down(); await page.mouse.move(470, 430, { steps: 8 }); await page.mouse.up(); await sleep(200);
const q0 = await quat(), f0 = await pos();
await page.keyboard.down('KeyW'); await sleep(500); await page.keyboard.up('KeyW'); await sleep(100);
const f1 = await pos();
const box = await boxOf('.lil-controller', 'pos X');
await page.mouse.click(box.x + 40, box.y); await page.evaluate(() => document.activeElement.select()); await page.keyboard.type('123'); await page.keyboard.press('Enter'); await sleep(300);
const q1 = await quat(), f2 = await pos();
ui.fly_moved_with_W = dist(f0, f1); ui.fly_x_after_edit = f2[0]; ui.fly_quat_dot = Math.abs(q0.reduce((s, v, i) => s + v * q1[i], 0));
await clickText('.lil-controller.lil-boolean', 'free-fly');
// add and remove a layer through the panel
const nl0 = await page.evaluate(() => window.__fw.app.state.shot.layers.length);
await clickText('.lil-controller.lil-function', '+ add layer');
const nl1 = await page.evaluate(() => window.__fw.app.state.shot.layers.length);
await page.evaluate(() => { const t = [...document.querySelectorAll('.lil-title')].filter((e) => /^\d+\./.test(e.textContent)).pop(); t.click(); });
await sleep(900);   // folder open animation
await clickText('.lil-controller.lil-function', 'remove layer', nl1 - 1);
const nl2 = await page.evaluate(() => window.__fw.app.state.shot.layers.length);
ui.layers = [nl0, nl1, nl2];
report.measurements.ui = ui;
check('ui_save_still_button', ui.stills.length >= 1, { stills: ui.stills });
check('ui_export_button', ui.export_files.includes('ui_export.mov') && ui.png_count === 24, { files: ui.export_files, png: ui.png_count });
check('ui_orbit_and_dolly', ui.orbit_moved > 1 && ui.dolly_moved > 1, { orbit: ui.orbit_moved, dolly: ui.dolly_moved });
check('ui_fly_mode_edit_preserves_rotation', ui.fly_moved_with_W > 1 && Math.abs(ui.fly_x_after_edit - 123) < 0.5 && ui.fly_quat_dot > 0.9999, { moved: ui.fly_moved_with_W, x: ui.fly_x_after_edit, quat_dot: ui.fly_quat_dot });
check('ui_add_remove_layer', nl1 === nl0 + 1 && nl2 === nl0, { layers: ui.layers });

// ---- saved camera presets and finale presets through the REAL UI (persisted on disk), including a page reload ----
const PRE = PRESETS_DIR;
const apiPost = (route, body) => fetch(`${URL_}__presets/${route}`, { method: 'POST', headers: { 'X-FW-Export': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
for (const n of ['verify_cam_A']) await apiPost('cameras/delete', { name: n });
for (const n of ['verify_finale_A']) await apiPost('finales/delete', { name: n });
const reload = async () => { await page.reload(); await page.waitForFunction(() => window.__fw); await sleep(1500); };
// element inside a named folder: returns its centre (and tags a <select> so puppeteer can choose an option)
const inFolder = (folder, name, what) => page.evaluate((folder, name, what) => {
  const t = [...document.querySelectorAll('.lil-title')].find((e) => e.textContent.trim() === folder); if (!t) return null;
  const root = t.parentElement, c = [...root.querySelectorAll('.lil-controller')].find((e) => (e.querySelector('.lil-name')?.textContent || '').trim().startsWith(name));
  if (!c) return null; const el = what === 'select' ? c.querySelector('select') : what === 'input' ? (c.querySelector('input[type=text]') || c.querySelector('input')) : c;
  el.scrollIntoView({ block: 'center' }); if (what === 'select') el.id = 'fw-test-select';
  const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}, folder, name, what);
const openFolder = async (title) => { const closed = await page.evaluate((t) => { const e = [...document.querySelectorAll('.lil-title')].find((x) => x.textContent.trim() === t); return !!e && e.parentElement.classList.contains('lil-closed'); }, title); if (closed) { const b = await page.evaluate((t) => { const e = [...document.querySelectorAll('.lil-title')].find((x) => x.textContent.trim() === t); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, title); await page.mouse.click(b.x, b.y); await sleep(700); } };
const clickIn = async (folder, name) => { const b = await inFolder(folder, name, 'button'); if (!b) throw new Error(`UI control not found: ${folder} / ${name}`); await page.mouse.click(b.x, b.y); await sleep(700); };
const typeIn = async (folder, name, text) => { const b = await inFolder(folder, name, 'input'); if (!b) throw new Error(`UI field not found: ${folder} / ${name}`); await page.mouse.click(b.x, b.y); await page.evaluate(() => document.activeElement.select()); await page.keyboard.type(text); await page.keyboard.press('Tab'); await sleep(300); };
const chooseIn = async (folder, name, value) => { const b = await inFolder(folder, name, 'select'); if (!b) throw new Error(`UI dropdown not found: ${folder} / ${name}`); await page.select('#fw-test-select', value); await sleep(300); };
const readCams = () => { try { return JSON.parse(fs.readFileSync(path.join(PRE, 'cameras.json'), 'utf8')).presets || {}; } catch { return {}; } };
const frameHash = () => page.evaluate(() => { const g = window.__fw.grab({ width: 960, height: 540 }); return g.dataUrl; }).then((u) => crypto.createHash('sha256').update(u).digest('hex'));
const setCam = (c) => page.evaluate((c) => { window.__fw.setCamera(c); }, c);
const prepareShot = () => page.evaluate(() => { window.__fw.loadShot({ seed: 12, layers: [{ id: 1, type: 'peony', palette: 'Red' }, { id: 2, type: 'willow', delay: 0.2 }] }); window.__fw.stepTo(8.0); });
await reload(); await prepareShot();
await setCam({ position: [37, 12, 431], target: [5, 150, -10], focal: 70 });
const camA = await frameHash();
await typeIn('Saved camera presets', 'name', 'verify_cam_A');
await clickIn('Saved camera presets', 'Save camera preset');
const savedCam = readCams().verify_cam_A;
await reload(); await prepareShot();
const defaultHash = await frameHash();
await chooseIn('Saved camera presets', 'saved presets', 'verify_cam_A'); await clickIn('Saved camera presets', 'Load');
const loadedHash = await frameHash();
check('camera_preset_save_reload_load_identical_frame', !!savedCam && camA === loadedHash && defaultHash !== camA, { saved_on_disk: !!savedCam, identical_frame_after_reload_and_load: camA === loadedHash, default_view_differs: defaultHash !== camA, file: 'presets/cameras.json' });
await setCam({ position: [-60, 30, 380], target: [0, 140, 0], focal: 45 });
const camB = await frameHash();
await clickIn('Saved camera presets', 'Update'); const updated = readCams().verify_cam_A;
await setCam({ position: [90, 40, 300], target: [0, 150, 0], focal: 30 });   // move away, then Load WITHOUT reloading the page: must give the updated view
await chooseIn('Saved camera presets', 'saved presets', 'verify_cam_A'); await clickIn('Saved camera presets', 'Load');
const loadedNoReload = await frameHash();
check('camera_preset_update_then_load_without_reload', loadedNoReload === camB, { returns_updated_view: loadedNoReload === camB });
await reload(); await prepareShot(); await chooseIn('Saved camera presets', 'saved presets', 'verify_cam_A'); await clickIn('Saved camera presets', 'Load');
const loadedB = await frameHash();
check('camera_preset_update', !!updated && JSON.stringify(updated.position) !== JSON.stringify(savedCam?.position) && loadedB === camB, { position_on_disk_changed: JSON.stringify(updated?.position) !== JSON.stringify(savedCam?.position), loads_updated_view: loadedB === camB });
await chooseIn('Saved camera presets', 'saved presets', 'verify_cam_A'); await clickIn('Saved camera presets', 'Delete');
check('camera_preset_delete', !readCams().verify_cam_A, { still_on_disk: !!readCams().verify_cam_A });

// finale presets: load a built-in, edit, save, reload, load, update, delete
const finDir = path.join(PRE, 'finales');
await reload();
await page.evaluate(() => { const c = [...document.querySelectorAll('.lil-controller')].find((e) => (e.querySelector('.lil-name')?.textContent || '').trim() === 'Grand finale'); c.scrollIntoView({ block: 'center' }); });
{ const b = await page.evaluate(() => { const c = [...document.querySelectorAll('.lil-controller')].find((e) => (e.querySelector('.lil-name')?.textContent || '').trim() === 'Grand finale'); const r = c.querySelector('input').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }); await page.mouse.click(b.x, b.y); await sleep(800); }
await openFolder('Grand finale'); await openFolder('Finale presets');
await chooseIn('Finale presets', 'preset', '[built-in] Rapid barrage (9 s)'); await clickIn('Finale presets', 'Load finale preset');
const loadedBuiltin = await page.evaluate(() => { const s = window.__fw.snapshot(); return { enabled: s.finale.enabled, layers: s.layers.length, total: s.finale.totalTime }; });
await typeIn('Grand finale', 'total time', '7');
await typeIn('Finale presets', 'name', 'verify_finale_A');
await clickIn('Finale presets', 'Save finale preset');
const expected = await page.evaluate(() => JSON.stringify(window.__fw.snapshot()));
const fileA = path.join(finDir, 'verify_finale_A.json'), onDisk = () => { try { return JSON.parse(fs.readFileSync(fileA, 'utf8')).data; } catch { return null; } };
const savedFinale = onDisk();
await reload();
{ const b = await page.evaluate(() => { const c = [...document.querySelectorAll('.lil-controller')].find((e) => (e.querySelector('.lil-name')?.textContent || '').trim() === 'Grand finale'); c.scrollIntoView({ block: 'center' }); const r = c.querySelector('input').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }); await page.mouse.click(b.x, b.y); await sleep(800); }
await openFolder('Grand finale'); await openFolder('Finale presets');
await chooseIn('Finale presets', 'preset', 'verify_finale_A'); await clickIn('Finale presets', 'Load finale preset');
const roundTrip = await page.evaluate(() => JSON.stringify(window.__fw.snapshot()));
check('finale_preset_ui_roundtrip_whole_shot', loadedBuiltin.enabled && loadedBuiltin.layers === 4 && !!savedFinale && savedFinale.finale.totalTime === 7 && roundTrip === expected, { builtin_loaded: loadedBuiltin, saved_total_time_on_disk: savedFinale?.finale.totalTime, identical_after_reload_and_load: roundTrip === expected, file: 'presets/finales/verify_finale_A.json' });
await typeIn('Grand finale', 'spread X', '111'); await clickIn('Finale presets', 'Update selected preset');
const afterUpdate = onDisk();
await typeIn('Grand finale', 'spread X', '222'); await clickIn('Finale presets', 'Load finale preset');   // no reload: Load must give the UPDATED contents
const noReloadSpread = await page.evaluate(() => window.__fw.snapshot().finale.spreadX);
check('finale_preset_update_then_load_without_reload', noReloadSpread === 111, { spread_x_after_load: noReloadSpread, expected: 111 });
await reload();
{ const b = await page.evaluate(() => { const c = [...document.querySelectorAll('.lil-controller')].find((e) => (e.querySelector('.lil-name')?.textContent || '').trim() === 'Grand finale'); c.scrollIntoView({ block: 'center' }); const r = c.querySelector('input').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }); await page.mouse.click(b.x, b.y); await sleep(800); }
await openFolder('Grand finale'); await openFolder('Finale presets');
await chooseIn('Finale presets', 'preset', 'verify_finale_A'); await clickIn('Finale presets', 'Load finale preset');
const updatedSpread = await page.evaluate(() => window.__fw.snapshot().finale.spreadX);
check('finale_preset_ui_update', afterUpdate?.finale.spreadX === 111 && updatedSpread === 111, { on_disk: afterUpdate?.finale.spreadX, after_reload_and_load: updatedSpread });
// the Grand finale toggle must still work after a preset was loaded (it used to stay bound to a replaced object)
{ const b = await page.evaluate(() => { const c = [...document.querySelectorAll('.lil-controller')].find((e) => (e.querySelector('.lil-name')?.textContent || '').trim() === 'Grand finale'); c.scrollIntoView({ block: 'center' }); const r = c.querySelector('input').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }); await page.mouse.click(b.x, b.y); await sleep(800); }
await clickIn('Shot', 'Fire / Replay');
const afterToggle = await page.evaluate(() => ({ enabled: window.__fw.app.state.shot.finale.enabled, plan: window.__fw.app.world.launchPlan.length }));
check('grand_finale_toggle_works_after_preset_load_via_real_ui', afterToggle.enabled === false && afterToggle.plan === 1, afterToggle);
{ const b = await page.evaluate(() => { const c = [...document.querySelectorAll('.lil-controller')].find((e) => (e.querySelector('.lil-name')?.textContent || '').trim() === 'Grand finale'); const r = c.querySelector('input').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }); await page.mouse.click(b.x, b.y); await sleep(800); }
await openFolder('Grand finale'); await openFolder('Finale presets');
// saving under an existing name (differing only in case) asks for confirmation and overwrites that preset, not a second file
const dialogsBefore = dialogs.length;
await typeIn('Finale presets', 'name', 'VERIFY_finale_a'); await clickIn('Finale presets', 'Save finale preset');
const sameFiles = fs.existsSync(finDir) ? fs.readdirSync(finDir).filter((f) => f.toLowerCase() === 'verify_finale_a.json') : [];
check('preset_save_over_existing_name_asks_and_overwrites_same_file', dialogs.length === dialogsBefore + 1 && /already exists/.test(dialogs.at(-1)) && sameFiles.length === 1 && sameFiles[0] === 'verify_finale_A.json', { dialog: dialogs.at(-1), files: sameFiles });
await chooseIn('Finale presets', 'preset', 'verify_finale_A');
await clickIn('Finale presets', 'Delete selected preset');
check('finale_preset_ui_delete', !fs.existsSync(fileA), { file_exists: fs.existsSync(fileA), built_in_presets_are_in_code_not_on_disk: !fs.existsSync(path.join(finDir, 'Rapid barrage (9 s).json')) });

// ---- preset API: access control, corrupt files, name sanitising, validation (against the isolated presets folder) ----
const api = async (method, route, body) => { const r = await fetch(`${URL_}__presets/${route}`, { method, headers: { 'X-FW-Export': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const cam0 = { position: [0, 1, 2], focal: 50 };
const forbidden = { get_no_header: await call('GET', '/__presets/cameras'), post_no_header: await call('POST', '/__presets/cameras'), get_foreign_origin: await call('GET', '/__presets/cameras', { 'X-FW-Export': '1', Origin: 'http://evil.example' }), post_null_origin: await call('POST', '/__presets/finales', { 'X-FW-Export': '1', Origin: 'null' }), delete_no_header: await call('POST', '/__presets/cameras/delete') };
check('preset_routes_forbidden_without_header_or_with_foreign_origin', Object.values(forbidden).every((c) => c === 403) && (await api('GET', 'cameras')).status === 200, forbidden);
const camFile = path.join(PRESETS_DIR, 'cameras.json'), badFiles = (dir, prefix) => fs.readdirSync(dir).filter((f) => f.startsWith(prefix));
await api('POST', 'cameras', { name: 'verify_keep', preset: cam0 });
fs.writeFileSync(camFile, '{ this is not json');
const g1 = await api('GET', 'cameras'), bad1 = badFiles(PRESETS_DIR, 'cameras.json.bad-');
const keptBytes = bad1.length === 1 && fs.readFileSync(path.join(PRESETS_DIR, bad1[0]), 'utf8') === '{ this is not json';
const afterCorrupt = await api('POST', 'cameras', { name: 'verify_after_corrupt', preset: cam0 });
const savedAfterCorrupt = JSON.parse(fs.readFileSync(camFile, 'utf8')).presets.verify_after_corrupt;
fs.writeFileSync(camFile, 'null');
const g2 = await api('GET', 'cameras');
fs.mkdirSync(path.join(PRESETS_DIR, 'finales'), { recursive: true }); fs.writeFileSync(path.join(PRESETS_DIR, 'finales', 'verify_bad.json'), 'xx');
const g3 = await api('GET', 'finales');
const corrupt = { corrupt_get_status: g1.status, notice: g1.json.notice, backup_has_original_bytes: keptBytes, save_after_corrupt: afterCorrupt.status, null_root_get_status: g2.status, null_root_notice: !!g2.json.notice, backups_after_null: badFiles(PRESETS_DIR, 'cameras.json.bad-').length, finale_corrupt_notice: !!g3.json.notice, finale_backup: badFiles(path.join(PRESETS_DIR, 'finales'), 'verify_bad.json.bad-').length, finale_listed: 'verify_bad' in (g3.json.presets || {}) };
check('corrupt_preset_files_are_backed_up_never_overwritten', g1.status === 200 && /could not be read/.test(g1.json.notice || '') && keptBytes && afterCorrupt.status === 200 && !!savedAfterCorrupt && g2.status === 200 && corrupt.null_root_notice && corrupt.backups_after_null === 2 && corrupt.finale_corrupt_notice && corrupt.finale_backup === 1 && !corrupt.finale_listed, corrupt);
const nm = async (name, extra = {}) => (await api('POST', 'cameras', { name, preset: cam0, ...extra }));
const names = (await api('GET', 'cameras')).json.presets;
const s1 = await nm('. .x'), s2a = await nm('ÄÖÜ'), s2b = await nm('ÖÄÜ'), s3 = await nm('???'), s4 = await nm('a'.repeat(61)), s5 = await nm('a'.repeat(60)), s5b = await nm('a'.repeat(59) + 'b');
const c1 = await nm('Foo'), c2 = await nm('foo'), c3 = await nm('foo', { overwrite: true }), after = (await api('GET', 'cameras')).json.presets;
const san = { hidden_name_saved_as: s1.json.name, unicode_distinct: s2a.status === 200 && s2b.status === 200 && s2a.json.name !== s2b.json.name, only_symbols: s3.status, too_long: s4.status, max_length_ok: s5.status, long_names_distinct: s5b.status === 200 && s5.json.name !== s5b.json.name, case_collision_status: c2.status, overwrite_status: c3.status, keys_after: Object.keys(after).filter((k) => k.toLowerCase() === 'foo') };
check('preset_name_sanitiser', san.hidden_name_saved_as === 'x' && san.unicode_distinct && san.only_symbols === 400 && san.too_long === 400 && san.max_length_ok === 200 && san.long_names_distinct && c1.status === 200 && san.case_collision_status === 409 && san.overwrite_status === 200 && san.keys_after.length === 1 && san.keys_after[0] === 'Foo' && Object.keys(names).length >= 0, san);
const bad = { focal_0: (await nm('v_f0', { preset: { ...cam0, focal: 0 } })).status, focal_negative: (await nm('v_f1', { preset: { ...cam0, focal: -5 } })).status, focal_null: (await nm('v_f2', { preset: { ...cam0, focal: null } })).status, position_null: (await nm('v_p', { preset: { ...cam0, position: [0, null, 2] } })).status, quaternion_null: (await nm('v_q', { preset: { ...cam0, quaternion: [0, 0, 0, null] } })).status, focal_huge: (await nm('v_f3', { preset: { ...cam0, focal: 1e9 } })).status, valid: (await nm('v_ok')).status };
check('camera_preset_validation_rejects_bad_values', bad.focal_0 === 400 && bad.focal_negative === 400 && bad.focal_null === 400 && bad.position_null === 400 && bad.quaternion_null === 400 && bad.focal_huge === 400 && bad.valid === 200, bad);

check('no_page_errors', errors.length === 0, { errors });

// 13. half-float fallback path (used when EXT_color_buffer_float is missing): same frame must match the float path
const halfPage = await browser.newPage(); await halfPage.setViewport({ width: 1400, height: 800 });
await halfPage.goto(URL_ + '?half=1'); await halfPage.waitForFunction(() => window.__fw);
const frameStat = (pg) => pg.evaluate(() => { const fw = window.__fw; fw.setCamera({ view: 'Default' }); for (const k of ['stars', 'trails', 'smoke', 'flash', 'glow', 'launch']) fw.setToggle(k, true); fw.loadShot({ seed: 4242, launch: true, layers: [{ type: 'chrysanthemum', palette: 'Green' }] }, { slow: true }); fw.stepTo(8.0); const g = fw.grab({ width: 1280, height: 720, stats: true }); return g.meanValue; });
const floatPage = await browser.newPage(); await floatPage.setViewport({ width: 1400, height: 800 }); await floatPage.goto(URL_); await floatPage.waitForFunction(() => window.__fw);   // fresh pages so earlier UI interactions cannot change the state
const meanFloat = await frameStat(floatPage), meanHalf = await frameStat(halfPage);
await floatPage.close();
const halfFinal = await halfPage.evaluate(() => window.__fw.app.renderer.finalFloat);
check('half_float_fallback_matches_float_path', halfFinal === false && Math.abs(meanHalf - meanFloat) / meanFloat < 0.01, { mean_float: meanFloat, mean_half: meanHalf, half_path_active: halfFinal === false });
await halfPage.close();
await browser.close();

// 14. first-run experience in a normal headed Chrome (default flags, DPR 2) against a FRESH server (Vite cache deleted)
const stopServer = async () => { if (server) { server.kill(); for (let i = 0; i < 40 && (await up()); i++) await sleep(250); } };
const startFresh = async () => { fs.rmSync(path.join(ROOT, 'node_modules', '.vite'), { recursive: true, force: true }); server = await startServer(); };
await stopServer(); await startFresh();
report.firstRun = { server: 'fresh vite started after deleting node_modules/.vite' };
const nonBlackPixels = (file) => {   // brightness > 100/255 in the canvas area (left of the 330 px panel), via ffmpeg, from the real screenshot
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-vf', 'crop=iw-700:ih:0:0,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
  let n = 0; for (const v of r.stdout) if (v > 100) n++; return n;
};
for (const host of ['127.0.0.1', 'localhost']) {
  const hb = await puppeteer.launch({ executablePath: CHROME, headless: false, defaultViewport: null, args: ['--window-size=1728,1117'] });   // no GPU flags
  const hp = await hb.newPage(); await hp.setViewport({ width: 1728, height: 1117, deviceScaleFactor: 2 });
  const herr = [];
  hp.on('pageerror', (e) => herr.push(e.message));
  hp.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) herr.push(m.text()); });
  await hp.goto(`http://${host}:${PORT}/`, { waitUntil: 'load' }); await sleep(4500);
  const shot = path.join(OUT, `headed_default_flags_dpr2_${host.replace(/\./g, '_')}.png`);
  await hp.screenshot({ path: shot });
  const dom = await hp.evaluate(() => ({ panel: !!document.querySelector('.lil-gui'), hud: document.getElementById('hud').textContent, overlay: document.getElementById('fw-error')?.textContent || '' }));
  const px = nonBlackPixels(shot);
  report.firstRun[host] = { panel: dom.panel, hud: dom.hud.slice(0, 80), errors: herr, non_black_pixels: px };
  check(`headed_chrome_default_flags_dpr2_${host.replace(/\./g, '_')}`, dom.panel && dom.hud.trim().length > 0 && dom.overlay === '' && herr.length === 0 && px > 500, report.firstRun[host]);
  await hb.close();
}
// a startup failure must be visible, never a blank page: Chrome with GPU disabled has no WebGL
{
  const hb = await puppeteer.launch({ executablePath: CHROME, headless: false, defaultViewport: null, args: ['--window-size=1400,900', '--disable-gpu'] });
  const hp = await hb.newPage(); await hp.goto(URL_, { waitUntil: 'load' }); await sleep(2500);
  const dom = await hp.evaluate(() => ({ panel: !!document.querySelector('.lil-gui'), hud: document.getElementById('hud').textContent, overlay: document.getElementById('fw-error')?.textContent || '' }));
  await hp.screenshot({ path: path.join(OUT, 'startup_failure_visible_no_webgl.png') });
  check('startup_failure_is_visible_and_panel_still_built', /WebGL/.test(dom.overlay) && /hardware acceleration/i.test(dom.overlay) && dom.panel, { overlay: dom.overlay.slice(0, 160), panel: dom.panel });
  await hb.close();
}

report.summary = { passed: Object.values(report.checks).filter((c) => c.pass).length, total: Object.keys(report.checks).length };
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
if (server) server.kill();
process.exit(report.summary.passed === report.summary.total ? 0 : 1);
