export default {
  id: 'willow', name: 'Willow', palette: 'Gold', best: 3.2, launch: 0.8, colors: { main: 'Colour', trail: 'Trail colour' },
  burst(c) {
    c.stars({ n: 230, radius: 58, k: 0.055, T: 3.0, life: [5.5, 7.5], size: 0.12, inten: 5, grav: 0.65, trail: c.trail('willow'), smoke: 0.4 });
  },
};
