// Per-particle emission colour/brightness as a pure function of age (no RNG, no wall-clock).
import * as F from './fields.js';
import { noise1, smoothstep } from './rng.js';

const mix = (a, b, t) => a + (b - a) * t;

// writes linear HDR rgb into out[0..2]; returns scalar intensity (before colour)
export function emission(L, o, out) {
  const age = L[o + F.AGE], life = L[o + F.LIFE], t = age / life, kind = L[o + F.KIND];
  let r, g, b, I;
  if (kind === F.K_STAR) {
    const heat = Math.exp(-age / 0.25);
    const sh = L[o + F.SHIFT], st = sh > 0 ? smoothstep(sh - 0.07, sh + 0.07, t) : 0;
    r = mix(L[o + F.R1], L[o + F.R2], st); g = mix(L[o + F.G1], L[o + F.G2], st); b = mix(L[o + F.B1], L[o + F.B2], st);
    const wh = heat * 0.65;                       // white-hot ignition cooling to the emitter colour
    r = mix(r, 1.0, wh); g = mix(g, 0.9, wh); b = mix(b, 0.76, wh);
    const em = smoothstep(0.8, 1, t) * 0.75;      // burnt-orange ember at end of life
    r = mix(r, 1.0, em); g = mix(g, 0.27, em); b = mix(b, 0.05, em);
    const fade = Math.pow(1 - smoothstep(0.5, 1, t), 1.4) * smoothstep(0, 0.03, age + 0.02);
    const fl = L[o + F.FLK] * (0.15 + 0.85 * smoothstep(0.5, 1, t));
    const flick = Math.max(0, 1 + fl * (noise1(age * 27 + L[o + F.PHASE]) * 2 - 1) * 1.1);
    I = L[o + F.INTEN] * fade * flick * (1 + 2 * heat);
    const hz = L[o + F.SHZ];
    if (hz > 0) {
      const f = (age * hz + L[o + F.PHASE]) % 1, d = L[o + F.SDUTY];
      I *= smoothstep(0, 0.07, f) * (1 - smoothstep(d, d + 0.07, f));
    }
  } else if (kind === F.K_SPARK || kind === F.K_TAIL) {
    const hot = (1 - smoothstep(0, 0.18, t)) * 0.45, em = smoothstep(0.3, 1, t) * 0.85;
    r = mix(L[o + F.R1], 1.0, hot); g = mix(L[o + F.G1], 0.93, hot); b = mix(L[o + F.B1], 0.8, hot);
    r = mix(r, 1.0, em); g = mix(g, 0.2, em); b = mix(b, 0.03, em);
    const fl = L[o + F.FLK];
    I = L[o + F.INTEN] * Math.pow(1 - t, 1.7) * Math.max(0, 1 + fl * (noise1(age * 41 + L[o + F.PHASE]) * 2 - 1));
  } else if (kind === F.K_POP) {
    const hot = 0.5 * Math.exp(-5 * t);               // white-hot core cooling to the pop's own colour
    r = mix(L[o + F.R1], 1, hot); g = mix(L[o + F.G1], 0.95, hot); b = mix(L[o + F.B1], 0.85, hot);
    I = L[o + F.INTEN] * Math.exp(-3 * t);
  } else {
    r = L[o + F.R1]; g = L[o + F.G1]; b = L[o + F.B1];
    I = L[o + F.INTEN] * Math.exp(-4.5 * t);
  }
  out[0] = r; out[1] = g; out[2] = b;
  return I;
}
