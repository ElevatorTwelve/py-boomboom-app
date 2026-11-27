export default {
  id: 'dahlia', name: 'Dahlia', palette: 'Orange', best: 1.1, launch: 0.85, colors: { main: 'Colour', secondary: { label: 'Shifts to', default: 'Silver' } },
  burst(c) {
    c.stars({ n: 84, radius: 80, k: 0.027, life: [3.2, 4.2], size: 0.22, inten: 38, shift: { at: 0.62, palette: c.pal('secondary', 'Silver') }, trail: c.trail('short', { rate: 20 }) });
  },
};
