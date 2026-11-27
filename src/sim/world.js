// Deterministic particle world: fixed timestep, seeded RNG, no wall-clock dependence.
import { RNG, mix32, mix4 } from './rng.js';
import * as F from './fields.js';
import { makeCtx } from './emit.js';
import { TYPES } from '../library/index.js';

export const H = 1 / 120;       // fixed simulation step (s)
const CAP_START = 200000, CAP_MAX = 1600000, CAPS_START = 40000, CAPS_MAX = 400000;
const G = 9.81;
export const MIN_BURST_HEIGHT = 20;

export const defaultPhysics = () => ({
  burstVel: 1, drag: 1, gravity: 1, spread: 1,
  windX: 0, windZ: 0, turbulence: 0, lifetime: 1, timeScale: 1,
  smokeLife: 1, smokeAmount: 1,
});

export const MAX_REPEATS = 20;
const KDRAG = 0.0006;   // shell air drag

// ---- shell flight model --------------------------------------------------------------------------------------------
// A shell is launched with an initial velocity v0 and bursts at a fixed height yb (the burst height the user set, x1.03 as
// before). The slowest possible shell (launch speed multiplier <= 0.62) just reaches yb at its apex and bursts nearly
// stationary - that is exactly the shell of the previous version. A faster shell needs a larger v0 (found by bisection on
// the same drag + gravity integration the world uses), reaches yb sooner and is still climbing at the burst, so it hands its
// residual velocity to the stars. Flight time scales roughly with 0.62 / multiplier of the slowest (apex) time.
function climb(v0, g, stop) {
  let vy = v0, y = 1.5, t = 0;
  while (t < 120) { vy += (-g - KDRAG * Math.abs(vy) * vy) * H; y += vy * H; t += H; if (stop(y, vy)) break; }
  return { t, y, vy };
}
const flightCache = new Map();
export function shellFlight(Hset, gravity, mult) {
  const g = G * Math.max(0.05, gravity), hap = Hset * 1.03, m = Math.max(0.05, mult);
  const key = `${Hset}|${g}|${m}`;
  const hit = flightCache.get(key); if (hit) return hit;
  const vApex = Math.sqrt(g * (Math.exp(2 * KDRAG * hap) - 1) / KDRAG);
  let out;
  if (!Number.isFinite(vApex)) out = { v0: NaN, t: 0.15, yb: Hset, vb: 0 };
  else {
    const ref = climb(vApex, g, (y, vy) => vy < 4 || y < 0);          // slowest shell: bursts at its apex
    const T = ref.t * Math.min(1, Math.max(0.18, 0.62 / m));
    if (T >= ref.t - 1e-6) out = { v0: vApex, t: ref.t, yb: ref.y, vb: ref.vy };
    else {
      let lo = vApex, hi = vApex * 10;
      for (let it = 0; it < 40; it++) { const mid = 0.5 * (lo + hi); if (climb(mid, g, (y) => y >= ref.y).t > T) lo = mid; else hi = mid; }
      const r = climb(hi, g, (y) => y >= ref.y);
      out = { v0: hi, t: r.t, yb: ref.y, vb: r.vy };
    }
  }
  if (flightCache.size > 4000) flightCache.clear();
  flightCache.set(key, out);
  return out;
}
// effective launch speed multiplier of a layer: type default x layer control (x 1.8 for the 'dark fast shell' style)
export function baseLaunchSpeed(layer, style) {
  const ls = Number(layer.launchSpeed);
  return (TYPES[layer.type]?.launch ?? 1) * Math.min(4, Math.max(0.2, ls > 0 ? ls : 1)) * (style === 'dark' ? 1.8 : 1);
}

export class World {
  constructor() {
    this.cap = CAP_START; this.capS = CAPS_START;
    this.L = new Float32Array(this.cap * F.S);    // light pool; grows on demand up to CAP_MAX particles
    this.M = new Float32Array(this.capS * F.SS);  // smoke pool; grows on demand up to CAPS_MAX puffs
    this.nL = 0; this.nM = 0;
    this.trailSpecs = []; this.evSpecs = [];
    this.queue = [];
    this.overflow = 0; this.overflowSmoke = 0;
    this.focus = null;
    this.P = defaultPhysics();
    this.shells = [];
    this.hx = new RNG(1);                          // scratch stream, reseeded per particle and step
    this.counts = { stars: 0, sparks: 0, pops: 0, flash: 0, tail: 0, smoke: 0 };
    this.reset(1, { layers: [] }, this.P);
  }

