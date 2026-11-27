// Emitter colours as linear-light RGB resembling real pyrotechnic chemistry.
// `gain` scales emission brightness (copper blue is genuinely dim in real shells).
const C = {
  red:     { c: [1.0, 0.075, 0.035], gain: 1.0 },    // strontium
  green:   { c: [0.22, 1.0, 0.16], gain: 0.9 },      // barium
  blue:    { c: [0.14, 0.26, 1.0], gain: 0.5 },      // copper, dim and slightly washed
  yellow:  { c: [1.0, 0.58, 0.04], gain: 1.0 },      // sodium
  gold:    { c: [1.0, 0.42, 0.07], gain: 1.0 },      // charcoal / iron
  orange:  { c: [1.0, 0.24, 0.03], gain: 1.0 },      // calcium
  white:   { c: [1.0, 0.86, 0.72], gain: 1.1 },      // titanium / magnesium
  silver:  { c: [0.88, 0.94, 1.0], gain: 1.1 },
  purple:  { c: [0.55, 0.12, 0.95], gain: 0.7 },     // strontium + copper
  pink:    { c: [1.0, 0.22, 0.38], gain: 0.9 },
  lime:    { c: [0.55, 1.0, 0.1], gain: 0.9 },
  aqua:    { c: [0.12, 0.7, 0.9], gain: 0.55 },
};

export const PALETTES = {
  Red: [C.red], Green: [C.green], Blue: [C.blue], Yellow: [C.yellow], Gold: [C.gold],
  Orange: [C.orange], White: [C.white], Silver: [C.silver], Purple: [C.purple], Pink: [C.pink],
  Lime: [C.lime], Aqua: [C.aqua],
  'Red / Green': [C.red, C.green], 'Red / White / Blue': [C.red, C.white, C.blue],
  'Gold / Red': [C.gold, C.red], 'Purple / Gold': [C.purple, C.gold],
  'Green / Yellow': [C.green, C.yellow], 'Rainbow': [C.red, C.orange, C.yellow, C.green, C.blue, C.purple],
};

export const GOLD = C.gold.c;
export const WHITE = C.white.c;

export const PALETTE_NAMES = Object.keys(PALETTES);

// sRGB hex (#rrggbb) -> linear light rgb
export function hexToLinear(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  const ch = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return [ch((n >> 16) & 255), ch((n >> 8) & 255), ch(n & 255)];
}

// Per-layer colour components. `comp` is 'main' | 'secondary' | 'trail'; each has a palette name (or 'Custom') and a
// custom hex. Returns an array of {c, gain} entries, or `fallback` (array or palette name) when the component is unset.
const KEYS = { main: ['palette', 'customColor'], secondary: ['palette2', 'customColor2'], trail: ['palette3', 'customColor3'] };
export function resolvePalette(layer, comp, fallback) {
  const [nk, ck] = KEYS[comp], name = layer[nk];
  if (name === 'Custom') return [{ c: hexToLinear(layer[ck]), gain: 1 }];
  if (name && PALETTES[name]) return PALETTES[name];
  if (Array.isArray(fallback)) return fallback;
  return PALETTES[fallback] || PALETTES.Gold;
}
