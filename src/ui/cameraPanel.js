// Camera folder: numeric fields, built-in views, free-fly toggle and named camera presets saved on disk.
import { VIEWS, state } from '../state.js';
import { buildBlenderCameraUI } from './blenderCamera.js';
import { buildCameraAnim } from './cameraAnim.js';
import { hasCamera, frameOf } from '../camera/path.js';
import { listPresets, savePreset, deletePreset, sameName } from './presetsApi.js';

export function buildCameraPanel(gui, app) {
  const fCam = gui.addFolder('Camera');
  const cs = { fly: false, px: 0, py: 0, pz: 0, tx: 0, ty: 0, tz: 0, focal: 60, roll: 0, view: 'Default' };
  const pull = () => { const c = app.rig.get(); [cs.px, cs.py, cs.pz] = c.position; [cs.tx, cs.ty, cs.tz] = c.target; cs.focal = c.focal; cs.roll = c.roll || 0; cs.fly = app.rig.fly; };
  const push = () => { app.rig.apply({ position: [cs.px, cs.py, cs.pz], target: cs.fly ? undefined : [cs.tx, cs.ty, cs.tz], focal: cs.focal, roll: cs.roll }); app.rig.edited(); };   // in the Camera view this edits (and with auto-key keys) the shot camera
  fCam.add(cs, 'view', Object.keys(VIEWS)).name('view (built-in)').onChange((v) => { app.viewMenu ? app.viewMenu.chooseBuiltin(v) : app.rig.apply(VIEWS[v]); });   // the same as the view menu in the viewport
  const flyCtl = fCam.add(cs, 'fly').name('free-fly (WASD/QE, drag to look)').onChange((v) => app.rig.setFly(v));
  const camCtl = [flyCtl];
  [['px', 'pos X'], ['py', 'pos Y'], ['pz', 'pos Z'], ['tx', 'target X'], ['ty', 'target Y'], ['tz', 'target Z']].forEach(([k, n]) => camCtl.push(fCam.add(cs, k).name(n).step(0.1).onChange(push)));
  camCtl.push(fCam.add(cs, 'focal', 12, 400, 0.5).name('focal length (mm)').onChange(push));
  camCtl.push(fCam.add(cs, 'roll', -180, 180, 0.1).name('roll (deg)').onChange(push));
  fCam.add({ f: () => { app.rig.apply(VIEWS[cs.view]); app.rig.edited(); } }, 'f').name('reset camera');
  // Field colours, like in an animation program: orange = a key is on this frame, green = animated (between keys), red = changed but not keyed.
  const tint = () => {
    const C = state.camera, fr = frameOf(app.playhead / state.physics.timeScale, state.export.fps);
    let cls = '';
    if (C.view === 'shot' && hasCamera(C)) cls = app.camEdit.pending ? 'pyb-edited' : C.keys.some((k) => frameOf(k.t, state.export.fps) === fr) ? 'pyb-keyed' : 'pyb-animated';
    for (const c of camCtl) { const el = c.domElement; for (const k of ['pyb-keyed', 'pyb-animated', 'pyb-edited']) el.classList.toggle(k, k === cls); }
  };
  app.onTick = () => {
    tint();
    if (document.body.classList.contains('pyb-scrubbing') || app.rig.interacting) return;   // do not fight a drag
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    pull(); camCtl.forEach((c) => c.updateDisplay());
  };

  buildCameraAnim(fCam, app);
  app.blender = buildBlenderCameraUI(fCam, app, () => { pull(); camCtl.forEach((c) => c.updateDisplay()); });

  // ---- saved camera presets (persisted in presets/cameras.json by the dev server) ----
  const cp = { name: 'My camera', selected: '', saved: {} };
  let sub = null;
  const note = (s) => app.notify?.(s);
  const build = () => {
    sub?.destroy();
    sub = fCam.addFolder('Saved camera presets');
    sub.add(cp, 'name').name('name');
    sub.add({ f: async () => {
      const existing = Object.keys(cp.saved).find((n) => sameName(n, cp.name));
      if (existing && !window.confirm(`A camera preset named "${existing}" already exists. Overwrite it?`)) return;
      try { const r = await savePreset('cameras', cp.name, app.rig.capture(), !!existing); await refresh(r.name); note(`Saved camera preset "${cp.selected}"` + (r.notice ? ' - ' + r.notice : '')); }
      catch (e) { note('Save failed: ' + e.message); }
    } }, 'f').name('Save camera preset');
    const opts = {}; for (const n of Object.keys(cp.saved)) opts[n] = n;
    sub.add(cp, 'selected', opts).name('saved presets');
    sub.add({ f: () => {
      const p = cp.saved[cp.selected]; if (!p) return note('Select a saved camera preset first');
      app.rig.applyPreset(p); pull(); camCtl.forEach((c) => c.updateDisplay()); note(`Loaded camera "${cp.selected}"`);
    } }, 'f').name('Load');
    sub.add({ f: () => {
      if (!cp.selected) return note('Select a saved camera preset first');
      savePreset('cameras', cp.selected, app.rig.capture(), true).then(() => refresh(cp.selected)).then(() => note(`Updated "${cp.selected}" with the current view`)).catch((e) => note('Update failed: ' + e.message));
    } }, 'f').name('Update (overwrite selected with current view)');
    sub.add({ f: () => {
      if (!cp.selected) return note('Select a saved camera preset first');
      const n = cp.selected; deletePreset('cameras', n).then(() => refresh('')).then(() => note(`Deleted "${n}"`)).catch((e) => note('Delete failed: ' + e.message));
    } }, 'f').name('Delete');
  };
  const refresh = (select) => listPresets('cameras', (n) => note(n)).then((p) => { cp.saved = p; cp.selected = select !== undefined && (select === '' || p[select]) ? select : cp.selected; build(); }).catch(() => build());
  build(); refresh();
}
