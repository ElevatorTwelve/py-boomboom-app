// CPU-side conversion of simulation state into GPU instance buffers (no three.js here).
import * as F from '../sim/fields.js';
import { emission } from '../sim/appearance.js';
import { smoothstep } from '../sim/rng.js';

export const LIGHT_STRIDE = 10;  // p0(3) p1(3) rgb(3) size
export const SMOKE_STRIDE = 14;  // pos(3) size rot alpha lit(3) seed lightDir(3) ambientScale
export const MAX_LIGHTS = 2400000, MAX_SMOKE = 400000, MAX_SRC = 1700000;   // at least the pool maximum (1.6 M particles + the extra glow instance of each star)
const GN = 24, CELLS = GN * GN * GN;
const GRID_GAIN = 1300;   // calibrates the blurred energy field to the smoke lighting level

const SHELL_LOOK = { gold: [1.5, 0.6, 0.16, 0.08], crackle: [1.5, 0.6, 0.16, 0.08], silver: [1.3, 1.35, 1.55, 0.08], spiral: [1.7, 0.7, 0.2, 0.08], dark: [0.7, 0.28, 0.08, 0.05] };

export class Prep {
  constructor() {
    this.lights = new Float32Array(MAX_LIGHTS * LIGHT_STRIDE);
    this.smokeFar = new Float32Array(MAX_SMOKE * SMOKE_STRIDE);
    this.smokeNear = new Float32Array(MAX_SMOKE * SMOKE_STRIDE);
    this.smokeTmp = new Float32Array(MAX_SMOKE * SMOKE_STRIDE);
    this.src = new Float32Array(MAX_SRC * 7);   // x y z w r g b
    this.keys = new Float32Array(MAX_SMOKE); this.order = new Uint32Array(MAX_SMOKE); this.buckets = new Uint32Array(4097);
    this.grid = new Float32Array(CELLS * 3); this.gridDir = new Float32Array(CELLS * 3); this.gridSrc = new Float32Array(CELLS * 3);
    this.tmpA = new Float32Array(CELLS * 3); this.tmpB = new Float32Array(CELLS * 3); this.ext = [1, 1, 1];
    this.nLights = 0; this.nFar = 0; this.nNear = 0; this.dropped = 0;   // dropped: instances or light sources that did not fit (reported, never silent)
    this.lo = [0, 0, 0]; this.inv = [1, 1, 1]; this.hasLight = false;
  }

