export default {
  id: 'horsetail', name: 'Horsetail', palette: 'Gold', best: 3.2, launch: 0.8, colors: { main: 'Colour', trail: 'Trail colour' },
  burst(c) {
    // few heavy comets in a tight upward cone, falling in long drooping golden tails
    c.stars({ n: 26, dirs: 'cone', angle: 42, radius: 68, k: 0.045, T: 2.4, speedVar: 0.08, life: [6, 8], size: 0.4, inten: 40, grav: 1.1, jitter: 0.8,
      trail: c.trail('willow', { rate: 260, inten: 6, life: [2.5, 4.5], k: 0.45, grav: 1.1, size: 0.07, speed: 1.2 }), smoke: 0.7 });
  },
};
