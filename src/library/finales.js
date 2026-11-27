// Built-in (read-only) grand finale presets. A finale preset is a whole shot: layers, finale timing/position, variation, seeds.
import { layerOf as L, seq } from './index.js';

const fin = (totalTime, spreadX, spreadZ, heightVar, posSeed) => ({ enabled: true, totalTime, spreadX, spreadZ, heightVar, posSeed });
const vary = (v) => ({ enabled: true, burstVel: v, lifetime: v, smokeAmount: 2 * v, smokeLife: v, launchSpeed: 10, seed: 7 });

export const FINALE_PRESETS = {
  'Park finale (22 s, wide)': () => ({
    seed: 20260711, burstHeight: 175, launch: true, finale: fin(22, 320, 140, 25, 11), variation: vary(18),
    layers: seq([
      L('pistil', { palette: 'Blue', palette2: 'White', repeats: 5, startOffset: 0, noise: 0.3, expanse: 0.9, launchSpeed: 1.15 }),
      L('peony', { palette: 'Red', repeats: 8, noise: 0.35, expanse: 0.85, launchSpeed: 1.05 }),
      L('chrysanthemum', { palette: 'Green', repeats: 6, startOffset: 2, noise: 0.3, launchStyle: 'silver', launchSpeed: 1.1 }),
      L('crossette', { palette: 'Red / Green', repeats: 4, startOffset: 4, noise: 0.4 }),
      L('willow', { palette: 'Gold', repeats: 4, startOffset: 6, launchStyle: 'spiral', expanse: 0.9, launchSpeed: 0.9 }),
      L('palm', { palette: 'Gold', repeats: 3, startOffset: 9, launchStyle: 'spiral' }),
      L('crackle', { palette: 'Gold', repeats: 4, startOffset: 12, interval: 1.6, noise: 0.4, launchStyle: 'crackle', launchSpeed: 1.2 }),
      L('strobe', { palette: 'Silver', repeats: 3, startOffset: 12, expanse: 0.8 }),
      L('kamuro', { palette: 'Gold', repeats: 3, startOffset: 15, expanse: 0.9, launchSpeed: 0.85 }),
    ]),
  }),
  'Rapid barrage (9 s)': () => ({
    seed: 4242, burstHeight: 150, launch: true, finale: fin(9, 240, 90, 20, 5), variation: vary(25),
    layers: seq([
      L('peony', { palette: 'Pink', repeats: 14, interval: 0.5, noise: 0.6, expanse: 0.7, launchStyle: 'dark', launchSpeed: 1.2 }),
      L('chrysanthemum', { palette: 'Aqua', repeats: 12, interval: 0.6, startOffset: 0.3, noise: 0.6, expanse: 0.7, launchStyle: 'dark' }),
      L('ring', { palette: 'Gold', repeats: 8, interval: 0.9, startOffset: 0.6, noise: 0.5, expanse: 0.6, launchSpeed: 1.3 }),
      L('strobe', { palette: 'White', repeats: 4, interval: 1.5, startOffset: 4, noise: 0.3, expanse: 0.7 }),
    ]),
  }),
  'Golden crown finale (18 s)': () => ({
    seed: 777, burstHeight: 185, launch: true, finale: fin(18, 280, 120, 30, 3), variation: vary(15),
    layers: seq([
      L('kamuro', { palette: 'Gold', repeats: 5, noise: 0.25, launchStyle: 'gold', launchSpeed: 0.8 }),
      L('willow', { palette: 'Gold', repeats: 5, startOffset: 1, noise: 0.3, launchStyle: 'silver', expanse: 0.9 }),
      L('horsetail', { palette: 'Gold', repeats: 4, startOffset: 4, noise: 0.3, launchStyle: 'spiral', launchSpeed: 0.9 }),
      L('waterfall', { palette: 'Silver', repeats: 3, startOffset: 8, noise: 0.3, launchSpeed: 0.7 }),
      L('dragoneggs', { palette: 'Orange', repeats: 3, startOffset: 10, noise: 0.3 }),
    ]),
  }),
};
