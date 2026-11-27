export default {
  id: 'crossette', name: 'Crossette', palette: 'Red / Green', best: 2.7, colors: { main: 'Parent colour', secondary: { label: 'Children colour (blank = same as parent)', default: null }, trail: 'Trail colour' },
  burst(c) {
    // bright shell stars that each split into a legible four-way cross with a flash
    c.stars({
      n: 48, radius: 50, k: 0.03, life: [2.6, 3.0], size: 0.2, inten: 60, trail: c.trail('short', { rate: 24, inten: 6 }), jitter: 0.6,
      event: {
        type: 'split', mode: 'cross', at: [1.0, 1.25], speed: [26, 34], inherit: 0.4,
        child: { color: c.has('secondary') ? c.pal('secondary')[0].c : undefined, life: [1.6, 2.2], k: 0.045, size: 0.2, inten: 70, grav: 1, trail: c.trail('medium', { rate: 40, inten: 5 }) },
      },
    });
  },
};
