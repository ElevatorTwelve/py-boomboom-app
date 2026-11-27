// Shot folder: combo presets, layers (with per-layer colours / launch style / finale timing), grand finale, physics variation.
import { state, loadPreset, applyShot, shotSnapshot } from '../state.js';
import { LIST, TYPES, PRESETS, PALETTE_NAMES, LAUNCH_STYLES, newLayer, layerDefaults } from '../library/index.js';
import { FINALE_PRESETS } from '../library/finales.js';
import { MAX_REPEATS, shellFlight, baseLaunchSpeed } from '../sim/world.js';
import { listPresets, savePreset, deletePreset, sameName } from './presetsApi.js';

const BUILTIN = '[built-in] ';

export function buildShotPanel(gui, app, track) {
  const fShot = gui.addFolder('Shot');
  track(fShot.add(state, 'seed', 0, 4294967295, 1).name('seed'));
  fShot.add({ f: () => { state.seed = Math.floor(Math.random() * 1e9); app.refreshUI(); app.fire(); } }, 'f').name('New seed + fire');
  fShot.add({ f: () => app.fire() }, 'f').name('Fire / Replay');
  fShot.add(state, 'loop').name('loop');
  track(fShot.add(state, 'preset', Object.keys(PRESETS)).name('combo preset').onChange((n) => { loadPreset(n); rebuild(); app.fire(); }));
  track(fShot.add(state.shot, 'launch').name('launch phase'));
  track(fShot.add(state.shot, 'burstHeight', 60, 350, 1).name('burst height (m)'));
  track(fShot.add(state.shot.finale, 'enabled').name('Grand finale').onChange(() => { rebuild(); }));

  const openLayers = new Set();      // layer ids whose folder is open
  const openState = { finale: false, presets: false, variation: false };   // sub-folder open state survives rebuilds
  let dyn = [];                      // dynamic sub-folders, rebuilt on structural changes
  const fp = { name: 'My finale', selected: '', saved: {} };

  const paletteOptions = (allowDefault, defaultLabel) => {
    const o = {}; if (allowDefault) o[defaultLabel] = null;
    for (const n of PALETTE_NAMES) o[n] = n;
    o['Custom colour...'] = 'Custom';
    return o;
  };

  function layerFolder(parent, l, i) {
    const t = TYPES[l.type], finale = state.shot.finale.enabled;
    const f = parent.addFolder(`${i + 1}. ${t.name}${l.enabled ? '' : ' (muted)'}`);
    if (!openLayers.has(l.id)) f.close();
    f.onOpenClose((g) => { if (g._closed) openLayers.delete(l.id); else openLayers.add(l.id); });
    f.add(l, 'type', Object.fromEntries(LIST.map((x) => [x.name, x.id]))).onChange(() => {
      const d = layerDefaults(l.type);
      Object.assign(l, { palette: d.palette, palette2: d.palette2, palette3: null });   // new type -> its default colours
      rebuild();
    });
    // colour components exposed by this type: palette list plus a custom colour picker each
    const comps = [['main', 'palette', 'customColor'], ['secondary', 'palette2', 'customColor2'], ['trail', 'palette3', 'customColor3']];
    for (const [comp, key, ckey] of comps) {
      const meta = t.colors?.[comp]; if (!meta) continue;
      const label = typeof meta === 'string' ? meta : meta.label, canDefault = comp !== 'main';
      f.add(l, key, paletteOptions(canDefault, comp === 'trail' ? 'Default' : (meta.default ? `Default (${meta.default})` : 'Same as parent'))).name(label).onChange(() => rebuild());
      if (l[key] === 'Custom') f.addColor(l, ckey).name(label + ' (custom)');
    }
    f.add(l, 'expanse', 0.3, 2, 0.01); f.add(l, 'stars', 0.1, 3, 0.01).name('star count x'); f.add(l, 'bright', 0.1, 4, 0.01).name('brightness x');
    f.add(l, 'delay', 0, 6, 0.01).name('delay after burst (s)');
    f.add(l.offset, 0, -80, 80, 0.5).name('offset X'); f.add(l.offset, 1, -80, 80, 0.5).name('offset Y'); f.add(l.offset, 2, -80, 80, 0.5).name('offset Z');
    if (l.type === 'ring' || l.type === 'saturn') {
      f.add(l, 'randomTilt').name('random tilt (20-60 deg from +Z)');
      f.add(l, 'tilt', 0, 90, 1).name('ring tilt (deg from world +Z, the default view axis)');
      f.add(l, 'rotation', 0, 360, 1).name('ring rotation about +Z (deg)');
    }
    f.add(l, 'launchStyle', LAUNCH_STYLES).name('launch style').onChange(() => rebuild());
    f.add(l, 'wobble', 0, 3, 0.05).name('launch wobble');
    f.add(l, 'launchSpeed', 0.4, 2.5, 0.01).name('launch speed x (higher = bursts sooner)');
    // read-only ground-to-burst time of this layer's shell (same flight model the world uses; finale variation not included)
    const info = { get time() {
      if (!state.shot.launch) return 'n/a (launch phase off)';
      const fl = shellFlight(state.shot.burstHeight, state.physics.gravity, baseLaunchSpeed(l, l.launchStyle));
      return `${fl.t.toFixed(2)} s` + (fl.vb > 6 ? ` (still climbing at ${fl.vb.toFixed(0)} m/s)` : ' (at apex)');
    } };
    f.add(info, 'time').name('ground-to-burst').disable().listen();
    if (finale) {
      f.add(l, 'repeats', 1, MAX_REPEATS, 1).name(`repeats (max ${MAX_REPEATS})`);
      f.add(l, 'interval', 0, 30, 0.05).name('interval (s, 0 = auto)');
      f.add(l, 'startOffset', 0, 120, 0.1).name('start offset (s)');
      f.add(l, 'noise', 0, 1, 0.01).name('interval noise');
    }
    f.add(l, 'enabled').name('enabled (mute)').onChange(() => rebuild());
    f.add({ f: () => { state.shot.layers.splice(i, 1); rebuild(); } }, 'f').name('remove layer');
    return f;
  }

  const finaleOptions = () => {
    const o = {}; for (const n of Object.keys(FINALE_PRESETS)) o[BUILTIN + n] = BUILTIN + n;
    for (const n of Object.keys(fp.saved)) o[n] = n;
    return o;
  };

  const refreshSaved = () => listPresets('finales', (n) => app.notify?.(n)).then((p) => { fp.saved = p; }).catch(() => { fp.saved = {}; });

  function finaleFolder() {
    const f = fShot.addFolder('Grand finale'), fin = state.shot.finale;
    if (!openState.finale) f.close();
    f.onOpenClose((g) => { if (g === f) openState.finale = !g._closed; });
    f.add(fin, 'totalTime', 0, 120, 0.5).name('total time (s, first to last launch)');
    f.add(fin, 'spreadX', 0, 800, 1).name('spread X (m)'); f.add(fin, 'spreadZ', 0, 600, 1).name('spread Z (m)');
    f.add(fin, 'posSeed', 0, 100000, 1).name('position seed'); f.add(fin, 'heightVar', 0, 80, 0.5).name('burst height variation (m)');
    const p = f.addFolder('Finale presets');
    if (!openState.presets) p.close();
    p.onOpenClose((g) => { openState.presets = !g._closed; });
    p.add(fp, 'name').name('name');
    p.add(fp, 'selected', finaleOptions()).name('preset');
    const note = (s) => app.notify?.(s);
    p.add({ f: () => {
      const sel = fp.selected;
      if (!sel) return note('Select a finale preset first');
      const data = sel.startsWith(BUILTIN) ? FINALE_PRESETS[sel.slice(BUILTIN.length)]() : fp.saved[sel];
      if (!data) return note('Preset not found');
      const r = applyShot(data, { reset: true });
      if (r.error) return note(`Could not load "${sel.replace(BUILTIN, '')}": ${r.error}`);
      state.shot.finale.enabled = true; app.refreshUI(); app.fire();
      note(`Loaded finale preset "${sel.replace(BUILTIN, '')}"` + (r.warnings.length ? ' (' + r.warnings.join('; ') + ')' : ''));
    } }, 'f').name('Load finale preset');
    p.add({ f: async () => {
      const existing = Object.keys(fp.saved).find((n) => sameName(n, fp.name));
      if (existing && !window.confirm(`A finale preset named "${existing}" already exists. Overwrite it?`)) return;
      try { const r = await savePreset('finales', fp.name, shotSnapshot(), !!existing); await refreshSaved(); fp.selected = r.name; rebuild(); note(`Saved finale preset "${r.name}"` + (r.notice ? ' - ' + r.notice : '')); }
      catch (e) { note('Save failed: ' + e.message); }
    } }, 'f').name('Save finale preset (name above)');
    p.add({ f: () => {
      if (!fp.selected || fp.selected.startsWith(BUILTIN)) return note('Built-in presets are read-only; save a copy under a new name');
      savePreset('finales', fp.selected, shotSnapshot(), true).then(refreshSaved).then(() => note(`Updated "${fp.selected}"`)).catch((e) => note('Update failed: ' + e.message));
    } }, 'f').name('Update selected preset');
    p.add({ f: () => {
      if (!fp.selected || fp.selected.startsWith(BUILTIN)) return note('Built-in presets cannot be deleted');
      deletePreset('finales', fp.selected).then(async () => { fp.selected = ''; await refreshSaved(); rebuild(); note('Deleted'); }).catch((e) => note('Delete failed: ' + e.message));
    } }, 'f').name('Delete selected preset');
    return f;
  }

  function variationFolder() {
    const f = fShot.addFolder('Physics variation'), v = state.shot.variation;
    if (!openState.variation) f.close();
    f.onOpenClose((g) => { openState.variation = !g._closed; });
    f.add(v, 'enabled').name('randomise physics per launch');
    f.add(v, 'burstVel', 0, 100, 1).name('burst velocity (%)'); f.add(v, 'lifetime', 0, 100, 1).name('star lifetime (%)');
    f.add(v, 'smokeAmount', 0, 100, 1).name('smoke amount (%)'); f.add(v, 'smokeLife', 0, 100, 1).name('smoke lifetime (%)');
    f.add(v, 'launchSpeed', 0, 100, 1).name('launch speed (%, finale: always on)');
    f.add(v, 'seed', 0, 100000, 1).name('variation seed');
    return f;
  }

  function rebuild() {
    dyn.forEach((f) => f.destroy()); dyn = [];
    const layers = fShot.addFolder('Layers');
    layers.add({ f: () => { state.shot.layers.push(newLayer('peony', {}, state.shot.layers)); rebuild(); } }, 'f').name('+ add layer');
    state.shot.layers.forEach((l, i) => layerFolder(layers, l, i));
    dyn.push(layers);
    if (state.shot.finale.enabled) dyn.push(finaleFolder());
    if (state.shot.layers.filter((l) => l.enabled).length > 1 || state.shot.finale.enabled) dyn.push(variationFolder());
  }
  rebuild();
  refreshSaved().then(() => rebuild());
  app.rebuildShotUI = rebuild;
}
