// Estimate how long an auto-duration export will run and how big it gets, before any frame is rendered.
import { World, shellFlight, baseLaunchSpeed } from './world.js';
import { TYPES } from '../library/index.js';
import { trail as trailPreset } from '../library/common.js';

// longest time (s) a layer's particles can live after its burst: star life (+trail sparks), split children, pop sprays
function layerTail(layer) {
  let max = 0;
  const c = {
    layer, cloud: 1, has: () => false, pal: () => [{ c: [1, 1, 1], gain: 1 }], trail: (n, o) => trailPreset(n, o),
    stars(spec) {
      let end = spec.life[1] * 1.25 + (spec.trail ? spec.trail.life[1] : 0);
      const ev = spec.event;
      if (ev) {
        let e2 = ev.at[1] + 0.6;
        if (ev.child) e2 += ev.child.life[1] + (ev.child.trail ? ev.child.trail.life[1] : 0);
        if (ev.spray) e2 += ev.spray.life[1];
        end = Math.max(end, e2);
      }
      max = Math.max(max, end);
    },
    finish() {},
  };
  try { TYPES[layer.type]?.burst(c); } catch { /* unknown type: contributes nothing */ }
  return max;
}

let scratch = null;
export function estimateExport(shot, P, fps) {
  const w = scratch || (scratch = new World());
  w.reset(1, shot, P);
  const v = shot.variation, active = shot.layers.filter((l) => l.enabled).length > 1 || (shot.finale && shot.finale.enabled);
  const vm = (k) => (v && v.enabled && active ? 1 + Math.min(100, Math.max(0, v[k] || 0)) / 100 : 1);
  const lifeMul = P.lifetime * vm('lifetime'), smokeMul = P.smokeLife * vm('smokeLife');
  const byId = new Map(shot.layers.map((l, i) => [l.id ?? i, l]));
  let end = 0, lastLaunch = 0;
  for (const p of w.launchPlan) {
    const layer = byId.get(p.layerId); if (!layer) continue;
    // the slowest flight this launch can have: its speed multiplier lowered by the largest launch-speed variation
    const slow = shot.finale && shot.finale.enabled ? Math.max(0.3, 1 - Math.min(100, Math.max(0, v && v.launchSpeed !== undefined ? v.launchSpeed : 8)) / 100) : 1;
    const burst = p.t + (shot.launch ? shellFlight(p.H, P.gravity, baseLaunchSpeed(layer, layer.launchStyle || 'gold') * slow).t : 0.15);
    const tail = Math.max(layerTail(layer) * lifeMul + 15 * smokeMul, 17 * smokeMul);   // star-path / death puffs live 13-15 s, burst puffs 17 s
    lastLaunch = Math.max(lastLaunch, p.t);
    end = Math.max(end, burst + (layer.delay || 0) + tail);
  }
  scratch = null;   // do not keep the scratch world's pools around
  const seconds = (end + 0.5) / Math.max(0.05, P.timeScale);
  return { seconds, frames: Math.ceil(seconds * fps), lastLaunch };
}

// rough size: ProRes 4444 is about 0.9 bytes/pixel/frame; a 16-bit RGBA PNG of a mostly black frame is at most about 3
export function estimateBytes(w, h, frames, format) {
  const px = w * h * frames;
  return { prores: format === 'png' ? 0 : px * 0.9, png: format === 'prores' ? 0 : px * 3 };
}