  reset(seed, shot, P) {
    this.seed = seed >>> 0;
    this.rng = new RNG(seed);                   // shell flight of the single (non-finale) launch
    this.rngT = new RNG(seed ^ 0x51ed270b);     // spark phases of that shell
    this.rngS = new RNG(seed ^ 0x2545f491);     // smoke of that shell
    this.overflow = 0; this.overflowSmoke = 0; this.focus = null;
    this.shot = shot; this.P = P;
    // pools go back to their start size, so a huge finale does not keep a gigabyte allocated afterwards
    if (this.cap > CAP_START) { this.cap = CAP_START; this.L = new Float32Array(this.cap * F.S); }
    if (this.capS > CAPS_START) { this.capS = CAPS_START; this.M = new Float32Array(this.capS * F.SS); }
    this.nL = 0; this.nM = 0; this.t = 0; this.stepNo = 0; this.serial = 0;
    this.peak = { lights: 0, smoke: 0, total: 0 };
    this.trailSpecs.length = 0; this.evSpecs.length = 0; this.queue.length = 0;
    this.shells = []; this.fires = []; this.launchPlan = []; this.launchLog = []; this.burstLog = [];
    const fin = shot.finale;
    if (fin && fin.enabled) this.scheduleFinale(shot, fin);
    else {
      const entries = shot.layers.map((layer, idx) => ({ layer, idx, k: 0 })).filter((e) => e.layer.enabled);
      if (!entries.length) return;              // nothing enabled: nothing launches
      const first = entries[0].layer;
      const g = { entries, x: shot.baseX || 0, z: shot.baseZ || 0, H: shot.burstHeight, style: first.launchStyle || 'gold', wob: first.wobble ?? 1, legacy: true, k: 0 };
      g.speed = baseLaunchSpeed(first, g.style);   // layers sharing the one shell use the first enabled layer's speed (no variation)
      this.launchPlan.push({ layerId: first.id ?? 0, k: 0, t: 0, x: g.x, z: g.z, H: this.fixHeight(g), speed: g.speed, flight: shot.launch ? g.fl.t : null });
      this.startGroup(g);
    }
  }

  schedule(t, fn) {
    const q = this.queue; let i = q.length;
    while (i > 0 && q[i - 1].t > t) i--;
    q.splice(i, 0, { t, fn });
  }

  // ---- grand finale: every repeat of every layer is its own launch with its own time, position and RNG streams ----
  scheduleFinale(shot, fin) {
    const T = Math.max(0, +fin.totalTime || 0), sx = +fin.spreadX || 0, sz = +fin.spreadZ || 0, hv = +fin.heightVar || 0;
    shot.layers.forEach((layer, idx) => {
      if (!layer.enabled) return;
      const key = layer.id ?? idx;
      const R = Math.min(MAX_REPEATS, Math.max(1, Math.round(+layer.repeats || 1)));
      const manual = +layer.interval > 0;
      // automatic spacing fits inside [start, T]; a start offset at or beyond the end cannot pile every repeat at T
      const start = Math.max(0, +layer.startOffset || 0), s0 = manual ? start : Math.min(start, T * 0.9);
      const gap = manual ? +layer.interval : (R > 1 ? (T - s0) / (R - 1) : 0);
      const noise = Math.min(1, Math.max(0, +layer.noise || 0));
      const tr = new RNG(mix32(this.seed, key, 0, 0x7131)), pr = new RNG(mix32(fin.posSeed | 0, key, 0, 0x9051));
      for (let k = 0; k < R; k++) {
        let t = s0 + k * gap;
        const jitter = tr.next() * 2 - 1;      // always drawn, so noise only scales the offsets
        const edge = !manual && (k === 0 || k === R - 1);   // auto mode: first and last launch stay put, so the span is exactly [start, T]
        if (noise > 0 && gap > 0 && !edge) t += jitter * 0.5 * noise * gap;
        t = manual ? Math.max(s0, t) : Math.min(T, Math.max(s0, t));
        const x = (pr.next() * 2 - 1) * sx / 2, z = (pr.next() * 2 - 1) * sz / 2, Hh = Math.max(MIN_BURST_HEIGHT, shot.burstHeight + (pr.next() * 2 - 1) * hv);
        const style = layer.launchStyle || 'gold', speed = baseLaunchSpeed(layer, style) * this.launchVariation(key, k);
        const g = { entries: [{ layer, idx, k }], x: (shot.baseX || 0) + x, z: (shot.baseZ || 0) + z, H: Hh, style, speed, wob: layer.wobble ?? 1, legacy: false, k,
          rng: new RNG(mix32(this.seed, key, k, 0x5e11)), rngS: new RNG(mix32(this.seed, key, k, 0x5a0c)), rngT: new RNG(mix32(this.seed, key, k, 0x7a11)), rngJ: new RNG(mix32(this.seed, key, k, 0x7a12)) };
        this.launchPlan.push({ layerId: key, k, t, x: g.x, z: g.z, H: this.fixHeight(g), speed, flight: shot.launch ? g.fl.t : null });
        this.schedule(t, () => this.startGroup(g));
      }
    });
  }

  // clamp the burst height and compute the shell's flight (shared by the schedule, the launch plan and the launch itself)
  fixHeight(g) {
    g.H = Number.isFinite(g.H) ? Math.max(MIN_BURST_HEIGHT, g.H) : 170;
    if (!g.fl) g.fl = shellFlight(g.H, this.P.gravity, g.speed);
    return g.H;
  }

  // seeded per-launch factor on the launch speed: finales only (a single shot is exact); amount from variation.launchSpeed (default 8 %)
  launchVariation(key, k) {
    const fin = this.shot.finale, v = this.shot.variation;
    if (!(fin && fin.enabled)) return 1;
    const a = Math.min(100, Math.max(0, +(v && v.launchSpeed !== undefined ? v.launchSpeed : 8) || 0)) / 100;
    const r = new RNG(mix32((v && v.seed) | 0, key, k, 0x7a22));
    return Math.max(0.3, 1 + (r.next() * 2 - 1) * a);
  }

  startGroup(g) {
    this.fixHeight(g);
    this.launchLog.push({ layerId: g.entries[0]?.layer.id ?? 0, k: g.k, t: this.t, x: g.x, z: g.z, H: g.H });
    if (this.shot.launch) this.launchShell(g);
    else this.schedule(this.t + 0.15, () => this.burst(g, [g.x, g.H, g.z], [0, 0, 0]));
  }

