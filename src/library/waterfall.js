export default {
  id: 'waterfall', name: 'Waterfall', palette: 'Silver', best: 4.6, launch: 0.75, colors: { main: 'Colour', trail: 'Trail colour' },
  burst(c) {
    // a dense curtain: stars barely expand, brake hard, then sink slowly while shedding fine sparks
    c.stars({ n: 300, dirs: 'cone', angle: 88, radius: 34, k: 0.07, T: 2.4, speedVar: 0.18, life: [7, 9.5], size: 0.1, inten: 4.5, grav: 0.8, jitter: 1.5,
      trail: c.trail('willow', { rate: 34, color: [1.0, 0.85, 0.6], inten: 2.6, life: [2.5, 4.5], k: 0.6, grav: 0.75, size: 0.04, speed: 0.5 }), smoke: 0.3 });
  },
};
