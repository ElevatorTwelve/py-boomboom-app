import * as THREE from 'three';
import { FWRenderer } from './render/renderer.js';
import { World } from './sim/world.js';
import { CameraRig } from './ui/camera.js';
import { buildPanel } from './ui/panel.js';
import { state, loadPreset, applyShot, shotSnapshot, VIEWS } from './state.js';
import { runExport, saveStill, toU16, AUTO_CAP_SECONDS } from './export/exporter.js';
import { estimateExport, estimateBytes } from './sim/estimate.js';
import { PRESETS, TYPES } from './library/index.js';
import { FINALE_PRESETS } from './library/finales.js';
import { poseAt, hasCamera, snapshotCamera, fovOfFocal } from './camera/path.js';
import './ui/pyb.css';
import { buildDeck } from './ui/dials.js';
import { buildTransport } from './ui/transport.js';
import { buildHistory } from './ui/history.js';
import { buildGallery } from './ui/gallery.js';
import { buildHotkeys } from './ui/hotkeys.js';
import { buildViewMenu } from './ui/viewMenu.js';

const canvas = document.getElementById('view');
const hud = document.getElementById('hud');
const HINT_GPU = 'Enable hardware acceleration (Chrome: Settings > System > "Use graphics acceleration when available", then restart Chrome; chrome://gpu must show "WebGL2: Hardware accelerated"), update your GPU drivers/browser, or try another current browser.';
const fail = (title, detail, hint) => window.__fwShowError?.(title, detail, hint);
let renderer = null;
try {
  renderer = new FWRenderer(canvas);
  renderer.gl.debug.onShaderError = (g, program, vs, fs) => fail('A shader failed to compile or link', `${g.getShaderInfoLog(vs) || ''}\n${g.getShaderInfoLog(fs) || ''}\n${g.getProgramInfoLog(program) || ''}`.trim(), HINT_GPU);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); fail('The WebGL context was lost', 'The GPU driver reset or the tab ran out of GPU memory.', 'Reload the page. If it keeps happening, lower the window size or close other GPU-heavy tabs.'); });
} catch (e) {
  fail('Could not start the WebGL2 renderer', String(e.message || e), HINT_GPU);   // the control panel is still built below
}
const world = new World();
const rig = new CameraRig(canvas);
const overlay = buildOverlay();

