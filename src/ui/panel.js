import GUI from 'lil-gui';
import { state } from '../state.js';
import { buildShotPanel } from './shotPanel.js';
import { buildCameraPanel } from './cameraPanel.js';
import { FORMATS, getFfmpeg } from '../export/exporter.js';
import { enableScrubbing } from './scrubby.js';

const RES = { '1920x1080': [1920, 1080], '3840x2160': [3840, 2160], '1080x1920 (vertical)': [1080, 1920], '1280x720': [1280, 720], Custom: null };

export function buildPanel(app) {
  const gui = new GUI({ title: 'PY-BoomBoom - plate generator', width: 330 });
  const refs = [];
  const track = (c) => { refs.push(c); return c; };

  buildShotPanel(gui, app, track);
  app.updateGui = () => refs.forEach((c) => c.updateDisplay());
  app.refreshUI = () => { refs.forEach((c) => c.updateDisplay()); app.rebuildShotUI?.(); app.camAnim?.rebuild(); };

  // ---- Physics ----
  const fPhys = gui.addFolder('Physics').close();
  const P = state.physics;
  [['burstVel', 'burst velocity', 0.3, 2], ['drag', 'air drag', 0.2, 3], ['gravity', 'gravity', 0, 2.5], ['spread', 'spread / jitter', 0, 4],
    ['windX', 'wind X (m/s)', -15, 15], ['windZ', 'wind Z (m/s)', -15, 15], ['turbulence', 'turbulence', 0, 6], ['lifetime', 'star lifetime', 0.3, 3],
    ['timeScale', 'time scale', 0.05, 3], ['smokeLife', 'smoke lifetime', 0.2, 3], ['smokeAmount', 'smoke amount', 0, 3]]
    .forEach(([k, n, a, b]) => track(fPhys.add(P, k, a, b, 0.01).name(n)));

  // ---- Elements ----
  const fEl = gui.addFolder('Elements');
  [['launch', 'launch trail'], ['stars', 'stars'], ['trails', 'star trails / sparks'], ['glow', 'glow / bloom'], ['smoke', 'smoke'], ['flash', 'burst flash'], ['grid', 'reference grid (preview only)'], ['guide', 'export frame guide (preview only)'], ['safe', 'title / action safe (preview only)'], ['fit', 'fit whole export frame in view (preview only)']]
    .forEach(([k, n]) => track(fEl.add(state.elements, k).name(n)));

  // ---- Look ----
  const fLook = gui.addFolder('Look');
  const R = state.render;
  [['exposure', 'exposure (EV)', -4, 4, 0.01], ['bloomStrength', 'bloom strength', 0, 1.5, 0.005], ['bloomRadius', 'bloom radius', 0, 1, 0.01], ['starGain', 'star brightness', 0.1, 5, 0.01],
    ['shutterAngle', 'shutter angle', 0, 360, 1], ['minStarSize', 'min star size (px)', 0.3, 3, 0.05], ['smokeDensity', 'smoke density', 0, 4, 0.01], ['smokeLight', 'smoke lighting', 0, 6, 0.01], ['smokeAmbient', 'smoke ambient / sky light', 0, 1, 0.001]]
    .forEach(([k, n, a, b, s]) => track(fLook.add(R, k, a, b, s).name(n)));

  buildCameraPanel(gui, app);

  // ---- Export ----
  const fEx = gui.addFolder('Export');
  const E = state.export;
  const wCtl = fEx.add(E, 'width', 64, 7680, 2), hCtl = fEx.add(E, 'height', 64, 4320, 2);
  fEx.add(E, 'preset', Object.keys(RES)).name('resolution').onChange((k) => { if (RES[k]) { [E.width, E.height] = RES[k]; wCtl.updateDisplay(); hCtl.updateDisplay(); } });
  fEx.add(E, 'fps', [24, 25, 30, 60]);
  fEx.add(E, 'duration', 0, 600, 0.5).name('duration (s, 0 = auto, max 600)');
  fEx.add(E, 'samples', [1, 4, 8]).name('motion blur samples');
  fEx.add(E, 'alpha', { 'RGBA premultiplied - luminance alpha': 'premult', 'RGBA premultiplied - smoke-only alpha': 'smoke', 'RGB on solid black': 'black' }).name('alpha mode');
  fEx.add(E, 'format', Object.keys(FORMATS));
  fEx.add(E, 'name').name('output name');
  fEx.add({ f: () => app.exportFromUI().catch(() => {}) }, 'f').name('Export');
  fEx.add({ f: () => app.cancelExport() }, 'f').name('Cancel export');
  fEx.add({ f: () => app.still().catch(() => {}) }, 'f').name('Save still (PNG)');

  enableScrubbing(gui);
  getFfmpeg().then((j) => { if (!j.ok) { const b = document.getElementById('progress'); b.style.display = 'block'; b.textContent = j.error; } });
  return gui;
}
