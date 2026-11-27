export default {
  id: 'pistil', name: 'Pistil', palette: 'Red', best: 1.8, colors: { main: 'Outer colour', secondary: { label: 'Core colour', default: 'White' } },
  burst(c) {
    c.stars({ n: 280, radius: 72, k: 0.035, life: [2.3, 3.2], size: 0.14, inten: 50 });
    c.stars({ n: 120, radius: 34, k: 0.04, life: [2.0, 2.8], size: 0.13, inten: 50, palette: c.pal('secondary', 'White') });
  },
};
