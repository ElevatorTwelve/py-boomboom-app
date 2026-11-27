export default {
  id: 'chrysanthemum', name: 'Chrysanthemum', palette: 'Green', best: 2.2, colors: { main: 'Colour', trail: 'Trail colour' },
  burst(c) {
    c.stars({ n: 300, radius: 64, k: 0.03, life: [3.0, 4.0], size: 0.14, inten: 42, trail: c.trail('medium'), smoke: 0.35 });
  },
};
