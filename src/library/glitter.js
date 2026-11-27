export default {
  id: 'glitter', name: 'Glitter / Time rain', palette: 'Gold', best: 2.8, colors: { main: 'Colour', trail: 'Trail colour' },
  burst(c) {
    c.stars({ n: 260, radius: 58, k: 0.04, life: [4.5, 6], size: 0.12, inten: 22, grav: 0.55, strobe: [9, 20], strobeDuty: 0.45, trail: c.trail('glitter') });
  },
};
