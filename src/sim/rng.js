// Seeded RNG (mulberry32) plus small helpers. Deterministic across runs.
export class RNG {
  constructor(seed = 1) { this.s = (seed >>> 0) || 1; }
  next() {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  gauss() {
    const u = Math.max(this.next(), 1e-9), v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283185307 * v);
  }
  unit(out = [0, 0, 0]) {
    const z = this.next() * 2 - 1, a = this.next() * 6.283185307, r = Math.sqrt(1 - z * z);
    out[0] = r * Math.cos(a); out[1] = z; out[2] = r * Math.sin(a);
    return out;
  }
}

// cheap deterministic hash noise used for flicker (pure function of its input)
export function hash1(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}
export function noise1(x) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return hash1(i) * (1 - u) + hash1(i + 1) * u;
}
export const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// order-sensitive 32-bit mix of integers, used to key independent RNG streams (seed, layer id, launch index, ...)
export function mix32(...vals) {
  let x = 0x811c9dc5;
  for (const v of vals) { x ^= (v | 0); x = Math.imul(x, 16777619); x ^= x >>> 13; x = Math.imul(x, 0x85ebca6b); x ^= x >>> 16; }
  return x >>> 0;
}

// fixed-arity variants (no allocation) for per-particle, per-step random streams
export function mix4(a, b, c, d) {
  let x = 0x811c9dc5;
  x ^= a | 0; x = Math.imul(x, 16777619); x ^= x >>> 13; x = Math.imul(x, 0x85ebca6b); x ^= x >>> 16;
  x ^= b | 0; x = Math.imul(x, 16777619); x ^= x >>> 13; x = Math.imul(x, 0x85ebca6b); x ^= x >>> 16;
  x ^= c | 0; x = Math.imul(x, 16777619); x ^= x >>> 13; x = Math.imul(x, 0x85ebca6b); x ^= x >>> 16;
  x ^= d | 0; x = Math.imul(x, 16777619); x ^= x >>> 13; x = Math.imul(x, 0x85ebca6b); x ^= x >>> 16;
  return x >>> 0;
}
