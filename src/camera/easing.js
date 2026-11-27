/** Easing library. All functions map [0,1] -> [0,1] (back/elastic/spring overshoot). */

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Build a CSS-style cubic-bezier easing function. */
export function cubicBezierEase(x1, y1, x2, y2) {
  x1 = clamp01(x1);
  x2 = clamp01(x2);
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (s) => ((ax * s + bx) * s + cx) * s;
  const sy = (s) => ((ay * s + by) * s + cy) * s;
  const dx = (s) => (3 * ax * s + 2 * bx) * s + cx;
  return (x) => {
    x = clamp01(x);
    let s = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(s) - x;
      const d = dx(s);
      if (Math.abs(e) < 1e-6 || Math.abs(d) < 1e-6) break;
      s -= e / d;
    }
    let lo = 0, hi = 1;
    if (s < 0 || s > 1 || Math.abs(sx(s) - x) > 1e-4) {
      s = x;
      for (let i = 0; i < 24; i++) {
        const v = sx(s);
        if (Math.abs(v - x) < 1e-6) break;
        if (v < x) lo = s; else hi = s;
        s = (lo + hi) / 2;
      }
    }
    return sy(s);
  };
}

const backC = 1.70158;

/** Named easings. Parametrised ones read `p` (overshoot / frequency / damping). */
export const EASINGS = {
  linear: (x) => x,
  'in-quad': (x) => x * x,
  'out-quad': (x) => 1 - (1 - x) * (1 - x),
  'in-out-quad': (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2),
  'in-cubic': (x) => x * x * x,
  'out-cubic': (x) => 1 - Math.pow(1 - x, 3),
  'in-out-cubic': (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  'in-quart': (x) => x ** 4,
  'out-quart': (x) => 1 - Math.pow(1 - x, 4),
  'in-out-quart': (x) => (x < 0.5 ? 8 * x ** 4 : 1 - Math.pow(-2 * x + 2, 4) / 2),
  'in-expo': (x) => (x === 0 ? 0 : Math.pow(2, 10 * x - 10)),
  'out-expo': (x) => (x === 1 ? 1 : 1 - Math.pow(2, -10 * x)),
  'in-out-expo': (x) =>
    x === 0 ? 0 : x === 1 ? 1 : x < 0.5 ? Math.pow(2, 20 * x - 10) / 2 : (2 - Math.pow(2, -20 * x + 10)) / 2,
  'out-back': (x, p = backC) => 1 + (p + 1) * Math.pow(x - 1, 3) + p * Math.pow(x - 1, 2),
  'in-back': (x, p = backC) => (p + 1) * x * x * x - p * x * x,
  'in-out-back': (x, p = backC) => {
    const c = p * 1.525;
    return x < 0.5
      ? (Math.pow(2 * x, 2) * ((c + 1) * 2 * x - c)) / 2
      : (Math.pow(2 * x - 2, 2) * ((c + 1) * (x * 2 - 2) + c) + 2) / 2;
  },
  /** Light elastic: p = oscillation damping (default 6). */
  'out-elastic': (x, p = 6) => (x === 0 ? 0 : x === 1 ? 1 : Math.pow(2, -p * x) * Math.sin((x * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
  /** Underdamped spring settle: p = damping ratio 0..1 (default 0.45). */
  spring: (x, p = 0.45) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const w = 2 * Math.PI * 1.6;
    const wd = w * Math.sqrt(1 - p * p);
    const s = x * 2.2;
    const osc = Math.exp(-p * w * s) * (Math.cos(wd * s) + ((p * w) / wd) * Math.sin(wd * s));
    return 1 - osc * (1 - x ** 4);
  },
  smooth: (x) => x * x * (3 - 2 * x),
  smoother: (x) => x * x * x * (x * (x * 6 - 15) + 10),
};

const cache = new Map();

/** @returns {boolean} true for a finite [x1,y1,x2,y2] cubic-bezier spec */
export const isBezierSpec = (spec) => Array.isArray(spec) && spec.length === 4 && spec.every((v) => Number.isFinite(v));

/**
 * Resolve an easing spec to a function.
 * @param {string|number[]|undefined} spec name, or [x1,y1,x2,y2] cubic-bezier control points
 * @returns {(x:number, p?:number)=>number}
 */
export function easingFn(spec) {
  if (typeof spec === 'function') return spec;
  if (isBezierSpec(spec)) {
    const k = spec.join(',');
    if (!cache.has(k)) cache.set(k, cubicBezierEase(...spec));
    return cache.get(k);
  }
  return EASINGS[spec] || EASINGS.linear;
}

/**
 * Apply an easing to x (clamped to 0..1 first).
 * @param {string|number[]} spec easing name or bezier points
 * @param {number} x progress 0..1
 * @param {number} [p] optional easing parameter (overshoot, damping)
 */
export function ease(spec, x, p) {
  return easingFn(spec)(clamp01(x), p);
}

/**
 * Time-mirrored easing 1 - f(1 - x): the same curve played as an exit (progress 0 = in place, 1 = gone).
 * @param {string|number[]|Function} spec
 * @returns {(x:number, p?:number)=>number}
 */
export function reverseEase(spec) {
  const f = easingFn(spec);
  return (x, p) => 1 - f(clamp01(1 - x), p);
}

/**
 * Sample an easing for drawing.
 * @param {string|number[]} spec
 * @param {number} [n] segments
 * @returns {number[]} n+1 values at x = i/n
 */
export function sampleEase(spec, n = 96) {
  const out = [];
  for (let i = 0; i <= n; i++) out.push(ease(spec, i / n));
  return out;
}

/** Default exit ease for an intro ease name: out-* <-> in-*, anything else unchanged (accelerate away instead of decelerate in). */
export function exitEaseName(name) {
  if (typeof name !== 'string') return name;
  if (name.startsWith('out-')) return `in-${name.slice(4)}`;
  if (name.startsWith('in-out-')) return name;
  if (name.startsWith('in-')) return `out-${name.slice(3)}`;
  return name;
}
