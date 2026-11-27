export default {
  id: 'crackle', name: 'Crackle', palette: 'Gold', best: 1.8, launch: 1.3, colors: { main: 'Pop colour' },
  burst(c) {
    // a crackling carpet: many nearly invisible stars, each ending in a few tiny, fast white-gold micro-bursts
    const col = c.pal('main')[0].c, pop = [0.3 + 0.7 * col[0], 0.3 + 0.7 * col[1], 0.3 + 0.7 * col[2]];
    c.stars({
      n: 360, radius: 58, k: 0.03, life: [2.0, 3.2], size: 0.07, inten: 2.5, jitter: 1.4, smoke: 0.05,
      event: { type: 'pop', at: [0.5, 2.0], count: 6, spread: 1.4, bright: 1, pop: { size: [0.12, 0.3], life: [0.05, 0.12], inten: [50, 110] }, popColor: pop, popPuff: 0.15, puff: 0.1 },
    });
  },
};
