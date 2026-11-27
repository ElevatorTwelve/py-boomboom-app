// Camera keys. The camera you look through is the shot camera in the Camera view (key 2 / C) and a free camera in the Perspective view (key 1).
// In the Camera view, orbit, pan, zoom, fly and the number fields edit the camera at the playhead: with auto-key on, every finished edit sets a key
// on that frame. K (or I) sets a key from the current view at any time. Keys sit on whole frames. Time is output time (frame N = N / fps).
import { state } from '../state.js';
import { newKey, hasCamera, cameraLength, bakedToKeys, frameOf, EASE_NAMES } from '../camera/path.js';

const clone = (o) => JSON.parse(JSON.stringify(o));

export function buildCameraAnim(fCam, app) {
  const C = state.camera, rig = app.rig;
  const f = fCam.addFolder('Camera keys');
  let sel = 0, selected = false, keyFolder = null, listCtl = null, viewCtl = null;
  const note = (s) => app.notify?.(s);
  const fps = () => state.export.fps, ts = () => state.physics.timeScale;
  const frameNow = () => frameOf(app.playhead / ts(), fps());
  const keyFrame = (k) => frameOf(k.t, fps());
  const indexAtFrame = (fr) => C.keys.findIndex((k) => keyFrame(k) === fr);

  const status = { get info() {
    if (C.baked) return `imported: ${C.baked.count} frames at ${C.baked.fps} fps`;
    if (!C.keys.length) return 'no keys: export uses the camera you see';
    const here = indexAtFrame(frameNow());
    return `${C.keys.length} key${C.keys.length > 1 ? 's' : ''} (frames ${keyFrame(C.keys[0])} to ${keyFrame(C.keys[C.keys.length - 1])})` + (here >= 0 ? `. Key ${here + 1} is on this frame.` : '');
  } };

  const poseFromRig = () => { const c = rig.capture(); return { position: c.position, target: c.target, focal: c.focal, roll: c.roll || 0 }; };

  // Set (or update) the key on the current frame from the camera on the screen.
  function keyCamera(opts = {}) {
    if (C.baked) { note('This camera is an imported animation. Convert it to keys first (Camera keys > Convert to keys).'); return false; }
    if (!opts.auto) app.seek?.(app.playhead);   // key on a still, whole frame (this also pauses)
    const fr = frameNow(), t = fr / fps(), pose = poseFromRig(), at = indexAtFrame(fr);
    if (at >= 0) { Object.assign(C.keys[at], pose); sel = at; }
    else {
      const prev = [...C.keys].reverse().find((k) => k.t < t) || C.keys[0];
      C.keys.push(newKey({ t, ...pose, interp: prev?.interp ?? 'bezier', ease: prev?.ease ?? 'linear' }));
      C.keys.sort((a, b) => a.t - b.t); sel = C.keys.findIndex((k) => k.t === t);
    }
    selected = true; app.camEdit.pending = false;
    if (C.view !== 'shot') setView('shot');   // you keyed the camera, so you now look through it
    if (!opts.auto) note(`Camera key ${sel + 1} on frame ${fr}. You are in the Camera view now.`);
    rebuild();
    return true;
  }

  function setView(v) {
    C.view = v; app.camEdit.pending = false;
    if (v === 'free') rig.roll = 0;   // the free view has no tilt unless you set one
    viewCtl?.updateDisplay(); app.viewMenu?.sync();
  }
  const toggleView = () => setView(C.view === 'shot' ? 'free' : 'shot');

  const jump = (k) => { if (k) app.seek?.(k.t * ts()); };
  function gotoKey(dir) {
    if (!C.keys.length) return;
    const fr = frameNow();
    const k = dir > 0 ? C.keys.find((x) => keyFrame(x) > fr) : [...C.keys].reverse().find((x) => keyFrame(x) < fr);
    if (k) { sel = C.keys.indexOf(k); selected = true; jump(k); rebuild(); } else note(dir > 0 ? 'No later key' : 'No earlier key');
  }
  function deleteSelected() {
    if (C.baked || !selected || !C.keys[sel]) return false;
    C.keys.splice(sel, 1); selected = false; if (!C.keys.length) setView('free');
    note('Deleted the camera key'); rebuild(); return true;
  }

  // The camera was moved by the user (mouse, fly keys or a number). In the Camera view this edits the shot camera.
  rig.onInteractStart = () => { if (C.view === 'shot' && app.playing) app.seek?.(app.playhead); };   // edit on a still, whole frame (this also pauses)
  rig.onUserEdit = () => {
    if (C.view !== 'shot') { app.viewMenu?.moved(); return; }
    if (C.baked) { app.camEdit = { pending: true, at: app.playhead }; note('Imported animation: the edit is not keyed. Convert it to keys to edit it.'); return; }
    if (C.autoKey) keyCamera({ auto: true });
    else { app.camEdit = { pending: true, at: app.playhead }; note('Camera changed, not keyed. Press K to key it, or move the playhead to drop it.'); }
  };

  function rebuild() {
    keyFolder?.destroy(); listCtl?.destroy(); listCtl = keyFolder = null;
    if (sel >= C.keys.length) sel = Math.max(0, C.keys.length - 1);
    viewCtl?.updateDisplay(); app.viewMenu?.sync();
    if (C.baked) {
      keyFolder = f.addFolder('Imported animation');
      keyFolder.add({ f: () => { C.keys = bakedToKeys(C.baked); C.baked = null; sel = 0; note(`Converted to ${C.keys.length} keys. This is an approximation.`); rebuild(); } }, 'f').name('Convert to keys (about 30, approximate)');
      keyFolder.add({ f: () => { C.baked = null; if (!C.keys.length) setView('free'); note('Removed the imported camera animation'); rebuild(); } }, 'f').name('Remove imported animation');
      return;
    }
    if (!C.keys.length) return;
    const opts = {}; C.keys.forEach((k, i) => { opts[`${i + 1}:  frame ${keyFrame(k)}  (${k.t.toFixed(2)} s)`] = i; });
    listCtl = f.add({ key: sel }, 'key', opts).name('key').onChange((v) => { sel = +v; selected = true; jump(C.keys[sel]); rebuild(); });
    const k = C.keys[sel];
    keyFolder = f.addFolder(`Key ${sel + 1}`);
    const proxy = { frame: keyFrame(k) };
    keyFolder.add(proxy, 'frame', 0, Math.round(600 * fps()), 1).name('frame').onFinishChange((v) => {
      const fr = Math.max(0, Math.round(v)), clash = indexAtFrame(fr);
      if (clash >= 0 && clash !== sel) { note(`Frame ${fr} already has a key`); rebuild(); return; }
      k.t = fr / fps(); C.keys.sort((a, b) => a.t - b.t); sel = C.keys.indexOf(k); rebuild();
    });
    const num = (obj, key, name, a, b, step) => keyFolder.add(obj, key, a, b, step).name(name);
    num(k, 'focal', 'focal length (mm)', 12, 400, 0.5); num(k, 'roll', 'roll (deg)', -180, 180, 0.1);
    ['x', 'y', 'z'].forEach((ax, i) => keyFolder.add(k.position, i, -5000, 5000, 0.1).name('position ' + ax));
    ['x', 'y', 'z'].forEach((ax, i) => keyFolder.add(k.target, i, -5000, 5000, 0.1).name('target ' + ax));
    keyFolder.add(k, 'ease', EASE_NAMES).name('ease to next key');
    keyFolder.add(k, 'interp', { 'smooth curve': 'bezier', straight: 'linear' }).name('path to next key');
    keyFolder.add({ f: () => { Object.assign(k, poseFromRig()); note(`Key ${sel + 1} now matches the camera you see`); rebuild(); } }, 'f').name('Set key from view');
    keyFolder.add({ f: () => { selected = true; deleteSelected(); } }, 'f').name('Delete key');
  }

  viewCtl = f.add(C, 'view', { 'Perspective: free view (1)': 'free', 'Camera: the shot camera (2)': 'shot' }).name('view (C)').onChange((v) => setView(v));
  f.add(C, 'autoKey').name('auto-key (set keys while you move)');
  f.add(status, 'info').name('camera').disable().listen();
  f.add({ f: () => keyCamera() }, 'f').name('Key camera here (K)');
  f.add({ f: () => gotoKey(-1) }, 'f').name('Go to previous key (Up)');
  f.add({ f: () => gotoKey(1) }, 'f').name('Go to next key (Down)');
  f.add({ f: () => { C.keys = []; C.baked = null; setView('free'); sel = 0; selected = false; rebuild(); note('Cleared the camera keys'); } }, 'f').name('Clear camera keys');
  rebuild();
  app.camAnim = { keyCamera, toggleView, setView, rebuild, gotoKey, deleteSelected, select: (i) => { sel = i; selected = true; rebuild(); }, selected: () => sel, hasSelection: () => selected && !!C.keys[sel], clearSelection: () => { selected = false; rebuild(); } };
  return app.camAnim;
}
