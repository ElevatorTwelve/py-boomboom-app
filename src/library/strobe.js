export default {
  id: 'strobe', name: 'Strobe', palette: 'Silver', best: 2.6, launch: 1.15, colors: { main: 'Colour' },
  burst(c) {
    c.cloud = 0.25;   // little central cloud: the smoke is the field of separate puffs each star leaves behind
    c.stars({ n: 300, radius: 58, k: 0.04, life: [4.5, 6.5], size: 0.14, inten: 120, grav: 0.45, strobe: [5, 10], strobeDuty: 0.2, flicker: 0.1, smoke: 1, smokeRate: 0.25, puff: 6, puffScale: 0.8 });
  },
};