  // ---- launch phase -------------------------------------------------------
  launchShell(g) {
    const r = g.legacy ? this.rng : g.rng, k = KDRAG, fl = g.fl, v0 = fl.v0;
    if (!Number.isFinite(v0)) { this.schedule(this.t + 0.15, () => this.burst(g, [g.x, g.H, g.z], [0, 0, 0])); return; }
    const spiral = g.style === 'spiral';
    const tilt = 0.035;
    const s = {
      g, r, rs: g.legacy ? this.rngS : g.rngS, rt: g.legacy ? this.rngT : g.rngT, style: g.style, wob: g.wob, k, yb: fl.yb,
      rj: g.legacy ? new RNG(mix32(this.seed, 0x7a13)) : g.rngJ,      // tail randomness has its own stream, so the number of sparks never disturbs the flight
      x: g.x + r.range(-1, 1), y: 1.5, z: g.z + r.range(-1, 1),
      vx: r.gauss() * tilt * v0 * 0.3, vy: v0, vz: r.gauss() * tilt * v0 * 0.3,
      wx: 0, wz: 0, acc: 0, smokeAcc: 0, bx: g.x, bz: g.z, ang: 0, jx: 0, jz: 0, tx: 0, tz: 0, pop: 0, spin: 12, rad: 7, mod: 0.7, drop: 0,
    };
    if (spiral) { s.vx *= 0.3; s.vz *= 0.3; s.ang = s.rj.next() * 6.283; }   // spiral shells fly almost straight up; the spark source does the twirling
    this.shells.push(s);
    if (g.style === 'dark') this.spawnFlash(g.x, 1.5, g.z, 0.4, 0.8, 0.12);        // 'none' leaves no ground flash at all
    else if (g.style !== 'none') this.spawnFlash(g.x, 1.5, g.z, 0.9, 6, 0.25);
  }

  stepShell(s) {
    const r = s.r, P = this.P, wob = s.wob, st = s.style;
    const kink = st === 'spiral' ? 0.25 : 1;
    s.wx += r.gauss() * 1.6 * H * wob * kink; s.wz += r.gauss() * 1.6 * H * wob * kink;      // wobble (random-walk lateral accel)
    s.wx *= 0.995; s.wz *= 0.995;
    const rx = s.vx - P.windX, rz = s.vz - P.windZ, sp = Math.hypot(rx, s.vy, rz), a = s.k * sp;
    s.vx += (-a * rx + s.wx) * H;
    s.vy += (-G * Math.max(0.05, P.gravity) - a * s.vy) * H;
    s.vz += (-a * rz + s.wz) * H;
    if (st === 'none' || st === 'dark') { /* no spark tail */ }
    else if (st === 'spiral') this.spiralTail(s);
    else this.sparkTail(s);
    if (st !== 'none' && st !== 'dark') {
      s.smokeAcc += 14 * H * P.smokeAmount;
      while (s.smokeAcc >= 1) {
        s.smokeAcc -= 1;
        this.addSmoke(s.x, s.y, s.z, r.gauss() * 0.4, r.gauss() * 0.4 - 0.5, r.gauss() * 0.4,
          r.range(5, 8) * P.smokeLife, r.range(0.8, 1.4), r.range(3, 6), 0.012, 0, 1, s.rs);
      }
    }
    s.x += s.vx * H; s.y += s.vy * H; s.z += s.vz * H;
    if (s.y >= s.yb || s.vy < 4 || s.y < 0) {   // fast shells burst on the way up at the set height, the slowest at their apex
      this.shells.splice(this.shells.indexOf(s), 1);
      this.burst(s.g, [s.x, s.y, s.z], [s.vx, s.vy, s.vz]);
    }
  }

  // gold comet (legacy flight), silver tail and crackling tail share this emitter; the emission point wanders slightly
  sparkTail(s) {
    const r = s.rj, st = s.style;
    s.tx += r.gauss() * 0.9 * H * s.wob - s.tx * 1.5 * H; s.tz += r.gauss() * 0.9 * H * s.wob - s.tz * 1.5 * H;
    s.acc += 650 * H * Math.min(1.5, Math.max(0.6, Math.sqrt(Math.abs(s.vy) / 60)));   // a faster shell sheds more sparks per second
    while (s.acc >= 1) {
      s.acc -= 1;
      const u = r.next(), sp2 = r.range(0.5, 4);
      const d = r.unit([0, 0, 0]);
      const silver = st === 'silver';
      const q = this.addSpark(s.x + s.tx - s.vx * u * H, s.y - s.vy * u * H, s.z + s.tz - s.vz * u * H,
        s.vx * 0.04 + d[0] * sp2, s.vy * 0.04 + d[1] * sp2 * 0.6 - 1, s.vz * 0.04 + d[2] * sp2,
        silver ? r.range(0.35, 1.0) : r.range(0.5, 1.5), 0.05, silver ? r.range(3, 8) : r.range(2.5, 7), 0.22,
        silver ? 0.85 : 1, silver ? 0.92 : 0.5, silver ? 1.0 : 0.12, 1, 0.5, 0, s.rt);
      if (q !== undefined) this.L[q + F.KIND] = F.K_TAIL;
    }
    if (st === 'crackle') {
      s.pop += 24 * H;
      while (s.pop >= 1) { s.pop -= 1; this.addPop(s.x + r.gauss() * 0.8, s.y + r.gauss() * 0.8, s.z + r.gauss() * 0.8, s.vx * 0.2, s.vy * 0.2, s.vz * 0.2, r.range(0.3, 0.7), r.range(25, 60), 0, r); }
    }
  }

