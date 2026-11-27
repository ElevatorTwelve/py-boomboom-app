export default {
  id: 'kamuro', name: 'Kamuro / Brocade crown', palette: 'Gold', best: 3.6, launch: 0.75, colors: { main: 'Colour', trail: 'Trail colour' },
  burst(c) {
    c.stars({ n: 480, radius: 68, k: 0.05, T: 2.8, life: [6.5, 8.5], size: 0.12, inten: 6, grav: 0.75, trail: c.trail('kamuro'), smoke: 0.35 });
  },
};