const app = {
  renderer, world, rig, state, overlay,
  playhead: 0, playing: true, gap: 0, exporting: false, abort: null, camEdit: { pending: false, at: 0 },
  currentSeed: () => state.seed >>> 0,
  shotForWorld: () => JSON.parse(JSON.stringify(state.shot)),
  // Camera animation. Output time = playhead / timeScale. Export and stills use it whenever it exists, whatever the view is.
  cameraSnapshot: () => snapshotCamera(state.camera),
  cameraNow: () => poseAt(state.camera, app.playhead / state.physics.timeScale),
  fire() {
    world.reset(app.currentSeed(), app.shotForWorld(), state.physics);
    app.playhead = 0; app.playing = true; app.gap = 0;
  },
  // Fire, but start `lead` seconds before the first burst (used on page load so the screen is never empty)
  fireLead(lead) {
    app.fire();
    while (world.burstLog.length === 0 && !world.finished && world.t < 60) world.step();   // find the first burst
    const tb = world.burstLog[0] ? world.burstLog[0].t : 0;
    app.fire();
    world.advanceTo(Math.max(0, tb - lead)); app.playhead = world.t;
  },
  notify(text) {   // short status line at the top of the page (preset saved / loaded, errors)
    const box = document.getElementById('progress'); box.textContent = text; box.style.display = 'block';
    clearTimeout(app.notifyTimer); app.notifyTimer = setTimeout(() => { if (!app.exporting) box.style.display = 'none'; }, 5000);
  },
  async exportNow(over) {
    if (!renderer) throw new Error('No WebGL renderer is available');
    if (app.exporting) throw new Error('export already running');
    app.exporting = true; app.abort = new AbortController();
    const box = document.getElementById('progress'); box.style.display = 'block';
    try {
      const r = await runExport(app, over, (p) => {
        box.textContent = `Exporting frame ${p.frame}${p.total ? ' / ' + p.total : ''}  (${p.elapsed.toFixed(0)} s)`;
        app.progress = p;
      }, app.abort.signal);
      const warn = [];
      if (r.hitCap) warn.push(`STOPPED AT THE ${AUTO_CAP_SECONDS} s CAP before everything had died out`);
      if (r.overflow) warn.push(`${r.overflow} light particles did not fit the pool and were dropped`);
      if (r.overflowSmoke) warn.push(`${r.overflowSmoke} smoke puffs did not fit the pool and were dropped`);
      if (r.dropped) warn.push(`${r.dropped} instances did not fit the render buffers and were dropped`);
      box.textContent = `Export done: ${r.dir} (${r.frames} frames, ${r.seconds.toFixed(1)} s)` + (warn.length ? '\nWARNING: ' + warn.join('; ') : '');
      if (warn.length) app.keepProgress = true;
      return r;
    } catch (e) {
      box.textContent = e.message === 'cancelled' ? 'Export cancelled' : 'Export failed: ' + e.message;
      throw e;
    } finally {
      app.exporting = false; setTimeout(() => { if (!app.keepProgress) box.style.display = 'none'; app.keepProgress = false; }, 6000);
      app.fire();
    }
  },
  cancelExport() { app.abort?.abort(); },
  // Estimated length, frames and size of the export that the current settings would produce
  estimateExport() {
    const E = state.export, est = estimateExport(app.shotForWorld(), state.physics, E.fps);
    const seconds = E.duration > 0 ? E.duration : Math.min(est.seconds, AUTO_CAP_SECONDS), frames = Math.round(seconds * E.fps);
    const b = estimateBytes(E.width, E.height, frames, { 'ProRes 4444 + PNG': 'both', 'ProRes 4444 (.mov)': 'prores', 'PNG sequence (16-bit)': 'png' }[E.format] || 'both');
    return { seconds, frames, bytes: b.prores + b.png, prores: b.prores, png: b.png, capped: E.duration <= 0 && est.seconds > AUTO_CAP_SECONDS };
  },
  // Export button: estimate first, and ask for confirmation when the export is large
  async exportFromUI() {
    const e = app.estimateExport(), gb = (v) => (v / 1e9).toFixed(v > 1e10 ? 0 : 1);
    const text = `Estimated export: ${e.seconds.toFixed(0)} s, ${e.frames} frames, up to ~${gb(e.bytes)} GB on disk` + (e.capped ? ` (the ${AUTO_CAP_SECONDS} s cap will cut it short)` : '') + '.';
    if ((e.bytes > 2e9 || e.seconds > 120 || e.frames > 5000) && !window.confirm(text + '\n\nStart the export?')) return null;
    app.notify(text);
    return app.exportNow();
  },
  async still() {
    if (app.exporting || !renderer) return null;
    const box = document.getElementById('progress'); box.style.display = 'block';
    try { const r = await saveStill(app); box.textContent = 'Saved ' + r.file; return r; }
    catch (e) { box.textContent = 'Still failed: ' + e.message; throw e; }
    finally { setTimeout(() => { box.style.display = 'none'; }, 5000); }
  },
};

buildPanel(app);
const prevTick = app.onTick;
app.onTick = () => { prevTick?.(); app.updateDeck?.(); };
buildDeck(app);
const transport = buildTransport(app);
app.seek = (t) => transport.seek(t);
Object.defineProperty(app, 'transportLength', { get: () => transport.length });
buildHistory(app);
buildGallery(app);
buildHotkeys(app);
buildViewMenu(app);

function buildOverlay() {
  const sc = new THREE.Scene();
  const pts = [];
  for (let i = -10; i <= 10; i++) {
    const v = i * 50;
    pts.push(-500, 0, v, 500, 0, v, v, 0, -500, v, 0, 500);
  }
  pts.push(0, 0, 0, 0, 260, 0);                       // vertical scale pole at the launch point
  for (let y = 50; y <= 250; y += 50) pts.push(-6, y, 0, 6, y, 0);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x2a5a8a, transparent: true, opacity: 0.55, depthTest: false }));
  sc.add(lines);
  return sc;
}

function resize() {
  if (!renderer) return [innerWidth, innerHeight];
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
  const cap = 2600 * 1500; if (w * h > cap) { const s = Math.sqrt(cap / (w * h)); w = Math.round(w * s); h = Math.round(h * s); }
  renderer.gl.setPixelRatio(1); renderer.gl.setSize(w, h, false);
  return [w, h];
}
let size = resize();
addEventListener('resize', () => { size = resize(); });

function previewSamples() {
  const fps = state.export.fps, ts = state.physics.timeScale;
  const S = state.render.shutterAngle / 360 / fps * ts;
  return [[app.playhead, app.playhead + S]];
}

