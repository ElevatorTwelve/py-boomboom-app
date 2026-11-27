import { defaultPhysics } from './sim/world.js';
import { PRESETS, fillLayers } from './library/index.js';

export const SENSOR_H = 20.25; // mm; vertical FOV = 2*atan(SENSOR_H/2/focal) so framing is aspect independent

export const VIEWS = {
  Default: { position: [0, 6, 520], target: [0, 160, 0], focal: 50 },
  Front: { position: [0, 160, 560], target: [0, 160, 0], focal: 60 },
  'Low angle (up)': { position: [0, 2, 250], target: [0, 175, 0], focal: 35 },
  Close: { position: [0, 30, 300], target: [0, 160, 0], focal: 85 },
  Wide: { position: [0, 6, 520], target: [0, 130, 0], focal: 24 },
  'Finale wide': { position: [0, 10, 640], target: [0, 140, 0], focal: 34 },
  'Side (90 deg)': { position: [520, 6, 0], target: [0, 160, 0], focal: 60 },
};

const clone = (o) => JSON.parse(JSON.stringify(o));

export const defaultFinale = () => ({ enabled: false, totalTime: 20, spreadX: 240, spreadZ: 100, posSeed: 1, heightVar: 15 });
export const defaultVariation = () => ({ enabled: false, burstVel: 20, lifetime: 20, smokeAmount: 30, smokeLife: 30, launchSpeed: 8, seed: 1 });

export const state = {
  seed: 20260101,
  loop: false,
  // state.shot.finale and state.shot.variation are never replaced (only mutated), so UI controllers bound to them stay valid
  shot: { burstHeight: 170, launch: true, baseX: 0, baseZ: 0, finale: defaultFinale(), variation: defaultVariation(), layers: clone(PRESETS['Red peony + gold willow']) },
  // camera animation: keys (output seconds) or an imported animation (baked, one pose per frame). view: 'free' = orbit / fly, 'shot' = the animated camera
  camera: { keys: [], baked: null, view: 'free', autoKey: true },
  preset: 'Red peony + gold willow',
  physics: defaultPhysics(),
  elements: { launch: true, stars: true, trails: true, glow: true, smoke: true, flash: true, grid: true, guide: true, safe: true, fit: true },
  render: { exposure: 0, bloomStrength: 0.22, bloomRadius: 0.6, starGain: 1.2, shutterAngle: 180, minStarSize: 0.8, smokeDensity: 1, smokeLight: 1, smokeAmbient: 0.14 },
  export: { preset: '1920x1080', width: 1920, height: 1080, fps: 24, duration: 0, samples: 4, alpha: 'premult', format: 'ProRes 4444 + PNG', name: 'fireworks_take01' },
};

export function loadPreset(name) {
  state.preset = name;
  state.shot.layers = clone(PRESETS[name]);
}

// Apply a (possibly partial) shot object to the state. The new shot is validated and completed first; if it has no usable
// layer the current shot is left untouched. Returns { error } or { warnings } (unknown layer types skipped, ids reassigned, ...).
// `reset` starts from the defaults (launch on, finale/variation at defaults) before applying the given values.
export function applyShot(s, { reset = false } = {}) {
  let filled = null;
  if (s.layers) {
    filled = fillLayers(clone(s.layers));
    if (!filled.layers.length) return { error: 'The shot has no usable layer (unknown layer types?); nothing was changed.' };
  }
  if (reset) { state.shot.launch = true; state.shot.burstHeight = 170; Object.assign(state.shot.finale, defaultFinale()); Object.assign(state.shot.variation, defaultVariation()); }
  if (s.seed != null) state.seed = s.seed;
  if (s.burstHeight != null) state.shot.burstHeight = s.burstHeight;
  if (s.launch != null) state.shot.launch = s.launch;
  if (s.finale) Object.assign(state.shot.finale, defaultFinale(), s.finale);
  if (s.variation) Object.assign(state.shot.variation, defaultVariation(), s.variation);
  if (filled) state.shot.layers = filled.layers;
  return { warnings: filled ? filled.warnings : [] };
}

// The whole shot as saved in finale presets (JSON-safe, independent copy)
export const shotSnapshot = () => clone({ seed: state.seed, burstHeight: state.shot.burstHeight, launch: state.shot.launch, finale: state.shot.finale, variation: state.shot.variation, layers: state.shot.layers });
