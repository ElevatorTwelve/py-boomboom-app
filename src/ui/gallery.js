// Preset gallery: picture cards for combo presets, built-in finales and saved finales, with search and tags.
// Thumbnails are drawn at run time with a second World and the same renderer; no image files are stored.
import * as THREE from 'three';
import { state, loadPreset, applyShot, defaultFinale, defaultVariation, VIEWS, SENSOR_H } from '../state.js';
import { PRESETS, TYPES, fillLayers } from '../library/index.js';
import { FINALE_PRESETS } from '../library/finales.js';
import { World } from '../sim/world.js';
import { toU16 } from '../export/exporter.js';
import { listPresets } from './presetsApi.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const TW = 256, TH = 144;
export const slug = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const LOOPS = '/preset-loops/';

function shotFor(layers, extra = {}) {
  const f = fillLayers(clone(layers));
  return { burstHeight: 170, launch: true, baseX: 0, baseZ: 0, ...extra, finale: { ...defaultFinale(), ...(extra.finale || {}) }, variation: { ...defaultVariation(), ...(extra.variation || {}) }, layers: f.layers };
}

export function buildGallery(app) {
  const root = h('div', 'pyb-gal'), head = h('div', 'pyb-gal-head'), search = document.createElement('input'), close = h('button', null, 'Close (Esc)');
  search.placeholder = 'Search presets or tags...'; search.setAttribute('aria-label', 'Search presets');
  head.append(h('b', null, 'Preset gallery'), search, close);
  const tagBar = h('div', 'pyb-gal-tags'), grid = h('div', 'pyb-gal-grid');
  root.append(head, tagBar, grid); document.body.append(root);

  let cards = [], activeTag = null, queue = [], busy = false, saved = {}, loops = new Map(), live = null;
  const world = new World(), cam = new THREE.PerspectiveCamera(30, TW / TH, 0.5, 20000);
  const v = VIEWS.Wide; cam.position.set(...v.position); cam.fov = THREE.MathUtils.radToDeg(2 * Math.atan(SENSOR_H / 2 / 24)); cam.lookAt(...v.target); cam.updateProjectionMatrix();
  const c2 = document.createElement('canvas'); c2.width = TW; c2.height = TH;

  function paint(card) {
    const r = app.renderer; if (!r) return;
    world.reset(card.shot.seed ?? 20260101, clone(card.shot), state.physics);
    while (world.burstLog.length === 0 && !world.finished && world.t < 60) world.step();
    const tb = world.burstLog[0] ? world.burstLog[0].t : 0;
    world.reset(card.shot.seed ?? 20260101, clone(card.shot), state.physics);
    const T = tb + 1.1, S = 0.02;
    world.advanceTo(T);
    const fin = r.render(world, cam, { width: TW, height: TH, samples: [[T, T + S]], el: state.elements, rp: state.render, target: 'float', alpha: 'black' });
    const f32 = r.readFloat(fin, new Float32Array(TW * TH * 4)), u16 = new Uint16Array(TW * TH * 4);
    toU16(f32, u16, TW, TH, true);
    const ctx = c2.getContext('2d'), img = ctx.createImageData(TW, TH);
    for (let i = 0; i < u16.length; i += 4) { img.data[i] = u16[i] >> 8; img.data[i + 1] = u16[i + 1] >> 8; img.data[i + 2] = u16[i + 2] >> 8; img.data[i + 3] = 255; }
    ctx.putImageData(img, 0, 0);
    const cv = card.canvas; cv.width = TW; cv.height = TH; cv.getContext('2d').drawImage(c2, 0, 0);
  }
  function pump() {
    if (busy) return; busy = true;
    const next = () => {
      const c = queue.shift(); if (!c || !root.classList.contains('open') || app.exporting) { busy = false; return; }
      try { paint(c); } catch { /* no thumbnail: the card still works */ }
      requestAnimationFrame(next);
    };
    requestAnimationFrame(next);
  }

  // Rollover. Built-in presets have pre-rendered loops (public/preset-loops, made by `npm run loops`): a poster picture, and a short
  // video that is created only while the pointer is over the card. Other presets (your saved ones) play live, one card at a time.
  const loadLoops = () => fetch(LOOPS + 'index.json').then((r) => (r.ok ? r.json() : null)).then((j) => { loops = new Map((j?.presets || []).map((p) => [p.name, p.slug])); }).catch(() => { loops = new Map(); });
  function stopLive() { if (live) { cancelAnimationFrame(live.raf); const c = live.card; live = null; try { paint(c); } catch { /* keep the old picture */ } } }
  function startLive(card) {
    stopLive(); const r = app.renderer; if (!r || app.exporting) return;
    world.reset(card.shot.seed ?? 20260101, clone(card.shot), state.physics);
    while (world.burstLog.length === 0 && !world.finished && world.t < 60) world.step();
    const tb = world.burstLog[0] ? world.burstLog[0].t : 0;
    world.reset(card.shot.seed ?? 20260101, clone(card.shot), state.physics);
    const st = { card, T: Math.max(0, tb - 0.4), end: Math.max(0, tb - 0.4) + (card.kind === 'combo' ? 3.6 : 5.5), last: performance.now(), raf: 0 };
    live = st;
    const tick = (now) => {
      if (live !== st) return;
      st.T += Math.min(0.05, (now - st.last) / 1000); st.last = now;
      if (st.T > st.end || app.exporting) { stopLive(); return; }
      try {
        world.advanceTo(st.T);
        const fin = r.render(world, cam, { width: TW, height: TH, samples: [[st.T, st.T + 0.02]], el: state.elements, rp: state.render, target: 'float', alpha: 'black' });
        const f32 = r.readFloat(fin, new Float32Array(TW * TH * 4)), u16 = new Uint16Array(TW * TH * 4);
        toU16(f32, u16, TW, TH, true);
        const ctx = c2.getContext('2d'), img = ctx.createImageData(TW, TH);
        for (let i = 0; i < u16.length; i += 4) { img.data[i] = u16[i] >> 8; img.data[i + 1] = u16[i + 1] >> 8; img.data[i + 2] = u16[i + 2] >> 8; img.data[i + 3] = 255; }
        ctx.putImageData(img, 0, 0); card.canvas.getContext('2d').drawImage(c2, 0, 0);
      } catch { stopLive(); return; }
      st.raf = requestAnimationFrame(tick);
    };
    st.raf = requestAnimationFrame(tick);
  }
  function attachHover(el, c) {
    let vid = null;
    const enter = () => {
      if (c.loop) {
        if (vid) return;
        vid = document.createElement('video'); vid.muted = true; vid.loop = true; vid.playsInline = true; vid.src = LOOPS + c.loop + '.mp4'; vid.setAttribute('aria-hidden', 'true');
        vid.addEventListener('playing', () => vid && vid.classList.add('on'));
        c.thumb.append(vid); vid.play().catch(() => {});
      } else startLive(c);
    };
    const leave = () => { if (vid) { vid.pause(); vid.removeAttribute('src'); vid.load(); vid.remove(); vid = null; } else if (live && live.card === c) stopLive(); };
    el.addEventListener('pointerenter', enter); el.addEventListener('pointerleave', leave); el.addEventListener('focus', enter); el.addEventListener('blur', leave);
  }

  const tagsOf = (layers, finale) => {
    const t = new Set(); for (const l of layers) { const n = TYPES[l.type]?.name; if (n) t.add(n.toLowerCase()); }
    if (finale) t.add('finale'); else if (layers.length > 1) t.add('combo'); else t.add('single');
    return [...t];
  };
  function collect() {
    const out = [];
    for (const [name, layers] of Object.entries(PRESETS)) out.push({ name, kind: 'combo', shot: shotFor(layers), tags: tagsOf(layers, false) });
    for (const [name, fn] of Object.entries(FINALE_PRESETS)) { const d = fn(); out.push({ name, kind: 'finale', data: d, shot: shotFor(d.layers, d), tags: tagsOf(d.layers, true) }); }
    for (const [name, d] of Object.entries(saved)) if (d && d.layers) out.push({ name, kind: 'saved', data: d, shot: shotFor(d.layers, d), tags: [...tagsOf(d.layers, !!(d.finale && d.finale.enabled)), 'saved'] });
    return out;
  }
  function load(c) {
    if (app.exporting) return app.notify('An export is running. Wait for it or cancel it.');
    if (c.kind === 'combo') { loadPreset(c.name); applyShot({ layers: state.shot.layers }, { reset: true }); }
    else { const r = applyShot(c.data, { reset: true }); if (r.error) return app.notify(r.error); state.shot.finale.enabled = true; }
    app.refreshUI(); app.updateDeck?.(); app.fire(); app.notify(`Loaded "${c.name}"`); hide();
  }
  function render() {
    const q = search.value.trim().toLowerCase();
    grid.textContent = ''; queue = [];
    const all = new Set(cards.flatMap((c) => c.tags));
    tagBar.textContent = '';
    for (const t of [...all].sort()) { const b = h('button', activeTag === t ? 'on' : '', t); b.addEventListener('click', () => { activeTag = activeTag === t ? null : t; render(); }); tagBar.append(b); }
    for (const c of cards) {
      if (activeTag && !c.tags.includes(activeTag)) continue;
      if (q && !(c.name.toLowerCase().includes(q) || c.tags.some((t) => t.includes(q)))) continue;
      const el = h('button', 'pyb-card'); c.thumb = h('div', 'thumb'); c.loop = (c.kind !== 'saved' && loops.get(c.name)) || null;
      if (c.loop) { const im = document.createElement('img'); im.src = LOOPS + c.loop + '.jpg'; im.alt = ''; im.draggable = false; c.thumb.append(im); }
      else { c.canvas = document.createElement('canvas'); c.canvas.width = TW; c.canvas.height = TH; c.thumb.append(c.canvas); queue.push(c); }
      el.append(c.thumb, h('div', 't', c.name), h('div', 'g', c.tags.join(' - ')));
      el.addEventListener('click', () => { stopLive(); load(c); }); attachHover(el, c); grid.append(el);
    }
    if (!grid.children.length) grid.append(h('div', 'g', 'No preset matches. Clear the search or the tag.'));
    pump();
  }
  const hide = () => { stopLive(); root.classList.remove('open'); };
  async function show() {
    if (app.exporting) return app.notify('An export is running. Wait for it or cancel it.');
    try { saved = await listPresets('finales'); } catch { saved = {}; }
    await loadLoops();
    cards = collect(); root.classList.add('open'); render(); search.focus();
  }
  search.addEventListener('input', render); close.addEventListener('click', hide);
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  app.openGallery = show; app.closeGallery = hide; app.galleryOpen = () => root.classList.contains('open');
  return { show, hide };
}
