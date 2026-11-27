export default {
  id: 'saturn', name: 'Saturn (double ring)', palette: 'Purple', best: 1.8, colors: { main: 'Ring colour', secondary: { label: 'Core colour', default: 'Gold' } },
  burst(c) {
    c.stars({ n: 120, dirs: 'ring', thickness: 0.03, radius: 86, k: 0.03, life: [2.8, 3.6], size: 0.15, inten: 55, jitter: 0.4 });
    c.stars({ n: 130, radius: 38, k: 0.035, life: [2.2, 3.0], size: 0.14, inten: 45, palette: c.pal('secondary', 'Gold') });
  },
};