// Where the export frame sits on the screen (CSS px). With "fit" it is the largest frame of the export shape that fits the free area
// (left of the panel, above the bottom bar), so everything inside it is exported and everything outside is not. Without it the frame spans the window height.
function frameRect() {
  const asp = state.export.width / state.export.height;
  if (!state.elements.fit) { const fh = innerHeight; return { cx: innerWidth / 2, cy: innerHeight / 2, fw: fh * asp, fh }; }
  const gui = document.querySelector('.lil-gui.lil-root'), dock = document.querySelector('.pyb-dock');
  const gr = gui && gui.getBoundingClientRect();
  const right = gr && gr.width > 0 ? Math.min(innerWidth, gr.left) : innerWidth;
  const dr = dock && dock.getBoundingClientRect();
  const bottom = dr && dr.height > 0 ? Math.min(innerHeight, dr.top) - 10 : innerHeight - 10;   // a hidden bottom bar leaves the room free
  const left = 12, top = 74, aw = Math.max(120, right - left - 14), ah = Math.max(120, bottom - top);
  const fh = Math.min(ah, aw / asp) * 0.97;
  return { cx: left + aw / 2, cy: top + ah / 2, fw: fh * asp, fh };
}

// The preview camera: the shot camera with a wider view when the frame is fitted into the window, so the frame is the exact export view.
function previewCamera(w, h) {
  if (!state.elements.fit) return { cam: rig.camera, frameH: h };
  const fr = frameRect(), sx = w / innerWidth, sy = h / innerHeight, k = innerHeight / fr.fh;
  const cam = rig.camera.clone(); cam.aspect = w / h;
  cam.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(rig.camera.fov) / 2) * k));
  cam.setViewOffset(w, h, w / 2 - fr.cx * sx, h / 2 - fr.cy * sy, w, h);
  cam.updateProjectionMatrix(); cam.updateMatrixWorld();
  return { cam, frameH: fr.fh * sy };
}

function drawPreview() {
  if (app.exporting || !renderer) return;
  const [w, h] = size, pv = previewCamera(w, h);
  renderer.render(world, pv.cam, {
    width: w, height: h, frameH: pv.frameH, samples: previewSamples(), el: state.elements, rp: state.render, target: 'screen', alpha: 'black',
    overlay: state.elements.grid ? overlay : null,
    lod: Math.max(1, Math.ceil(world.nL / 150000)),   // preview only: thin out sparks (brightened to compensate) when the scene is huge
  });
  updateGuide();
}

function updateGuide() {
  const g = document.getElementById('guide');
  const on = state.elements.guide || state.elements.safe;   // the safe lines need the frame edge, so they show it too
  g.style.display = on ? 'block' : 'none';
  g.classList.toggle('edge', !!on);
  if (!g.firstChild) g.innerHTML = '<div class="pyb-safe action"><span>action safe 90%</span></div><div class="pyb-safe title"><span>title safe 80%</span></div><div class="pyb-frame-label">export frame</div>';
  g.classList.toggle('safe', !!state.elements.safe);
  const lab = g.querySelector('.pyb-frame-label');
  if (lab) lab.textContent = !hasCamera(state.camera) ? 'export frame' : state.camera.view === 'shot' ? (app.camEdit.pending ? 'export frame - camera edit not keyed (press K)' : 'export frame (shot camera)') : 'frame of this free view - export uses the camera keys';
  const fr = frameRect();
  Object.assign(g.style, { height: fr.fh + 'px', width: fr.fw + 'px', left: fr.cx - fr.fw / 2 + 'px', top: fr.cy - fr.fh / 2 + 'px', boxSizing: 'border-box' });
}