  // Light instances for the shutter interval [ta, tb] (sim seconds). Also bins emitters into the light grid.
  buildLights(world, ta, tb, el, gain, lod = 1) {
    const L = world.L, out = this.lights, c = [0, 0, 0], n = world.nL, t0 = world.t, src = this.src;
    const da = ta - t0, db = tb - t0;
    let m = 0, ns = 0;
    let lx = 1e9, ly = 1e9, lz = 1e9, hx = -1e9, hy = -1e9, hz = -1e9;
    for (let i = 0; i < n; i++) {
      if (m >= MAX_LIGHTS - 2) { this.dropped += n - i; break; }
      const o = i * F.S;
      if (L[o + F.AGE] < 0) continue;
      const kind = L[o + F.KIND];
      let lw = 1;
      if (lod > 1 && (kind === F.K_SPARK || kind === F.K_TAIL)) { if (((Math.imul(L[o + F.SER] | 0, 0x9e3779b1) >>> 8) % lod) !== 0) continue; lw = lod; }   // preview LOD: a stable hash of the spark's serial picks every lod-th spark (no shimmer), brighter
      const show = kind === F.K_STAR ? el.stars : kind === F.K_SPARK ? el.trails : kind === F.K_TAIL ? el.launch : kind === F.K_FLASH ? el.flash : el.stars;
      const I = emission(L, o, c) * lw;
      const x = L[o + F.PX], y = L[o + F.PY], z = L[o + F.PZ];
      const sz = L[o + F.SIZE];
      // smoke is lit by every emitter, even hidden ones, so element toggles never change smoke lighting
      if (I > 0.05 && kind !== F.K_TAIL && !(kind === F.K_FLASH && y < 8) && ns >= MAX_SRC) this.dropped++;
      if (I > 0.05 && kind !== F.K_TAIL && !(kind === F.K_FLASH && y < 8) && ns < MAX_SRC) {   // ground flashes do not light the smoke (they would stretch the light box)
        const w = I * (0.02 + 0.06 * sz * sz) * (kind === F.K_SPARK ? 0.35 : 1), q = ns * 7;
        src[q] = x; src[q + 1] = y; src[q + 2] = z; src[q + 3] = w; src[q + 4] = c[0]; src[q + 5] = c[1]; src[q + 6] = c[2];
        ns++;
        if (x < lx) lx = x; if (x > hx) hx = x; if (y < ly) ly = y; if (y > hy) hy = y; if (z < lz) lz = z; if (z > hz) hz = z;
      }
      if (!show || I < 0.004) continue;
      const vx = L[o + F.VX], vy = L[o + F.VY], vz = L[o + F.VZ], k = m * LIGHT_STRIDE;
      const g = I * gain;
      out[k] = x + vx * da; out[k + 1] = y + vy * da; out[k + 2] = z + vz * da;
      out[k + 3] = x + vx * db; out[k + 4] = y + vy * db; out[k + 5] = z + vz * db;
      out[k + 6] = c[0] * g; out[k + 7] = c[1] * g; out[k + 8] = c[2] * g; out[k + 9] = sz;
      m++;
      if (kind === F.K_STAR) {   // short persistent glow (emission integrated over the trailing ~0.1 s)
        const k2 = m * LIGHT_STRIDE, gt = g * 0.3;
        out[k2] = x + vx * (da - 0.1); out[k2 + 1] = y + vy * (da - 0.1); out[k2 + 2] = z + vz * (da - 0.1);
        out[k2 + 3] = out[k]; out[k2 + 4] = out[k + 1]; out[k2 + 5] = out[k + 2];
        out[k2 + 6] = c[0] * gt; out[k2 + 7] = c[1] * gt; out[k2 + 8] = c[2] * gt; out[k2 + 9] = sz * 0.8;
        m++;
      }
    }
    if (el.launch) for (const s of world.shells) {
      const st = SHELL_LOOK[s.style];
      if (!st) continue;   // style 'none': the shell is invisible until it bursts
      if (m >= MAX_LIGHTS - 1) break;
      const k = m * LIGHT_STRIDE;
      out[k] = s.x + s.vx * da; out[k + 1] = s.y + s.vy * da; out[k + 2] = s.z + s.vz * da;
      out[k + 3] = s.x + s.vx * db; out[k + 4] = s.y + s.vy * db; out[k + 5] = s.z + s.vz * db;
      out[k + 6] = st[0] * gain; out[k + 7] = st[1] * gain; out[k + 8] = st[2] * gain; out[k + 9] = st[3];
      m++;
    }
    this.nLights = m;
    this.buildGrid(ns, lx, ly, lz, hx, hy, hz);
  }

  // Light field for the smoke: emitter energy is binned into a coarse grid and diffused with a cascade of separable
  // gaussians (10 m, 25 m, 60 m), weighted to give a steep, local, roughly power-law falloff. It is cheap enough to cover
  // a wide finale site, and the per-cell light direction is the gradient of the field.
  buildGrid(ns, lx, ly, lz, hx, hy, hz) {
    const G = this.grid, D = this.gridDir, src = this.src;
    G.fill(0); D.fill(0); this.hasLight = ns > 0;
    if (!ns) return;
    // box snapped outward to a 30 m lattice, so small changes of the emitter bounds do not rescale the cells (lighting pops)
    const lo = this.lo, inv = this.inv, pad = 14, ext = this.ext, q = 30, snap = (v, up) => (up ? Math.ceil(v / q) : Math.floor(v / q)) * q;
    const x0 = snap(lx - pad, false), x1 = snap(hx + pad, true), y0 = snap(ly - pad, false), y1 = snap(hy + pad, true), z0 = snap(lz - pad, false), z1 = snap(hz + pad, true);
    ext[0] = Math.max(60, x1 - x0); ext[1] = Math.max(60, y1 - y0); ext[2] = Math.max(60, z1 - z0);
    lo[0] = x0; lo[1] = y0; lo[2] = z0;
    for (let a = 0; a < 3; a++) inv[a] = GN / ext[a];
    const S = this.gridSrc; S.fill(0);
    for (let i = 0; i < ns; i++) {
      const q = i * 7;
      const ix = Math.min(GN - 1, Math.max(0, Math.floor((src[q] - lo[0]) * inv[0])));
      const iy = Math.min(GN - 1, Math.max(0, Math.floor((src[q + 1] - lo[1]) * inv[1])));
      const iz = Math.min(GN - 1, Math.max(0, Math.floor((src[q + 2] - lo[2]) * inv[2])));
      const j = ((iz * GN + iy) * GN + ix) * 3, w = src[q + 3];
      S[j] += src[q + 4] * w; S[j + 1] += src[q + 5] * w; S[j + 2] += src[q + 6] * w;
    }
    const sig = [10, 25, 60], wts = [3, 5, 7.7];
    let prev = S, prevSig = 0;
    for (let st = 0; st < 3; st++) {
      const extra = Math.sqrt(Math.max(sig[st] * sig[st] - prevSig * prevSig, 1e-6));
      const out = this.tmpA === prev ? this.tmpB : this.tmpA;
      this.blur3(prev, out, extra, ext);
      const w = wts[st] * GRID_GAIN / (sig[st] ** 3 * 15.75);   // energy -> density of a gaussian blob (2*pi)^1.5 sigma^3
      for (let c = 0; c < CELLS * 3; c++) G[c] += out[c] * w;
      prev = out; prevSig = sig[st];
    }
    // light direction = normalised gradient of the field luminance
    const lum = (c) => G[c * 3] + G[c * 3 + 1] + G[c * 3 + 2], at = (x, y, z) => lum((Math.min(GN - 1, Math.max(0, z)) * GN + Math.min(GN - 1, Math.max(0, y))) * GN + Math.min(GN - 1, Math.max(0, x)));
    for (let z = 0; z < GN; z++) for (let y = 0; y < GN; y++) for (let x = 0; x < GN; x++) {
      const c = (z * GN + y) * GN + x;
      const gx = (at(x + 1, y, z) - at(x - 1, y, z)) / ext[0], gy = (at(x, y + 1, z) - at(x, y - 1, z)) / ext[1], gz = (at(x, y, z + 1) - at(x, y, z - 1)) / ext[2];
      const l = Math.hypot(gx, gy, gz) || 1; D[c * 3] = gx / l; D[c * 3 + 1] = gy / l || 1; D[c * 3 + 2] = gz / l;
    }
  }

