export default {
  id: 'ring', name: 'Ring', palette: 'Pink', best: 1.8, launch: 1.2, colors: { main: 'Colour' },
  burst(c) {
    c.stars({ n: 140, dirs: 'ring', thickness: 0.035, radius: 66, k: 0.033, life: [2.5, 3.4], size: 0.15, inten: 60, jitter: 0.5 });
  },
};