let last = performance.now(), hudT = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  rig.update(dt);
  // Camera view with a camera animation: the camera follows it, unless the user is moving it or has an edit that is not keyed yet.
  if (app.camEdit.pending && (app.playing || Math.abs(app.playhead - app.camEdit.at) > 1e-9)) app.camEdit.pending = false;
  if (state.camera.view === 'shot' && hasCamera(state.camera) && !rig.interacting && !app.camEdit.pending) rig.drive(app.cameraNow());
  transport.tick();
  if (app.playing && !app.exporting) {
    app.playhead += dt * state.physics.timeScale;
    if (world.finished && state.loop) { app.gap += dt; if (app.gap > 1.2) app.fire(); }
  }
  try { drawPreview(); } catch (e) { fail('Rendering failed', String(e.stack || e.message || e), HINT_GPU); }
  hudT += dt;
  if (hudT > 0.25) {
    hudT = 0; const s = world.stats();
    hud.textContent = `t ${s.time.toFixed(2)} s   stars ${s.stars}  sparks ${s.sparks + s.tail}  smoke ${s.smoke}   ${(1 / Math.max(dt, 1e-3)).toFixed(0)} fps` + (s.overflow ? `\nWARNING: light pool full, ${s.overflow} particles dropped (reduce star counts / trails)` : '') + (s.overflowSmoke ? `\nWARNING: smoke pool full, ${s.overflowSmoke} puffs dropped` : '') + (renderer && renderer.prep.dropped ? `\nWARNING: ${renderer.prep.dropped} instances did not fit the render buffers` : '');
    app.onTick?.();
  }
  requestAnimationFrame(frame);
}
app.fireLead(1.0);   // first load: skip ahead so a burst is on screen within about a second
window.__fwStarted = true;
requestAnimationFrame(frame);