  // separable gaussian blur of a 3-channel GN^3 grid (sigma in metres; the box extent maps cells to metres)
  blur3(src, dst, sigma, ext) {
    const tmp = this.tmpC || (this.tmpC = new Float32Array(CELLS * 3)), tmp2 = this.tmpD || (this.tmpD = new Float32Array(CELLS * 3));
    const pass = (a, b, axis) => {
      const s = Math.max(0.35, sigma / (ext[axis] / GN)), R = Math.min(12, Math.ceil(3 * s));
      const ker = new Float32Array(2 * R + 1); let ks = 0;
      for (let i = -R; i <= R; i++) { ker[i + R] = Math.exp(-0.5 * i * i / (s * s)); ks += ker[i + R]; }
      for (let i = 0; i < ker.length; i++) ker[i] /= ks;
      const stride = axis === 0 ? 1 : axis === 1 ? GN : GN * GN;
      for (let z = 0; z < GN; z++) for (let y = 0; y < GN; y++) for (let x = 0; x < GN; x++) {
        const c = (z * GN + y) * GN + x, pos = axis === 0 ? x : axis === 1 ? y : z;
        let r = 0, g = 0, bl = 0;
        for (let k = -R; k <= R; k++) {
          const p = pos + k; if (p < 0 || p >= GN) continue;
          const q = (c + k * stride) * 3, w = ker[k + R];
          r += a[q] * w; g += a[q + 1] * w; bl += a[q + 2] * w;
        }
        b[c * 3] = r; b[c * 3 + 1] = g; b[c * 3 + 2] = bl;
      }
    };
    pass(src, tmp, 0); pass(tmp, tmp2, 1); pass(tmp2, dst, 2);
  }

