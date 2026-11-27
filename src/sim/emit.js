// Burst context handed to library types. Turns declarative star specs into pool particles.
import * as F from './fields.js';
import { RNG } from './rng.js';
import { PALETTES, resolvePalette } from '../library/palettes.js';
import { trail as trailPreset } from '../library/common.js';

const GOLDEN = 2.399963229728653;

function randomBasis(rng) {
  const n = rng.unit([0, 0, 0]);
  const t = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let ux = n[1] * t[2] - n[2] * t[1], uy = n[2] * t[0] - n[0] * t[2], uz = n[0] * t[1] - n[1] * t[0];
  const l = Math.hypot(ux, uy, uz); ux /= l; uy /= l; uz /= l;
  const wx = n[1] * uz - n[2] * uy, wy = n[2] * ux - n[0] * uz, wz = n[0] * uy - n[1] * ux;
  return { n, u: [ux, uy, uz], w: [wx, wy, wz] };
}

// Direction generators: low-discrepancy (fibonacci) spacing like packed shell stars, randomly oriented.
function genDirs(kind, n, rng, opts) {
  const d = new Float32Array(n * 3);
  const phi0 = rng.next() * 6.28;
  if (kind === 'ring') {
    // Ring orientation is a WORLD-space property (orbiting the camera shows the ring from other sides). The ring normal is
    // tilted from world +Z (the default view axis) by `tilt` degrees, then rolled about +Z by `rotation`. Random (seeded) tilt is 20-60 deg.
    const L = opts.layer || {};
    const tilt = (L.randomTilt === false ? (L.tilt ?? 40) : rng.range(20, 60)) * Math.PI / 180;
    const roll = (L.randomTilt === false ? (L.rotation ?? 0) : rng.range(0, 360)) * Math.PI / 180;
    const nrm = [-Math.sin(tilt) * Math.sin(roll), Math.sin(tilt) * Math.cos(roll), Math.cos(tilt)];
    const u = [Math.cos(roll), Math.sin(roll), 0];
    const w = [nrm[1] * u[2] - nrm[2] * u[1], nrm[2] * u[0] - nrm[0] * u[2], nrm[0] * u[1] - nrm[1] * u[0]];
    const B = { n: nrm, u, w }, off = rng.next() * 6.28, th = opts.thickness ?? 0.05;
    for (let i = 0; i < n; i++) {
      const a = off + (i + rng.range(-0.25, 0.25)) / n * 6.2832;
      const c = Math.cos(a), s = Math.sin(a), z = rng.gauss() * th;
      for (let k = 0; k < 3; k++) d[i * 3 + k] = B.u[k] * c + B.w[k] * s + B.n[k] * z;
    }
  } else {
    const y1 = 1, y0 = kind === 'cone' ? Math.cos((opts.angle ?? 60) * Math.PI / 180) : -1;
    const B = kind === 'cone' ? null : randomBasis(rng);
    for (let i = 0; i < n; i++) {
      const y = y1 - (y1 - y0) * (i + 0.5 + rng.range(-0.3, 0.3)) / n, r = Math.sqrt(Math.max(0, 1 - y * y)), p = phi0 + i * GOLDEN;
      let x = r * Math.cos(p), z = r * Math.sin(p), yy = y;
      if (B) { // random orientation of the lattice
        const a = x, b = yy, c = z;
        x = B.u[0] * a + B.n[0] * b + B.w[0] * c; yy = B.u[1] * a + B.n[1] * b + B.w[1] * c; z = B.u[2] * a + B.n[2] * b + B.w[2] * c;
      }
      d[i * 3] = x; d[i * 3 + 1] = yy; d[i * 3 + 2] = z;
    }
  }
  return d;
}