// ---- test / automation API ----------------------------------------------------------
const TOGGLE = { launchTrail: 'launch', launch: 'launch', stars: 'stars', trails: 'trails', sparks: 'trails', glow: 'glow', bloom: 'glow', smoke: 'smoke', flash: 'flash', grid: 'grid' };
window.__fw = {
  app, frameRect, blender: app.blender, camera: { poseAt: (t) => poseAt(state.camera, t), fovOfFocal }, seek: (t) => transport.seek(t),
  // opts.slow: layers without an explicit launchSpeed get 0.4 (every type then bursts at its apex, i.e. the pre-launch-speed timing); test hook
  loadShot(json, opts = {}) {
    const s = typeof json === 'string' ? JSON.parse(json) : json;
    if (opts.slow && s.layers) s.layers = s.layers.map((l) => ({ launchSpeed: 0.4, ...l }));
    if (s.physics) Object.assign(state.physics, s.physics);
    if (s.preset) loadPreset(s.preset);
    const r = applyShot(s, { reset: true });
    if (r.error) { app.notify(r.error); return r; }
    if (r.warnings.length) app.notify('Loaded with changes: ' + r.warnings.join('; '));
    app.refreshUI?.(); app.fire();
    return r;
  },
  fire() { app.fire(); },
  stepTo(sec) {
    if (sec < world.t - 1e-6) app.fire();
    app.playing = false; app.playhead = sec;
    world.advanceTo(sec + previewSamples()[0][1] - previewSamples()[0][0]);
    drawPreview();
  },
  setCamera(c) {
    if (c.view) rig.apply(VIEWS[c.view]);
    rig.apply({ position: c.position, target: c.target, focal: c.focal });
  },
  setToggle(name, v) { state.elements[TOGGLE[name] || name] = !!v; app.refreshUI?.(); },
  setRender(o) { Object.assign(state.render, o); app.refreshUI?.(); },
  setPhysics(o) { Object.assign(state.physics, o); },
  setExport(o) { Object.assign(state.export, o); },
  getStats() { return world.stats(); },
  snapshot: () => shotSnapshot(),
  estimate: () => app.estimateExport(),
  presets: () => Object.keys(PRESETS),
  finalePresets: () => Object.keys(FINALE_PRESETS),
  loadFinalePreset(name) { const r = applyShot(FINALE_PRESETS[name](), { reset: true }); state.shot.finale.enabled = true; app.refreshUI?.(); app.fire(); return r; },
  types: () => Object.keys(TYPES),
  info: () => renderer.info(),
  exportShot(opts) { return app.exportNow(opts); },
  // Radial glare profile around the brightest pixel at w x h: energy (display-linear) per annulus as a fraction of the
  // total within 0.5 frame heights. Radii are fractions of frame height, so the profile is comparable across resolutions.
  glareProfile(w, h) {
    const T = app.playhead, S = state.render.shutterAngle / 360 / state.export.fps * state.physics.timeScale;
    const cam = rig.camera.clone(); cam.aspect = w / h; cam.updateProjectionMatrix();
    const fin = renderer.render(world, cam, { width: w, height: h, samples: [[T, T + S]], el: state.elements, rp: state.render, target: 'float', alpha: 'black' });
    const f = renderer.readFloat(fin, new Float32Array(w * h * 4));
    const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    let best = -1, bx = 0, by = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, m = f[i] + f[i + 1] + f[i + 2]; if (m > best) { best = m; bx = x; by = y; } }
    // centre = energy centroid around the brightest pixel (a streaked star has no single peak pixel)
    let cx = 0, cy = 0, cm = 0; const R = Math.round(0.03 * h);
    for (let y = Math.max(0, by - R); y < Math.min(h, by + R); y++) for (let x = Math.max(0, bx - R); x < Math.min(w, bx + R); x++) { const i = (y * w + x) * 4, m = lin(f[i]) + lin(f[i + 1]) + lin(f[i + 2]); cx += m * x; cy += m * y; cm += m; }
    bx = cx / cm; by = cy / cm;
    const fr = [0.008, 0.016, 0.032, 0.064, 0.128, 0.256, 0.5], ann = new Float64Array(fr.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const r = Math.hypot(x - bx, y - by) / h; if (r >= 0.5) continue;
      let k = 0; while (r >= fr[k]) k++;
      const i = (y * w + x) * 4; ann[k] += lin(f[i]) + lin(f[i + 1]) + lin(f[i + 2]);
    }
    const tot = ann.reduce((a, v) => a + v, 0);
    return { radii: fr, fractions: Array.from(ann, (v) => v / tot), centre: [bx / w, by / h] };
  },
  // Render the current frame at w x h and at k times that size, box-downsample the large one and compare.
  parity(w = 1280, h = 720, k = 2) {
    const T = app.playhead, S = state.render.shutterAngle / 360 / state.export.fps * state.physics.timeScale;
    const draw = (W, H) => {
      const cam = rig.camera.clone(); cam.aspect = W / H; cam.updateProjectionMatrix();
      const fin = renderer.render(world, cam, { width: W, height: H, samples: [[T, T + S]], el: state.elements, rp: state.render, target: 'float', alpha: 'black' });
      return renderer.readFloat(fin, new Float32Array(W * H * 4)).slice();
    };
    const a = draw(w, h), b = draw(w * k, h * k), W2 = w * k;
    let sumA = 0, sumB = 0, sad = 0, sq = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
      let bv = 0;
      for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) bv += b[((y * k + dy) * W2 + x * k + dx) * 4 + c];
      bv /= k * k;
      const av = a[(y * w + x) * 4 + c];
      sumA += av; sumB += bv; sad += Math.abs(av - bv); sq += (av - bv) ** 2;
    }
    const n = w * h * 3;
    return { meanSmall: sumA / n, meanLargeDownsampled: sumB / n, meanAbsDiff: sad / n, relDiff: sad / Math.max(sumA, 1e-9), rmse: Math.sqrt(sq / n), energyRatio: sumB / Math.max(sumA, 1e-9) };
  },
  // Offscreen render of the current frame at a fixed size; returns an 8-bit PNG data URL (alpha composited on black)
  grab({ width = 1280, height = 720, samples = 1, alpha = 'black', stats = false } = {}) {
    const cam = rig.camera.clone(); cam.aspect = width / height; cam.updateProjectionMatrix();
    const S = state.render.shutterAngle / 360 / state.export.fps * state.physics.timeScale, T = app.playhead;
    const sm = []; for (let i = 0; i < samples; i++) sm.push([T + i * S / samples, T + (i + 1) * S / samples]);
    const fin = renderer.render(world, cam, { width, height, samples: sm, el: state.elements, rp: state.render, target: 'float', alpha });
    const f32 = renderer.readFloat(fin, new Float32Array(width * height * 4)), u16 = new Uint16Array(width * height * 4);
    toU16(f32, u16, width, height, alpha === 'black');
    const c = document.createElement('canvas'); c.width = width; c.height = height;
    const ctx = c.getContext('2d'), img = ctx.createImageData(width, height);
    let maxV = 0, sum = 0, sumA = 0, nzA = 0, bigA = 0;
    for (let i = 0; i < u16.length; i += 4) {
      img.data[i] = u16[i] >> 8; img.data[i + 1] = u16[i + 1] >> 8; img.data[i + 2] = u16[i + 2] >> 8; img.data[i + 3] = 255;
      if (stats) { const m = Math.max(u16[i], u16[i + 1], u16[i + 2]); if (m > maxV) maxV = m; sum += m; const a = u16[i + 3]; sumA += a; if (a > 0) nzA++; if (a > 655) bigA++; }
    }
    ctx.putImageData(img, 0, 0);
    const n = width * height;
    return { dataUrl: c.toDataURL('image/png'), maxValue: maxV / 65535, meanValue: sum / n / 65535, alphaMean: sumA / n / 65535, alphaNonzeroFrac: nzA / n, alphaOver1pctFrac: bigA / n };
  },
};