  sampleGrid(x, y, z, out, dir) {
    const lo = this.lo, inv = this.inv, G = this.grid, D = this.gridDir;
    const fx = Math.min(GN - 1.001, Math.max(0, (x - lo[0]) * inv[0] - 0.5));
    const fy = Math.min(GN - 1.001, Math.max(0, (y - lo[1]) * inv[1] - 0.5));
    const fz = Math.min(GN - 1.001, Math.max(0, (z - lo[2]) * inv[2] - 0.5));
    const ix = fx | 0, iy = fy | 0, iz = fz | 0, tx = fx - ix, ty = fy - iy, tz = fz - iz;
    out[0] = out[1] = out[2] = 0; dir[0] = dir[1] = dir[2] = 0;
    const ex = this.ext, od = Math.max(0, lo[0] - x, x - (lo[0] + ex[0]), lo[1] - y, y - (lo[1] + ex[1]), lo[2] - z, z - (lo[2] + ex[2])), fall = od > 0 ? Math.exp(-od / 35) : 1;
    for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const w = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (dz ? tz : 1 - tz);
      const j = (((iz + dz) * GN + iy + dy) * GN + ix + dx) * 3;
      out[0] += G[j] * w; out[1] += G[j + 1] * w; out[2] += G[j + 2] * w;
      dir[0] += D[j] * w; dir[1] += D[j + 1] * w; dir[2] += D[j + 2] * w;
    }
    out[0] *= fall; out[1] *= fall; out[2] *= fall;
    const l = Math.hypot(dir[0], dir[1], dir[2]) || 1; dir[0] /= l; dir[1] /= l; dir[2] /= l;
  }

  // Smoke instances sorted back to front, split into a far set (drawn before the stars) and a near set (after),
  // using the view depth of the current burst. Lit by nearby burning stars; the ambient term is added in the shader.
  buildSmoke(world, tb, cam, density, lightGain, el) {
    const M = world.M, n = world.nM, d = tb - world.t, out = this.smokeTmp;
    const keys = this.keys, c = [0, 0, 0], ld = [0, 0, 0];
    const f = cam.fwd, p = cam.pos;
    let kmin = 1e9, kmax = -1e9, m = 0;
    for (let i = 0; i < n; i++) {
      const o = i * F.SS, age = M[o + F.SAGE], life = M[o + F.SLIFE], u = age / life;
      if (M[o + F.SKIND] === 1 && !el.launch) continue;
      const a = M[o + F.SDENS] * density * smoothstep(0, 4, age) * Math.pow(1 - u, 1.1);
      if (a < 0.0004) continue;
      const x = M[o + F.SPX] + M[o + F.SVX] * d, y = M[o + F.SPY] + M[o + F.SVY] * d, z = M[o + F.SPZ] + M[o + F.SVZ] * d;
      const rr = M[o + F.SR0] + (M[o + F.SR1] - M[o + F.SR0]) * (1 - Math.exp(-age / (0.28 * life)));
      if (this.hasLight) this.sampleGrid(x, y, z, c, ld); else { c[0] = c[1] = c[2] = 0; ld[0] = 0; ld[1] = 1; ld[2] = 0; }
      { const mx = Math.max(c[0], c[1], c[2]) * lightGain, sc = lightGain / (1 + 2.2 * mx); c[0] *= sc / lightGain; c[1] *= sc / lightGain; c[2] *= sc / lightGain; }   // soft-limit very bright lit smoke
      const k = m * SMOKE_STRIDE;
      out[k] = x; out[k + 1] = y; out[k + 2] = z; out[k + 3] = rr; out[k + 4] = M[o + F.SROT] + age * 0.04; out[k + 5] = a;
      out[k + 6] = c[0] * lightGain; out[k + 7] = c[1] * lightGain; out[k + 8] = c[2] * lightGain; out[k + 9] = M[o + F.SSEED] + age * 0.03;
      out[k + 10] = ld[0]; out[k + 11] = ld[1]; out[k + 12] = ld[2];
      out[k + 13] = 0.25 + 0.75 * smoothstep(1.5, 8, age);   // young, dense smoke is dominated by the burst light; sky light takes over as it ages
      const key = (x - p[0]) * f[0] + (y - p[1]) * f[1] + (z - p[2]) * f[2];
      keys[m] = key; if (key < kmin) kmin = key; if (key > kmax) kmax = key;
      m++;
    }
    const fo = world.focus, split = fo ? (fo[0] - p[0]) * f[0] + (fo[1] - p[1]) * f[1] + (fo[2] - p[2]) * f[2] : -1e9;
    // counting sort by depth (far first)
    const B = this.buckets, NB = 4096, scale = (NB - 1) / Math.max(1e-6, kmax - kmin);
    B.fill(0);
    for (let i = 0; i < m; i++) B[NB - 1 - Math.floor((keys[i] - kmin) * scale) + 1]++;
    for (let i = 1; i <= NB; i++) B[i] += B[i - 1];
    const ord = this.order;
    for (let i = 0; i < m; i++) ord[B[NB - 1 - Math.floor((keys[i] - kmin) * scale)]++] = i;
    let nFar = 0; for (let i = 0; i < m; i++) if (keys[i] > split) nFar++;
    const S = SMOKE_STRIDE;
    for (let i = 0; i < m; i++) {
      const a = ord[i] * S, dst = i < nFar ? this.smokeFar : this.smokeNear, b = (i < nFar ? i : i - nFar) * S;
      for (let q = 0; q < S; q++) dst[b + q] = out[a + q];
    }
    this.nFar = nFar; this.nNear = m - nFar;
  }
}
