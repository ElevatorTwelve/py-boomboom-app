export default {
  id: 'dragoneggs', name: 'Dragon Eggs', palette: 'Orange', best: 3.0, colors: { main: 'Egg glow colour', secondary: { label: 'Pop colour', default: 'White' } },
  burst(c) {
    // few, larger stars that travel almost dark, then each pops with a bright flash and a small spray
    const pc = c.pal('secondary', 'White')[0].c;
    c.stars({
      n: 26, radius: 52, k: 0.03, life: [3.6, 4.6], size: 0.3, inten: 3.5, jitter: 1.2, smoke: 0.1,
      event: {
        type: 'pop', at: [1.8, 3.4], count: 1, spread: 0, bright: 1, pop: { size: [0.25, 0.5], life: [0.08, 0.16], inten: [70, 110] }, popColor: pc,
        flash: { size: 0.9, inten: 40, life: 0.18 }, spray: { n: 10, speed: [6, 16], life: [0.4, 0.9] }, popPuff: 0.5, puffScale: 2.2,
      },
    });
  },
};
