// Undo / redo of the whole look (shot, physics, render, elements) plus an A/B compare slot.
import { state, applyShot, shotSnapshot } from '../state.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const LIMIT = 100;
// camera keys are copied; an imported animation (baked) is never edited, so it is only referenced
const snap = () => ({ camera: { keys: clone(state.camera.keys), view: state.camera.view, baked: state.camera.baked }, shot: shotSnapshot(), preset: state.preset, physics: clone(state.physics), render: clone(state.render), elements: clone(state.elements) });
const key = (s) => JSON.stringify({ ...s, camera: { ...s.camera, baked: s.camera.baked ? s.camera.baked.id : null } });

export function buildHistory(app) {
  const undo = [], redo = [];
  let cur = snap(), curKey = key(cur), timer = null, ignore = false, slotB = null, showing = 'A', stashA = null;

  // Restore by mutating the shared objects in place, so every control that holds a reference stays valid.
  function restore(s) {
    ignore = true; const before = snap();
    applyShot(s.shot, { reset: true });
    state.preset = s.preset;
    state.camera.keys = clone(s.camera.keys); state.camera.baked = s.camera.baked; state.camera.view = s.camera.view;
    Object.assign(state.physics, s.physics); Object.assign(state.render, s.render); Object.assign(state.elements, s.elements);
    const shotChanged = JSON.stringify(s.shot) !== JSON.stringify(before.shot) || s.physics.timeScale !== before.physics.timeScale || JSON.stringify(s.physics) !== JSON.stringify(before.physics);
    app.refreshUI?.(); app.updateDeck?.();
    if (shotChanged) { const t = app.playhead, was = app.playing; app.fire(); app.playhead = t; app.playing = was; }   // keep the playhead where it was
    cur = snap(); curKey = key(cur); ignore = false;
  }
  const capture = () => {
    timer = null; if (ignore) return;
    const k = key(snap()); if (k === curKey) return;
    undo.push(cur); if (undo.length > LIMIT) undo.shift();
    redo.length = 0; cur = snap(); curKey = k;
  };
  const schedule = () => { if (ignore) return; clearTimeout(timer); timer = setTimeout(capture, 250); };
  for (const ev of ['pointerup', 'change', 'keyup', 'click']) document.addEventListener(ev, schedule, true);

  const api = {
    undo() { if (app.exporting) return app.notify('An export is running. Wait for it or cancel it.'); capture(); const s = undo.pop(); if (!s) return app.notify('Nothing to undo'); redo.push(cur); restore(s); app.notify(`Undo (${undo.length} left)`); },
    redo() { if (app.exporting) return app.notify('An export is running. Wait for it or cancel it.'); capture(); const s = redo.pop(); if (!s) return app.notify('Nothing to redo'); undo.push(cur); restore(s); app.notify(`Redo (${redo.length} left)`); },
    // A/B compare: store the current look in slot B, change things, then flip between the two
    storeB() { capture(); slotB = clone(cur); stashA = null; showing = 'A'; app.notify('Stored this look in slot B. Change something, then press Flip A/B.'); },
    flip() {
      if (app.exporting) return app.notify('An export is running. Wait for it or cancel it.');
      if (!slotB) return app.notify('Store a look in slot B first');
      capture();
      if (showing === 'A') { stashA = clone(cur); restore(slotB); showing = 'B'; }
      else { restore(stashA); showing = 'A'; }
      app.notify(`Showing look ${showing}`);
    },
    canUndo: () => undo.length, canRedo: () => redo.length, flush: capture,
  };
  app.history = api;
  return api;
}