  // Twirl: the shell climbs nearly straight while the spark source corkscrews around it. Spin rate and radius drift,
  // gusts kick the phase and the offset, and the shedding rate and brightness fluctuate and drop out, so the trail is jagged.
  spiralTail(s) {
    const rj = s.rj, sq = Math.sqrt(H);
    s.spin = Math.min(28, Math.max(2.5, s.spin + (12 - s.spin) * 1.0 * H + rj.gauss() * 15 * sq));
    s.rad = Math.min(14, Math.max(1.2, s.rad + (7 * s.wob - s.rad) * 0.9 * H + rj.gauss() * 5.5 * sq));
    s.mod = Math.min(1.8, Math.max(0, s.mod + (0.7 - s.mod) * 2 * H + rj.gauss() * 2.2 * sq));
    if (rj.next() < 3.4 * H) { s.ang += rj.gauss() * 1.6; s.jx += rj.gauss() * 3.6 * s.wob; s.jz += rj.gauss() * 3.6 * s.wob; }   // gust
    if (s.drop <= 0 && rj.next() < 2.2 * H) s.drop = rj.range(0.08, 0.28);
    s.jx -= s.jx * 2 * H; s.jz -= s.jz * 2 * H;
    s.ang += s.spin * H;
    let rate = 650 * (0.25 + s.mod) * Math.min(1.5, Math.max(0.6, Math.sqrt(Math.abs(s.vy) / 60)));
    if (s.drop > 0) { s.drop -= H; rate *= 0.12; }
    s.acc += rate * H;
    const tang = rj.range(2, 4.5);
    while (s.acc >= 1) {
      s.acc -= 1;
      const u = rj.next(), a = s.ang - u * s.spin * H, ca = Math.cos(a), sa = Math.sin(a);
      const q = this.addSpark(s.x + (ca * s.rad + s.jx) - s.vx * u * H, s.y - s.vy * u * H, s.z + (sa * s.rad + s.jz) - s.vz * u * H,
        s.vx * 0.04 - sa * tang + rj.gauss() * 0.5, s.vy * 0.04 + rj.gauss() * 0.5 - 1, s.vz * 0.04 + ca * tang + rj.gauss() * 0.5,
        rj.range(0.6, 1.6), 0.05, rj.range(3, 8) * (0.45 + 0.65 * s.mod), 0.22, 1, 0.55, 0.14, 1, 0.5, 0, s.rt);
      if (q !== undefined) this.L[q + F.KIND] = F.K_TAIL;
    }
  }

  // ---- bursts ------------------------------------------------------------
  makeFire(layer, k, idx) {
    const key = layer.id ?? idx, shot = this.shot, v = shot.variation;
    const sk = mix32(this.seed, key, k, 0xf12e);          // stream seed of this launch
    const P = this.P, lp = { burstVel: P.burstVel, lifetime: P.lifetime, smokeAmount: P.smokeAmount, smokeLife: P.smokeLife };
    const active = shot.layers.filter((l) => l.enabled).length;
    if (v && v.enabled && (active > 1 || (shot.finale && shot.finale.enabled))) {
      // seeded per-launch multipliers around the global physics values
      const vr = new RNG(mix32(v.seed | 0, key, k, 0x7a21));
      const m = (amount) => Math.max(0.15, 1 + (vr.next() * 2 - 1) * (Math.min(100, Math.max(0, +amount || 0)) / 100));
      lp.burstVel *= m(v.burstVel); lp.lifetime *= m(v.lifetime); lp.smokeAmount *= m(v.smokeAmount); lp.smokeLife *= m(v.smokeLife);
    }
    const fire = { id: this.fires.length, layerId: key, k, sk, serial: 0, rng: new RNG(sk), rngS: new RNG(sk ^ 0x2545f491),
      lp, origin: null, t: this.t, stats: { n: 0, speed: 0, life: 0, radius: 0, smoke: 0 } };
    fire.rng.next(); fire.rng.next();
    this.fires.push(fire);
    return fire;
  }

  burst(g, origin, vel) {
    this.focus = origin.slice();
    this.burstLog.push({ t: this.t, origin: origin.slice(), layerId: g.entries[0]?.layer.id ?? 0, k: g.k });
    for (const e of g.entries) {
      const layer = e.layer;
      const o = [origin[0] + layer.offset[0], origin[1] + layer.offset[1], origin[2] + layer.offset[2]];
      const fire = this.makeFire(layer, e.k, e.idx); fire.origin = o;
      const run = () => {
        const type = TYPES[layer.type];
        if (!type) return;
        const ctx = makeCtx(this, layer, o, vel, fire);
        type.burst(ctx);
        ctx.finish();
      };
      if (layer.delay > 0) this.schedule(this.t + layer.delay, run); else run();
    }
  }

  // ---- spawning -----------------------------------------------------------
  addLight() {
    if (this.nL >= this.cap) {
      if (this.cap >= CAP_MAX) { this.overflow++; return -1; }
      this.cap = Math.min(CAP_MAX, this.cap * 2);
      const bigger = new Float32Array(this.cap * F.S); bigger.set(this.L.subarray(0, this.nL * F.S)); this.L = bigger;
    }
    return this.nL++ * F.S;
  }

