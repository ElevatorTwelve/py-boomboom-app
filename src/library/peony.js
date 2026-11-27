export default {
  id: 'peony', name: 'Peony', palette: 'Red', best: 1.8, launch: 1.1, colors: { main: 'Colour' },
  burst(c) {
    c.stars({ n: 380, radius: 70, k: 0.035, life: [2.3, 3.2], size: 0.14, inten: 50 });
  },
};