export function makeCtx(w, layer, origin, shellVel, fire) {
  // each launch owns RNG streams (keyed by seed, layer id, launch index), so editing one layer never reshuffles the others
  const rng = fire.rng, P = w.P, lp = fire.lp;
  // slow, large-scale asymmetry shared by every star of this layer (real shells are never perfectly round)
  const A = rng.unit([0, 0, 0]), Bv = rng.unit([0, 0, 0]);
  const asymA = rng.range(0.03, 0.09), asymB = rng.range(0.02, 0.06);
  let maxR = 0, total = 0;
  const palette = resolvePalette(layer, 'main', 'Gold');

  const ctx = {
    rng, layer, origin, cloud: 1,   // multiplier of the central smoke cloud left at the break (types may lower it)
    // colour components chosen per layer (palette name or custom colour); `fallback` applies when the layer leaves it unset
    has(comp) { const n = layer[{ main: 'palette', secondary: 'palette2', trail: 'palette3' }[comp]]; return n === 'Custom' || !!PALETTES[n]; },
    pal(comp, fallback) { return comp === 'main' ? palette : resolvePalette(layer, comp, fallback); },
    // trail spark preset; the layer's trail colour (if set) replaces the preset's colour
    trail(name, over = {}) {
      const t = trailPreset(name, over), set = layer.palette3;
      if (set && (set === 'Custom' || PALETTES[set])) t.color = resolvePalette(layer, 'trail')[0].c;
      return t;
    },
    stars(spec) {
      const n = Math.max(1, Math.round(spec.n * layer.stars));
      const R = spec.radius * layer.expanse;
      const k0 = spec.k, T = spec.T ?? 2.2;
      const v0 = (Math.exp(k0 * R) - 1) / (k0 * T) * lp.burstVel;
      maxR = Math.max(maxR, R); total += n;
      const dirs = typeof spec.dirs === 'function' ? spec.dirs(n, rng) : genDirs(spec.dirs || 'sphere', n, rng, { ...spec, layer });
      const pal = Array.isArray(spec.palette) ? spec.palette : spec.palette ? (PALETTES[spec.palette] || palette) : palette;
      const shiftPal = spec.shift && spec.shift.palette ? (Array.isArray(spec.shift.palette) ? spec.shift.palette : PALETTES[spec.shift.palette]) : null;
      const speedVar = spec.speedVar ?? 0.05;
      let trailIdx = 0, evIdx = 0;
      if (spec.trail) { w.trailSpecs.push(spec.trail); trailIdx = w.trailSpecs.length - 1; }
      if (spec.event) {
        const ev = { ...spec.event };
        if (ev.child && ev.child.trail) { w.trailSpecs.push(ev.child.trail); ev.child = { ...ev.child, trailIdx: w.trailSpecs.length - 1 }; }
        w.evSpecs.push(ev); evIdx = w.evSpecs.length - 1;
      }
      for (let i = 0; i < n; i++) {
        const o = w.addLight(); if (o < 0) return;
        const L = w.L;
        let dx = dirs[i * 3], dy = dirs[i * 3 + 1], dz = dirs[i * 3 + 2];
        const j = 0.025 * P.spread * (spec.jitter ?? 1);
        dx += rng.gauss() * j; dy += rng.gauss() * j; dz += rng.gauss() * j;
        const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
        const asym = 1 + asymA * (dx * A[0] + dy * A[1] + dz * A[2]) + asymB * Math.pow(dx * Bv[0] + dy * Bv[1] + dz * Bv[2], 2) * 2 - asymB * 0.6;
        const sp = v0 * asym * (1 + rng.gauss() * speedVar * P.spread) * (spec.speedMul ?? 1);
        const k = Math.max(0.002, spec.k * P.drag * (1 + Math.max(-0.35, Math.min(0.35, rng.gauss() * 0.14))));
        L.fill(0, o, o + F.S);
        L[o + F.PX] = origin[0]; L[o + F.PY] = origin[1]; L[o + F.PZ] = origin[2];
        L[o + F.VX] = dx * sp + shellVel[0] * 0.5; L[o + F.VY] = dy * sp + shellVel[1] * 0.5; L[o + F.VZ] = dz * sp + shellVel[2] * 0.5;
        const life = rng.range(spec.life[0], spec.life[1]) * lp.lifetime * (1 + rng.gauss() * 0.06);
        L[o + F.LIFE] = Math.max(0.2, life); L[o + F.DRAG] = k;
        L[o + F.SIZE] = spec.size * (0.6 + 0.9 * rng.next() * rng.next() + 0.15);
        const e = pal[Math.floor(rng.next() * pal.length)];
        const rgb = spec.color || e.c;
        const gain = spec.color ? 1 : e.gain;
        L[o + F.INTEN] = spec.inten * gain * layer.bright * Math.exp(rng.gauss() * 0.42); L[o + F.LB] = layer.bright;
        L[o + F.R1] = rgb[0]; L[o + F.G1] = rgb[1]; L[o + F.B1] = rgb[2];
        let c2 = rgb;
        if (spec.shift) { c2 = spec.shift.color || (shiftPal ? shiftPal[Math.floor(rng.next() * shiftPal.length)].c : rgb); L[o + F.SHIFT] = spec.shift.at; }
        L[o + F.R2] = c2[0]; L[o + F.G2] = c2[1]; L[o + F.B2] = c2[2];
        L[o + F.KIND] = F.K_STAR;
        if (spec.trail) { L[o + F.TRATE] = spec.trail.rate * rng.range(0.7, 1.3); L[o + F.TSPEC] = trailIdx; }
        if (spec.strobe) { L[o + F.SHZ] = rng.range(spec.strobe[0], spec.strobe[1]); L[o + F.SDUTY] = spec.strobeDuty ?? 0.25; }
        L[o + F.PHASE] = rng.next() * 100;
        if (spec.event) {
          L[o + F.EVT] = spec.event.type === 'pop' ? F.EV_POP : F.EV_SPLIT;
          L[o + F.EVAT] = rng.range(spec.event.at[0], spec.event.at[1]); L[o + F.EVSPEC] = evIdx;
          L[o + F.LIFE] = Math.max(L[o + F.LIFE], L[o + F.EVAT] + 0.1);
        }
        L[o + F.GRAV] = spec.grav ?? 1;
        L[o + F.SMRATE] = rng.next() < (spec.smoke ?? 0.25) ? (spec.smokeRate ?? 1.2) : 0;
        L[o + F.LID] = fire.id; L[o + F.PUFF] = spec.puff ?? 0.35; L[o + F.PUFFR] = spec.puffScale ?? 1; L[o + F.SER] = fire.serial++;
        fire.stats.n++; fire.stats.speed += sp; fire.stats.life += L[o + F.LIFE]; fire.stats.radius += Math.log(1 + k * sp * 2.2) / k;
        L[o + F.FLK] = (spec.flicker ?? 0.5) * rng.range(0.5, 1.4);
      }
    },
    // finish the layer: flash + smoke puff at the break
    finish() {
      const sz = Math.max(0.8, maxR * 0.018);
      w.spawnFlash(origin[0], origin[1], origin[2], sz, 26 * layer.bright * Math.sqrt(total / 300), 0.32);
      w.spawnFlash(origin[0], origin[1], origin[2], sz * 3.5, 3.2 * layer.bright, 0.55);
      const np = Math.round(Math.min(110, 20 + total / 5) * lp.smokeAmount * ctx.cloud), sr = fire.rngS;
      for (let i = 0; i < np; i++) {
        const d = sr.unit([0, 0, 0]), rr = maxR * 0.5 * Math.cbrt(sr.next());
        const sp = maxR * sr.range(0.03, 0.14), vary = Math.exp(sr.gauss() * 0.35);   // mixed puff sizes: wisps and bigger billows
        w.addSmoke(origin[0] + d[0] * rr, origin[1] + d[1] * rr, origin[2] + d[2] * rr,
          d[0] * sp + shellVel[0] * 0.2, d[1] * sp + shellVel[1] * 0.2, d[2] * sp + shellVel[2] * 0.2,
          sr.range(10, 17) * lp.smokeLife, maxR * sr.range(0.07, 0.13) * vary, maxR * sr.range(0.28, 0.5) * vary, sr.range(0.06, 0.11), sr.range(-0.1, 0.12), 0, sr, fire.id);
      }
    },
  };
  return ctx;
}