  // per-particle random stream derived from the launch seed, the particle's serial and the step: independent of pool order,
  // so adding or removing another layer never changes what this launch's particles do
  seedRng(fr, serial, salt) { const r = this.hx; r.s = mix4(fr.sk, serial, this.stepNo, salt) || 1; return r; }

  addSpark(x, y, z, vx, vy, vz, life, size, inten, k, r, g, b, grav, flk = 0.5, age = 0, rngPhase = this.rngT, lid = 0) {
    if (this.nL >= CAP_MAX * 0.9) { this.overflow++; return; }   // keep headroom for primary stars
    const o = this.addLight(); if (o < 0) return;
    const L = this.L;
    L[o + F.PX] = x; L[o + F.PY] = y; L[o + F.PZ] = z;
    L[o + F.VX] = vx; L[o + F.VY] = vy; L[o + F.VZ] = vz;
    L[o + F.AGE] = age; L[o + F.LIFE] = life; L[o + F.DRAG] = k; L[o + F.SIZE] = size; L[o + F.INTEN] = inten;
    L[o + F.R1] = r; L[o + F.G1] = g; L[o + F.B1] = b; L[o + F.R2] = r; L[o + F.G2] = g; L[o + F.B2] = b;
    L[o + F.SHIFT] = 0; L[o + F.KIND] = F.K_SPARK; L[o + F.TRATE] = 0; L[o + F.TSPEC] = 0;
    L[o + F.SHZ] = 0; L[o + F.SDUTY] = 0; L[o + F.PHASE] = rngPhase.next() * 100;
    L[o + F.EVT] = 0; L[o + F.EVAT] = 0; L[o + F.EVSPEC] = 0;
    L[o + F.GRAV] = grav; L[o + F.SMRATE] = 0; L[o + F.FLK] = flk; L[o + F.LB] = 1;
    L[o + F.LID] = lid; L[o + F.PUFF] = 0; L[o + F.PUFFR] = 1; L[o + F.SER] = this.serial++;
    return o;
  }

  // tiny bright pop (crackle / crackling launch tail); age < 0 delays its appearance
  addPop(x, y, z, vx, vy, vz, life, inten, age, r, size = 0.2, puff = 0) {
    const o = this.addLight(); if (o < 0) return;
    const L = this.L; L.fill(0, o, o + F.S);
    L[o + F.PX] = x; L[o + F.PY] = y; L[o + F.PZ] = z; L[o + F.VX] = vx; L[o + F.VY] = vy; L[o + F.VZ] = vz;
    L[o + F.AGE] = age; L[o + F.LIFE] = life; L[o + F.DRAG] = 0.2; L[o + F.SIZE] = size * r.range(1, 2.2); L[o + F.INTEN] = inten;
    L[o + F.R1] = L[o + F.R2] = 1; L[o + F.G1] = L[o + F.G2] = 0.9; L[o + F.B1] = L[o + F.B2] = 0.7;
    L[o + F.KIND] = F.K_POP; L[o + F.GRAV] = 1; L[o + F.PHASE] = r.next() * 100; L[o + F.PUFF] = puff; L[o + F.PUFFR] = 0.7; L[o + F.SER] = this.serial++;
  }

  spawnFlash(x, y, z, size, inten, life, col = null) {
    const o = this.addLight(); if (o < 0) return;
    const L = this.L; L.fill(0, o, o + F.S);
    L[o + F.PX] = x; L[o + F.PY] = y; L[o + F.PZ] = z;
    L[o + F.LIFE] = life; L[o + F.SIZE] = size; L[o + F.INTEN] = inten;
    const c = col || [1, 0.85, 0.65];
    L[o + F.R1] = L[o + F.R2] = c[0]; L[o + F.G1] = L[o + F.G2] = c[1]; L[o + F.B1] = L[o + F.B2] = c[2];
    L[o + F.KIND] = F.K_FLASH;
  }

  addSmoke(x, y, z, vx, vy, vz, life, r0, r1, dens, buoy, kind = 0, rng = this.rngS, fid = -1) {
    if (this.nM >= this.capS) {
      if (this.capS >= CAPS_MAX) { this.overflowSmoke++; return; }
      this.capS = Math.min(CAPS_MAX, this.capS * 2);
      const bigger = new Float32Array(this.capS * F.SS); bigger.set(this.M.subarray(0, this.nM * F.SS)); this.M = bigger;
    }
    const M = this.M, o = this.nM++ * F.SS;
    M[o + F.SPX] = x; M[o + F.SPY] = y; M[o + F.SPZ] = z;
    M[o + F.SVX] = vx; M[o + F.SVY] = vy; M[o + F.SVZ] = vz;
    M[o + F.SAGE] = 0; M[o + F.SLIFE] = life; M[o + F.SR0] = r0; M[o + F.SR1] = r1;
    M[o + F.SDENS] = dens; M[o + F.SROT] = rng.next() * 6.2832; M[o + F.SSEED] = rng.next() * 50;
    M[o + F.SBUOY] = buoy; M[o + F.SKIND] = kind; M[o + F.SFID] = fid;
    if (fid >= 0) this.fires[fid].stats.smoke++;
  }

