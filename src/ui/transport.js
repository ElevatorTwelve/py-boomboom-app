// Bottom bar (play, restart, scrub, loop) and the layer timeline (drag a bar to move a layer in time).
import { state } from '../state.js';
import { TYPES } from '../library/index.js';
import { dock } from './dock.js';
import { shellFlight, baseLaunchSpeed } from '../sim/world.js';
import { estimateExport } from '../sim/estimate.js';
import { cameraLength, hasCamera, frameOf } from '../camera/path.js';

const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const MIN_LEN = 6;   // timeline never shows less than this many seconds

export function buildTransport(app) {
  // ---- bar ----
  const bar = h('div', 'pyb-bar');
  const play = h('button', null, 'Pause'), restart = h('button', null, 'Restart'), loop = h('button', null, 'Loop'), autoBtn = h('button', null, 'Auto-key'), tlBtn = h('button', null, 'Timeline'), galBtn = h('button', null, 'Gallery');
  autoBtn.title = 'Auto-key: in the Camera view, every camera move sets a key on the current frame (like the record button in an animation program)';
  play.title = 'Play or pause (Space)'; restart.title = 'Fire the shot again (F)'; loop.title = 'Loop the shot (L)'; tlBtn.title = 'Show the layer timeline (T)'; galBtn.title = 'Open the preset gallery (G)';
  const scrub = document.createElement('input'); scrub.type = 'range'; scrub.min = 0; scrub.max = 1000; scrub.value = 0; scrub.setAttribute('aria-label', 'Time scrub bar');
  const time = h('span', 'pyb-time');
  bar.append(h('span', 'pyb-brand', 'PY-BoomBoom'), play, restart, scrub, time, loop, autoBtn, tlBtn, galBtn);

  let length = 10, lengthAt = -1, scrubbing = false, pending = null;
  const refreshLength = () => {
    try { const e = estimateExport(app.shotForWorld(), state.physics, state.export.fps); length = Math.max(MIN_LEN, e.seconds * state.physics.timeScale || MIN_LEN, cameraLength(state.camera) * state.physics.timeScale + 0.5); } catch { length = MIN_LEN; }   // whole shot, whatever the export duration is
    lengthAt = performance.now();
  };
  refreshLength();

  const busy = () => { if (app.exporting) { app.notify('An export is running. Wait for it or cancel it.'); return true; } return false; };
  // the playhead rests on a whole output frame whenever it is moved by hand (camera keys sit on frames too)
  const snapT = (t) => { const ts = state.physics.timeScale, fps = state.export.fps; return Math.round(t / ts * fps) / fps * ts; };
  const seek = (t) => {
    if (busy()) return;   // the simulation only runs forward: going back means firing again and catching up
    t = Math.max(0, Math.min(length, snapT(t)));
    const S = state.render.shutterAngle / 360 / state.export.fps * state.physics.timeScale;
    if (t + S < app.world.t - 1e-6) { app.fire(); }
    app.playhead = t; app.playing = false; app.gap = 0; sync();
  };
  const frameHook = () => { if (pending != null) { const t = pending; pending = null; seek(t); } };
  scrub.addEventListener('pointerdown', () => { scrubbing = true; });
  addEventListener('pointerup', () => { scrubbing = false; });
  scrub.addEventListener('input', () => { pending = scrub.value / 1000 * length; });

  const setPlaying = (on) => {
    if (busy()) return;
    if (!on && app.playing) { seek(app.playhead); return; }   // pausing lands on a whole frame
    app.playing = on; if (on && app.world.finished && !state.loop) { app.fire(); } sync(); };
  play.addEventListener('click', () => setPlaying(!app.playing));
  restart.addEventListener('click', () => { if (!busy()) app.fire(); });
  loop.addEventListener('click', () => { state.loop = !state.loop; app.updateGui?.(); sync(); });
  autoBtn.addEventListener('click', () => { state.camera.autoKey = !state.camera.autoKey; app.updateGui?.(); sync(); });
  app.togglePlay = () => setPlaying(!app.playing);
  app.toggleLoop = () => { state.loop = !state.loop; app.updateGui?.(); sync(); };
  app.nudge = (dt) => seek(app.playhead + dt);
  app.stepFrames = (n) => seek(app.playhead + n * state.physics.timeScale / state.export.fps);   // output frames
  app.goStart = () => seek(0); app.goEnd = () => seek(length);

  function sync() {
    play.textContent = app.playing ? 'Pause' : 'Play'; loop.classList.toggle('on', !!state.loop); autoBtn.classList.toggle('on', !!state.camera.autoKey); tlBtn.classList.toggle('on', tl.classList.contains('open'));
    if (!scrubbing) scrub.value = Math.min(1000, Math.round(app.playhead / length * 1000));
    time.textContent = `f${frameOf(app.playhead / state.physics.timeScale, state.export.fps)}  ${app.playhead.toFixed(2)} / ${length.toFixed(1)} s`;
  }

  // ---- layer timeline ----
  const tl = h('div', 'pyb-tl'), tlHead = h('div', 'pyb-tl-head'), grid = h('div', 'pyb-tl-grid');
  tlHead.append(h('span', null, 'Layer timeline - drag a bar to change its delay (finale: start offset)'), h('span', null, 'bar length is only a guide'));
  tl.append(tlHead, grid); dock().prepend(tl); dock().append(bar);
  let rowsKey = '';
  const layerStart = (l) => {   // seconds from fire to burst for the first shell of this layer
    const fin = state.shot.finale.enabled;
    // without a finale all layers share one shell: the first enabled layer sets its speed and style
    const shell = fin ? l : (state.shot.layers.find((x) => x.enabled) || l);
    const fl = state.shot.launch ? shellFlight(state.shot.burstHeight, state.physics.gravity, baseLaunchSpeed(shell, shell.launchStyle)).t : 0;
    return fl + (fin ? l.startOffset : l.delay);
  };
  const layerLen = (l) => {
    if (state.shot.finale.enabled) { const n = Math.max(1, l.repeats) - 1, iv = l.interval > 0 ? l.interval : Math.max(0.3, (state.shot.finale.totalTime - l.startOffset) / Math.max(1, n)); return n * iv + 2.5; }
    return 2.5;
  };
  function drawTimeline() {
    const L = state.shot.layers, key = JSON.stringify([L.map((l) => [l.id, l.type, l.enabled, l.delay, l.startOffset, l.repeats, l.interval, l.launchSpeed]), state.shot.finale.enabled, state.shot.finale.totalTime, state.shot.burstHeight, state.shot.launch, state.physics.gravity, length, state.shot.layers.map((x) => [x.launchStyle, x.launchSpeed]), state.camera.keys, state.camera.baked && state.camera.baked.id, state.physics.timeScale]);
    if (key === rowsKey && !dragging) return; rowsKey = key;
    grid.textContent = '';
    const ruler = h('div', 'pyb-tl-head-t'); const step = length > 40 ? 10 : length > 15 ? 5 : 1;
    for (let s = 0; s <= length; s += step) { const sp = h('span', null, s + 's'); sp.style.left = s / length * 100 + '%'; ruler.append(sp); }
    const rulerSeek = (e) => { const r = grid.getBoundingClientRect(); seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * length); };
    ruler.style.cursor = 'col-resize'; ruler.title = 'Drag to move the playhead';
    ruler.addEventListener('pointerdown', (e) => { if (app.exporting) return; ruler.setPointerCapture(e.pointerId); rulerSeek(e); const mv = (ev) => rulerSeek(ev), up = () => { ruler.removeEventListener('pointermove', mv); ruler.removeEventListener('pointerup', up); }; ruler.addEventListener('pointermove', mv); ruler.addEventListener('pointerup', up); });
    grid.append(ruler);
    L.forEach((l, i) => {
      const row = h('div', 'pyb-tl-row'), nm = h('div', 'name', `${i + 1}. ${TYPES[l.type]?.name || l.type}`);
      const bx = h('div', 'pyb-tl-bar' + (l.enabled ? '' : ' off'));
      const t0 = layerStart(l), len = layerLen(l);
      bx.style.left = Math.min(100, t0 / length * 100) + '%'; bx.style.width = Math.max(0.5, Math.min(len, length - t0) / length * 100) + '%';
      bx.title = `Burst at ${t0.toFixed(2)} s`; bx.tabIndex = 0;
      bx.addEventListener('pointerdown', (e) => {
        if (busy()) return;
        bx.setPointerCapture(e.pointerId); dragging = true; e.preventDefault();
        const fin = state.shot.finale.enabled, key2 = fin ? 'startOffset' : 'delay', max = fin ? 120 : 6, v0 = l[key2], x0 = e.clientX, w = grid.getBoundingClientRect().width;
        const move = (ev) => { l[key2] = Math.round(Math.max(0, Math.min(max, v0 + (ev.clientX - x0) / w * length)) * 100) / 100; bx.style.left = Math.min(100, layerStart(l) / length * 100) + '%'; bx.title = `Burst at ${layerStart(l).toFixed(2)} s`; };
        const up = () => { bx.removeEventListener('pointermove', move); bx.removeEventListener('pointerup', up); dragging = false; app.rebuildShotUI?.(); refreshLength(); app.fire(); };
        bx.addEventListener('pointermove', move); bx.addEventListener('pointerup', up);
      });
      row.append(nm, bx); grid.append(row);
    });
    if (hasCamera(state.camera)) {   // camera row: keys are diamonds (drag to move them in time, click to select), an imported animation is a bar
      const row = h('div', 'pyb-tl-row'), ts = state.physics.timeScale, C = state.camera;
      row.append(h('div', 'name', C.baked ? 'Camera (imported)' : 'Camera keys'));
      if (C.baked) { const bx = h('div', 'pyb-tl-bar cam'); bx.style.left = '0%'; bx.style.width = Math.min(100, cameraLength(C) * ts / length * 100) + '%'; bx.title = `Imported camera animation, ${C.baked.count} frames`; row.append(bx); }
      else C.keys.forEach((k, i) => {
        const d = h('div', 'pyb-tl-key' + (i === app.camAnim?.selected() ? ' sel' : '')); d.style.left = Math.min(100, k.t * ts / length * 100) + '%'; d.title = `Camera key ${i + 1} at ${k.t.toFixed(2)} s`; d.tabIndex = 0;
        d.addEventListener('pointerdown', (e) => {
          if (busy()) return;
          d.setPointerCapture(e.pointerId); dragging = true; e.preventDefault(); app.camAnim?.select(i);
          const x0 = e.clientX, t0 = k.t, w = grid.getBoundingClientRect().width;
          const fps = state.export.fps;
          const move = (ev) => { const fr = Math.max(0, Math.round((t0 + (ev.clientX - x0) / w * length / ts) * fps)); if (!C.keys.some((o) => o !== k && frameOf(o.t, fps) === fr)) k.t = fr / fps; d.style.left = Math.min(100, k.t * ts / length * 100) + '%'; d.title = `Camera key ${i + 1} at ${k.t.toFixed(2)} s`; };
          const up = () => { d.removeEventListener('pointermove', move); d.removeEventListener('pointerup', up); dragging = false; C.keys.sort((a, b) => a.t - b.t); app.camAnim?.select(C.keys.indexOf(k)); rowsKey = ''; };
          d.addEventListener('pointermove', move); d.addEventListener('pointerup', up);
        });
        row.append(d);
      });
      grid.append(row);
    }
    const ph = h('div', 'pyb-tl-play'); ph.id = 'pyb-tl-play'; grid.append(ph);
  }
  let dragging = false;
  const toggleTimeline = () => { tl.classList.toggle('open'); rowsKey = ''; if (tl.classList.contains('open')) drawTimeline(); sync(); };
  tlBtn.addEventListener('click', toggleTimeline);
  app.toggleTimeline = toggleTimeline;
  galBtn.addEventListener('click', () => app.openGallery?.());

  return {
    tick() {   // called every animation frame
      frameHook();
      if (app.playing && !state.loop && !app.exporting && app.playhead > length) { app.playhead = length; app.playing = false; }   // stop at the end of the shot
      if (performance.now() - lengthAt > 1000 && !scrubbing && !app.exporting) refreshLength();
      sync();
      if (tl.classList.contains('open')) { drawTimeline(); const ph = document.getElementById('pyb-tl-play'); if (ph) ph.style.left = Math.min(100, app.playhead / length * 100) + '%'; }
    },
    seek, refreshLength, get length() { return length; },
  };
}
