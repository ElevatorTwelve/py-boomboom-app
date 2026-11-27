// Dial deck: rotary dials (drag up/down, wheel, arrow keys, double-click = reset) and sliders bound to the same state the panel uses.
import { state } from '../state.js';
import { defaultPhysics } from '../sim/world.js';
import { dock } from './dock.js';

const NS = 'http://www.w3.org/2000/svg';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const pol = (r, deg) => { const a = (deg - 90) * Math.PI / 180; return [31 + r * Math.cos(a), 31 + r * Math.sin(a)]; };
const arc = (r, a0, a1) => { const [x0, y0] = pol(r, a0), [x1, y1] = pol(r, a1); return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} ${a1 > a0 ? 1 : 0} ${x1.toFixed(2)} ${y1.toFixed(2)}`; };
const fmt = (v, step) => (step >= 1 ? v.toFixed(0) : step >= 0.1 ? v.toFixed(1) : v.toFixed(2));

// obj[key] is the bound value. Returns { el, update }.
export function makeDial({ obj, key, label, min, max, step = 0.01, def, unit = '', bipolar = false, onInput }) {
  const root = h('div', 'pyb-dial'); root.tabIndex = 0; root.setAttribute('role', 'slider');
  root.setAttribute('aria-label', label); root.setAttribute('aria-valuemin', min); root.setAttribute('aria-valuemax', max);
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 62 62');
  const mk = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); svg.appendChild(e); return e; };
  mk('circle', { cx: 31, cy: 31, r: 20, fill: '#162024', stroke: '#2f4047', 'stroke-width': 1.5 });
  mk('path', { d: arc(27, -135, 135), fill: 'none', stroke: '#243238', 'stroke-width': 4, 'stroke-linecap': 'round' });
  const val = mk('path', { fill: 'none', stroke: '#ee4f48', 'stroke-width': 4, 'stroke-linecap': 'round' });
  const ptr = mk('line', { x1: 31, y1: 31, x2: 31, y2: 15, stroke: '#37c3b3', 'stroke-width': 3, 'stroke-linecap': 'round' });
  const lbl = h('div', 'lbl', label), out = h('div', 'val');
  root.append(svg, out, lbl);
  const draw = () => {
    const v = clamp(obj[key], min, max), r = (v - min) / (max - min), ang = -135 + 270 * r;
    const from = bipolar ? 0 : -135, to = ang;
    val.setAttribute('d', Math.abs(to - from) < 0.5 ? '' : arc(27, Math.min(from, to), Math.max(from, to)));
    const [x, y] = pol(16, ang); ptr.setAttribute('x2', x); ptr.setAttribute('y2', y);
    out.textContent = fmt(v, step) + unit; root.setAttribute('aria-valuenow', v);
  };
  const set = (v) => { v = clamp(Math.round(v / step) * step, min, max); if (v === obj[key]) return; obj[key] = v; draw(); onInput?.(v); };
  let drag = null;
  root.addEventListener('pointerdown', (e) => { drag = { y: e.clientY, v: obj[key] }; root.setPointerCapture(e.pointerId); root.focus({ preventScroll: true }); });
  root.addEventListener('pointermove', (e) => { if (!drag) return; set(drag.v + (drag.y - e.clientY) * (max - min) / (e.shiftKey ? 1200 : 200)); });
  const end = () => { drag = null; };
  root.addEventListener('pointerup', end); root.addEventListener('pointercancel', end);
  root.addEventListener('wheel', (e) => { e.preventDefault(); set(obj[key] - Math.sign(e.deltaY) * (max - min) / (e.shiftKey ? 400 : 60)); root.dispatchEvent(new Event('change', { bubbles: true })); }, { passive: false });
  root.addEventListener('keydown', (e) => {
    const s = (max - min) / (e.shiftKey ? 200 : 40), k = e.key;
    if (k === 'ArrowUp' || k === 'ArrowRight') set(obj[key] + s); else if (k === 'ArrowDown' || k === 'ArrowLeft') set(obj[key] - s); else return;
    e.preventDefault(); e.stopPropagation(); root.dispatchEvent(new Event('change', { bubbles: true }));
  });
  root.addEventListener('dblclick', () => { set(def); root.dispatchEvent(new Event('change', { bubbles: true })); });
  root.title = `${label}: drag up/down, mouse wheel or arrow keys. Double-click to reset. Hold Shift for fine steps.`;
  draw();
  return { el: root, update: () => { if (!drag) draw(); } };
}

export function makeSlider({ obj, key, label, min, max, step = 0.01, def, onInput }) {
  const root = h('div', 'pyb-slider'), row = h('div', 'row'), name = h('span', null, label), out = h('b');
  const inp = document.createElement('input'); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.setAttribute('aria-label', label);
  row.append(name, out); root.append(row, inp);
  const draw = () => { inp.value = obj[key]; out.textContent = fmt(+obj[key], step); };
  inp.addEventListener('input', () => { obj[key] = +inp.value; out.textContent = fmt(+inp.value, step); onInput?.(+inp.value); });
  inp.addEventListener('dblclick', () => { obj[key] = def; draw(); onInput?.(def); inp.dispatchEvent(new Event('change', { bubbles: true })); });
  root.title = `${label}: double-click to reset.`;
  draw();
  return { el: root, update: () => { if (document.activeElement !== inp) draw(); } };
}

export function buildDeck(app) {
  const P = state.physics, R = state.render, DP = defaultPhysics();
  const box = h('div', 'pyb-deck'), head = h('div', 'pyb-deck-head'), body = h('div', 'pyb-deck-body');
  const toggle = h('button', null, 'hide'); head.append(h('span', null, 'Dials and sliders'), toggle);
  toggle.addEventListener('click', () => { box.classList.toggle('closed'); toggle.textContent = box.classList.contains('closed') ? 'show' : 'hide'; });
  const items = [];
  const sync = () => app.updateGui?.();
  const dial = (obj, key, label, min, max, step, def, extra = {}) => { const d = makeDial({ obj, key, label, min, max, step, def, onInput: sync, ...extra }); items.push(d); body.append(d.el); };
  const slider = (obj, key, label, min, max, step, def) => { const s = makeSlider({ obj, key, label, min, max, step, def, onInput: sync }); items.push(s); body.append(s.el); };
  dial(P, 'gravity', 'Gravity', 0, 2.5, 0.01, DP.gravity);
  dial(P, 'windX', 'Wind X', -15, 15, 0.1, 0, { bipolar: true, unit: ' m/s' });
  dial(P, 'windZ', 'Wind Z', -15, 15, 0.1, 0, { bipolar: true, unit: ' m/s' });
  dial(P, 'turbulence', 'Turbulence', 0, 6, 0.01, 0);
  dial(P, 'drag', 'Air drag', 0.2, 3, 0.01, DP.drag);
  dial(P, 'burstVel', 'Burst power', 0.3, 2, 0.01, DP.burstVel);
  dial(P, 'lifetime', 'Star life', 0.3, 3, 0.01, DP.lifetime);
  body.append(h('div', 'pyb-sep'));
  const col = h('div'); col.style.cssText = 'display:grid;grid-template-columns:repeat(2,150px);gap:6px 16px';
  const sl = (obj, key, label, min, max, step, def) => { const s = makeSlider({ obj, key, label, min, max, step, def, onInput: sync }); items.push(s); col.append(s.el); };
  sl(R, 'exposure', 'Exposure (EV)', -4, 4, 0.01, 0); sl(R, 'bloomStrength', 'Bloom', 0, 1.5, 0.005, 0.22);
  sl(R, 'starGain', 'Star brightness', 0.1, 5, 0.01, 1.2); sl(P, 'timeScale', 'Time scale', 0.05, 3, 0.01, 1);
  body.append(col);
  box.append(head, body); dock().append(box);
  const update = () => items.forEach((i) => i.update());
  app.updateDeck = update;
  return { el: box, update, items };
}