  // small puff where a star burned out / popped / split (scaled by the launch's smoke amount)
  deathPuff(o, fr, scale = 1, dmul = 1) {   // dmul > 1 (a PUFF value above 1) makes the puff denser
    const amount = fr.lp.smokeAmount;
    if (amount <= 0) return;
    const L = this.L, rs = this.seedRng(fr, L[o + F.SER], 3);
    if (amount < 1 && rs.next() > amount) return;
    const p = L[o + F.PUFFR] * scale;
    this.addSmoke(L[o + F.PX], L[o + F.PY], L[o + F.PZ], L[o + F.VX] * 0.05 + rs.gauss() * 0.3, L[o + F.VY] * 0.05 + rs.gauss() * 0.3, L[o + F.VZ] * 0.05 + rs.gauss() * 0.3,
      rs.range(8, 13) * fr.lp.smokeLife, 1.0 * p, rs.range(3, 5) * p, rs.range(0.05, 0.09) * dmul * Math.min(amount, 2), rs.range(-0.03, 0.06), 0, rs, fr.id);
  }

  // ---- stepping ------------------------------------------------------------
  advanceTo(T) {
    while (this.t + H <= T + 1e-9) this.step();
  }

  step() {
    const q = this.queue;
    while (q.length && q[0].t <= this.t + 1e-9) q.shift().fn();
    for (let i = 0; i < this.shells.length;) { const n = this.shells.length; this.stepShell(this.shells[i]); if (this.shells.length === n) i++; }
    this.stepLights();
    this.stepSmoke();
    this.t += H; this.stepNo++;
    const pk = this.peak; if (this.nL > pk.lights) pk.lights = this.nL; if (this.nM > pk.smoke) pk.smoke = this.nM; if (this.nL + this.nM > pk.total) pk.total = this.nL + this.nM;
  }

  stepLights() {
    const P = this.P, h = H, t = this.t, fires = this.fires;
    const gS = G * P.gravity, wx = P.windX, wz = P.windZ, turb = P.turbulence;
    const counts = this.counts; counts.stars = counts.sparks = counts.pops = counts.flash = counts.tail = 0;
    // Particles born during this step are appended after the `nOld` existing ones and are first updated next step, whatever else
    // happens in the pool (removals keep the old | new partition), so one layer's particles never depend on another layer's.
    let nOld = this.nL;
    for (let i = 0; i < nOld;) {
      const L = this.L, o = i * F.S;     // re-read every iteration: spawning can grow (replace) the pool
      let age = L[o + F.AGE];
      const kind = L[o + F.KIND];
      if (kind === F.K_FLASH) {
        age += h; L[o + F.AGE] = age;
        if (age >= L[o + F.LIFE]) { nOld = this.removeOld(i, nOld); continue; }
        counts.flash++; i++; continue;
      }
      let vx = L[o + F.VX], vy = L[o + F.VY], vz = L[o + F.VZ];
      const rx = vx - wx, rz = vz - wz;
      let a = L[o + F.DRAG] * Math.sqrt(rx * rx + vy * vy + rz * rz);
      if (a > 0.5 / h) a = 0.5 / h;
      vx -= a * rx * h; vy -= a * vy * h; vz -= a * rz * h;
      vy -= gS * L[o + F.GRAV] * h;
      let x = L[o + F.PX], y = L[o + F.PY], z = L[o + F.PZ];
      if (turb > 0) {
        vx += turb * (Math.sin(0.13 * y + 0.9 * t) + Math.sin(0.21 * z - 1.3 * t)) * h;
        vy += turb * 0.5 * (Math.sin(0.17 * x + 1.1 * t) + Math.sin(0.11 * z + 0.7 * t)) * h;
        vz += turb * (Math.sin(0.19 * x - 0.8 * t) + Math.sin(0.15 * y + 1.2 * t)) * h;
      }
      x += vx * h; y += vy * h; z += vz * h;
      L[o + F.PX] = x; L[o + F.PY] = y; L[o + F.PZ] = z;
      L[o + F.VX] = vx; L[o + F.VY] = vy; L[o + F.VZ] = vz;
      age += h; L[o + F.AGE] = age;
      if (y < -2) { nOld = this.removeOld(i, nOld); continue; }
      if (age >= L[o + F.LIFE]) {
        // a star or pop that burns out leaves its own small puff of smoke
        const pb = L[o + F.PUFF];
        if (pb > 0 && (kind === F.K_STAR || kind === F.K_POP)) { const fr = fires[L[o + F.LID] | 0]; if (fr && this.seedRng(fr, L[o + F.SER], 5).next() < pb) this.deathPuff(o, fr, 1, Math.max(1, pb)); }
        nOld = this.removeOld(i, nOld); continue;
      }
      if (age < 0) { i++; continue; }
      if (kind === F.K_STAR) {
        const fr = fires[L[o + F.LID] | 0];
        const evt = L[o + F.EVT];
        if (evt && age >= L[o + F.EVAT]) { this.fireEvent(o); nOld = this.removeOld(i, nOld); continue; }
        const tr = L[o + F.TRATE];
        if (tr > 0) this.emitTrail(o, tr, x, y, z, vx, vy, vz);
        const sm = L[o + F.SMRATE];
        if (sm > 0) {
          const r = this.seedRng(fr, L[o + F.SER], 1);
          if (r.next() < sm * h * fr.lp.smokeAmount) {
            const sg = L[o + F.SIZE], pr = L[o + F.PUFFR];
            this.addSmoke(x, y, z, vx * 0.03 + r.gauss() * 0.5, vy * 0.03 + r.gauss() * 0.5, vz * 0.03 + r.gauss() * 0.5,
              r.range(9, 15) * fr.lp.smokeLife, (1.2 + sg * 4) * pr, r.range(7, 12) * pr, 0.03, r.range(-0.05, 0.08), 0, r, fr.id);
          }
        }
        counts.stars++;
      } else if (kind === F.K_SPARK) counts.sparks++;
      else if (kind === F.K_TAIL) counts.tail++;
      else counts.pops++;
      i++;
    }
  }

