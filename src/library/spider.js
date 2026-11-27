export default {
  id: 'spider', name: 'Spider', palette: 'Silver', best: 1.5, launch: 1.25, colors: { main: 'Colour', trail: 'Trail colour' },
  burst(c) {
    c.stars({ n: 60, radius: 100, k: 0.012, T: 1.9, life: [2.5, 3.2], size: 0.12, inten: 90, grav: 0.3, jitter: 0.3, speedVar: 0.02, trail: c.trail('fine', { rate: 200 }) });
  },
};
