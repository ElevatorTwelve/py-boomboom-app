// Registry: add a type by creating a file in this folder and listing it here.
import peony from './peony.js';
import chrysanthemum from './chrysanthemum.js';
import willow from './willow.js';
import palm from './palm.js';
import crossette from './crossette.js';
import ring from './ring.js';
import saturn from './saturn.js';
import dahlia from './dahlia.js';
import kamuro from './kamuro.js';
import crackle from './crackle.js';
import dragoneggs from './dragoneggs.js';
import waterfall from './waterfall.js';
import strobe from './strobe.js';
import horsetail from './horsetail.js';
import pistil from './pistil.js';
import spider from './spider.js';
import glitter from './glitter.js';

export const LIST = [peony, chrysanthemum, willow, palm, crossette, ring, saturn, dahlia, kamuro, crackle, dragoneggs, strobe, horsetail, waterfall, pistil, spider, glitter];
export const TYPES = Object.fromEntries(LIST.map((t) => [t.id, t]));
export { PALETTES, PALETTE_NAMES } from './palettes.js';

export const LAUNCH_STYLES = { 'gold comet': 'gold', 'silver tail': 'silver', 'spiral / twirl': 'spiral', 'crackling tail': 'crackle', 'dark fast shell': 'dark', 'none (invisible)': 'none' };

// Complete default values of one layer. Colours: palette / palette2 / palette3 are the main / secondary / trail components
// (a palette name or 'Custom'; null = the type's default), customColor* are the hex values used when 'Custom' is chosen.
export const layerDefaults = (type) => ({
  type, palette: TYPES[type].palette, palette2: TYPES[type].colors?.secondary?.default ?? null, palette3: null,
  customColor: '#ff8040', customColor2: '#ffffff', customColor3: '#ffd080',
  expanse: 1, stars: 1, bright: 1, delay: 0, offset: [0, 0, 0], enabled: true,
  randomTilt: false, tilt: 40, rotation: 180,            // Ring / Saturn: fixed world-space tilt that reads as a ring from the default camera
  launchStyle: 'gold', wobble: 1, launchSpeed: 1,   // launchSpeed multiplies the type's built-in launch speed (heavy shells rise slower)
  repeats: 1, interval: 0, startOffset: 0, noise: 0,     // grand finale only (interval 0 = auto)
});

// A layer without an id; ids are assigned per shot (they key the layer's RNG streams, so they must be stable and unique within a shot).
export const layerOf = (type, o = {}) => ({ ...layerDefaults(type), ...o });
export const seq = (layers) => layers.map((l, i) => ({ ...l, id: i + 1 }));   // fixed ids 1..n for presets
// new layer for an existing shot: id = highest id in use + 1
export const newLayer = (type, o = {}, existing = []) => {
  const used = existing.map((l) => l.id).filter((v) => Number.isInteger(v) && v > 0);
  return { ...layerDefaults(type), id: (used.length ? Math.max(...used) : 0) + 1, ...o };
};
const L = layerOf;

// Validate and complete a list of layers loaded from JSON: unknown types are dropped (reported in `warnings`), missing values get
// defaults, and ids that are duplicated, missing, strings, non-integer or not positive are reassigned the smallest unused integers.
export function fillLayers(layers) {
  const warnings = [], out = [];
  for (const l of layers) {
    if (!l || typeof l !== 'object' || !TYPES[l.type]) { warnings.push(`unknown layer type "${l && l.type}" was skipped`); continue; }
    out.push({ ...layerDefaults(l.type), ...l, offset: Array.isArray(l.offset) && l.offset.length === 3 ? [...l.offset] : [0, 0, 0] });
  }
  const used = new Set(), need = [];
  for (const l of out) { if (Number.isInteger(l.id) && l.id > 0 && !used.has(l.id)) used.add(l.id); else need.push(l); }
  let next = 1;
  for (const l of need) { while (used.has(next)) next++; l.id = next; used.add(next); }
  if (need.length) warnings.push(`${need.length} layer id(s) were invalid or duplicated and were reassigned`);
  return { layers: out, warnings };
}

export const PRESETS = Object.fromEntries(Object.entries({
  'Red peony': [L('peony')],
  'Chrysanthemum': [L('chrysanthemum')],
  'Gold willow': [L('willow')],
  'Red peony + gold willow': [L('peony', { palette: 'Red' }), L('willow', { delay: 0.12, expanse: 0.9 })],
  'Pistil + ring': [L('pistil', { palette: 'Green' }), L('ring', { palette: 'Pink', delay: 0.25, expanse: 0.7 })],
  'Saturn': [L('saturn')],
  'Palm + kamuro': [L('palm'), L('kamuro', { delay: 0.5, expanse: 0.8, offset: [0, 10, 0] })],
  'Crossette + strobe finale': [L('crossette'), L('strobe', { delay: 1.8, expanse: 0.85, offset: [20, 5, 0] })],
  'Double break': [L('chrysanthemum', { palette: 'Blue' }), L('peony', { palette: 'Red / White / Blue', delay: 1.2, expanse: 0.85, offset: [28, 12, -6] })],
  'Horsetail + Waterfall': [L('horsetail'), L('waterfall', { delay: 0.35, expanse: 1.1, offset: [0, -8, 0] })],
  'Crackle + Dragon Eggs': [L('crackle'), L('dragoneggs', { delay: 0.2, expanse: 0.9 })],
  'Willow + Crackle': [L('willow', { expanse: 0.8 }), L('crackle', { delay: 0.1 })],
}).map(([name, layers]) => [name, seq(layers)]));   // fixed ids 1..n, the same on every load