  // remove old particle i: the last old one takes its place and the last new one fills that hole (old | new stays partitioned)
  removeOld(i, nOld) {
    const S = F.S, L = this.L, lastOld = nOld - 1, lastAll = this.nL - 1;
    if (i !== lastOld) L.copyWithin(i * S, lastOld * S, lastOld * S + S);
    if (lastAll !== lastOld) L.copyWithin(lastOld * S, lastAll * S, lastAll * S + S);
    this.nL--;
    return nOld - 1;
  }

  emitTrail(o, rate, x, y, z, vx, vy, vz) {
    const L = this.L, fr = this.fires[L[o + F.LID] | 0], r = this.seedRng(fr, L[o + F.SER], 4), ts = this.trailSpecs[L[o + F.TSPEC] | 0], lb = L[o + F.LB];
    let n = rate * H * ts.amount;
    let cnt = Math.floor(n); if (r.next() < n - cnt) cnt++;
    for (let j = 0; j < cnt; j++) {
      const u = r.next(), d = r.unit([0, 0, 0]), sp = ts.speed * r.range(0.3, 1);
      let cr, cg, cb;
      if (ts.color) { cr = ts.color[0]; cg = ts.color[1]; cb = ts.color[2]; }
      else { const m = ts.tint; cr = L[o + F.R1] * (1 - m) + m; cg = L[o + F.G1] * (1 - m) + 0.55 * m; cb = L[o + F.B1] * (1 - m) + 0.12 * m; }
      const age = u * H;
      this.addSpark(x - vx * u * H, y - vy * u * H, z - vz * u * H,
        vx * ts.inherit + d[0] * sp, vy * ts.inherit + d[1] * sp, vz * ts.inherit + d[2] * sp,
        r.range(ts.life[0], ts.life[1]) * fr.lp.lifetime, ts.size * r.range(0.7, 1.3), ts.inten * lb * r.range(0.6, 1.4),
        ts.k, cr, cg, cb, ts.grav, ts.flicker, age, r, fr.id);
    }
  }

  fireEvent(o) {
    const fr = this.fires[this.L[o + F.LID] | 0], spec = this.evSpecs[this.L[o + F.EVSPEC] | 0], lb = this.L[o + F.LB], ser = this.L[o + F.SER];
    const L0 = this.L, px = L0[o + F.PX], py = L0[o + F.PY], pz = L0[o + F.PZ];
    const vx = L0[o + F.VX], vy = L0[o + F.VY], vz = L0[o + F.VZ], drag = L0[o + F.DRAG];
    const col = [L0[o + F.R1], L0[o + F.G1], L0[o + F.B1]], evt = L0[o + F.EVT];
    if (this.seedRng(fr, ser, 6).next() < (spec.puff ?? 0.6)) this.deathPuff(o, fr, spec.puffScale ?? 1.5);   // smoke where the star pops / splits
    const r = this.seedRng(fr, ser, 2);
    if (evt === F.EV_POP) {
      const pp = spec.pop || {}, sz = pp.size || [0.2, 0.5], lf = pp.life || [0.06, 0.13], it = pp.inten || [30, 70], pc = spec.popColor || [1, 0.9, 0.7];
      for (let j = 0; j < spec.count; j++) {
        const q = this.addLight(); if (q < 0) return;
        const L = this.L;
        L.fill(0, q, q + F.S);
        L[q + F.PX] = px + r.gauss() * 0.8; L[q + F.PY] = py + r.gauss() * 0.8; L[q + F.PZ] = pz + r.gauss() * 0.8;
        L[q + F.VX] = vx * 0.7 + r.gauss() * 4; L[q + F.VY] = vy * 0.7 + r.gauss() * 4; L[q + F.VZ] = vz * 0.7 + r.gauss() * 4;
        L[q + F.AGE] = -r.range(0, spec.spread); L[q + F.LIFE] = r.range(lf[0], lf[1]);
        L[q + F.DRAG] = drag; L[q + F.SIZE] = r.range(sz[0], sz[1]); L[q + F.INTEN] = r.range(it[0], it[1]) * spec.bright * lb;
        L[q + F.R1] = L[q + F.R2] = pc[0]; L[q + F.G1] = L[q + F.G2] = pc[1]; L[q + F.B1] = L[q + F.B2] = pc[2];
        L[q + F.KIND] = F.K_POP; L[q + F.GRAV] = 1; L[q + F.PHASE] = r.next() * 100; L[q + F.LID] = fr.id; L[q + F.PUFF] = spec.popPuff ?? 0.4; L[q + F.PUFFR] = 0.8; L[q + F.SER] = fr.serial++;
      }
      if (spec.spray) {   // small spray of sparks thrown out of the pop
        const sp = spec.spray;
        for (let j = 0; j < sp.n; j++) {
          const d = r.unit([0, 0, 0]), s = r.range(sp.speed[0], sp.speed[1]);
          this.addSpark(px, py, pz, vx * 0.3 + d[0] * s, vy * 0.3 + d[1] * s, vz * 0.3 + d[2] * s, r.range(sp.life[0], sp.life[1]) * fr.lp.lifetime, 0.07, r.range(5, 12) * lb, 0.3, pc[0], pc[1], pc[2], 1, 0.6, 0, r, fr.id);
        }
      }
      if (spec.flash) this.spawnFlash(px, py, pz, spec.flash.size, spec.flash.inten * lb, spec.flash.life, [0.5 + 0.5 * pc[0], 0.5 + 0.5 * pc[1], 0.5 + 0.5 * pc[2]]);
      return;
    }
    // split into children (cross or sphere)
    const sp = Math.hypot(vx, vy, vz) || 1, vd = [vx / sp, vy / sp, vz / sp];
    const rnd = r.unit([0, 0, 0]);
    let ux = vd[1] * rnd[2] - vd[2] * rnd[1], uy = vd[2] * rnd[0] - vd[0] * rnd[2], uz = vd[0] * rnd[1] - vd[1] * rnd[0];
    const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    const wx2 = vd[1] * uz - vd[2] * uy, wy2 = vd[2] * ux - vd[0] * uz, wz2 = vd[0] * uy - vd[1] * ux;
    const dirs = spec.mode === 'cross'
      ? [[ux, uy, uz], [-ux, -uy, -uz], [wx2, wy2, wz2], [-wx2, -wy2, -wz2]]
      : Array.from({ length: spec.count }, () => r.unit([0, 0, 0]));
    for (const d of dirs) {
      const s = r.range(spec.speed[0], spec.speed[1]) * fr.lp.burstVel;
      this.emitChild(spec.child, px, py, pz, vx * spec.inherit + d[0] * s, vy * spec.inherit + d[1] * s, vz * spec.inherit + d[2] * s, spec.childColor || col, lb, fr, r);
    }
    this.spawnFlash(px, py, pz, 0.9, 40 * lb, 0.16);
  }

  emitChild(c, x, y, z, vx, vy, vz, col, lb, fr, r) {
    const o = this.addLight(); if (o < 0) return;
    const L = this.L;
    L.fill(0, o, o + F.S);
    L[o + F.PX] = x; L[o + F.PY] = y; L[o + F.PZ] = z;
    L[o + F.VX] = vx; L[o + F.VY] = vy; L[o + F.VZ] = vz;
    L[o + F.LIFE] = r.range(c.life[0], c.life[1]) * fr.lp.lifetime; L[o + F.DRAG] = c.k * this.P.drag;
    L[o + F.SIZE] = c.size; L[o + F.INTEN] = c.inten * lb * r.range(0.8, 1.2); L[o + F.LB] = lb;
    const cc = c.color || col;
    L[o + F.R1] = L[o + F.R2] = cc[0]; L[o + F.G1] = L[o + F.G2] = cc[1]; L[o + F.B1] = L[o + F.B2] = cc[2];
    L[o + F.KIND] = F.K_STAR; L[o + F.GRAV] = c.grav ?? 1; L[o + F.PHASE] = r.next() * 100; L[o + F.FLK] = 0.5;
    L[o + F.LID] = fr.id; L[o + F.PUFF] = c.puff ?? 0.5; L[o + F.PUFFR] = 1; L[o + F.SER] = fr.serial++;
    if (c.trailIdx !== undefined) { L[o + F.TSPEC] = c.trailIdx; L[o + F.TRATE] = this.trailSpecs[c.trailIdx].rate; }
  }

  stepSmoke() {
    const M = this.M, P = this.P, h = H;
    const relax = 1 - Math.exp(-0.5 * h), damp = Math.exp(-1.6 * h), tb = 0.45 + P.turbulence * 0.3, t = this.t;
    for (let i = 0; i < this.nM;) {
      const o = i * F.SS;
      const age = M[o + F.SAGE] + h;
      if (age >= M[o + F.SLIFE]) {
        const last = --this.nM;
        if (i !== last) M.copyWithin(o, last * F.SS, last * F.SS + F.SS);
        continue;
      }
      M[o + F.SAGE] = age;
      let vx = M[o + F.SVX], vy = M[o + F.SVY], vz = M[o + F.SVZ];
      vx = (vx * damp) + (P.windX - vx * damp) * relax * 0.3;
      vz = (vz * damp) + (P.windZ - vz * damp) * relax * 0.3;
      vy = vy * damp + M[o + F.SBUOY] * h - 0.02 * h;
      {  // curl-like swirl so smoke billows instead of drifting as a rigid blob
        const x = M[o + F.SPX], y = M[o + F.SPY], z = M[o + F.SPZ];
        vx += tb * (Math.sin(0.045 * y + 0.31 * t) + Math.sin(0.037 * z - 0.23 * t)) * h;
        vy += tb * 0.4 * (Math.sin(0.041 * x + 0.27 * t) + Math.sin(0.052 * z + 0.19 * t)) * h;
        vz += tb * (Math.sin(0.049 * x - 0.21 * t) + Math.sin(0.043 * y + 0.33 * t)) * h;
      }
      M[o + F.SVX] = vx; M[o + F.SVY] = vy; M[o + F.SVZ] = vz;
      M[o + F.SPX] += vx * h; M[o + F.SPY] += vy * h; M[o + F.SPZ] += vz * h;
      i++;
    }
    this.counts.smoke = this.nM;
  }

  get finished() {
    return this.shells.length === 0 && this.queue.length === 0 && this.nL === 0 && this.nM === 0;
  }

  stats() {
    const c = this.counts;
    return { time: this.t, stars: c.stars, sparks: c.sparks, tail: c.tail, pops: c.pops, flash: c.flash, smoke: this.nM, shell: this.shells.length, total: this.nL + this.nM, overflow: this.overflow, overflowSmoke: this.overflowSmoke, peak: { ...this.peak } };
  }
}
