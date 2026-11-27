export default {
  id: 'palm', name: 'Palm', palette: 'Gold', best: 2.8, launch: 0.8, colors: { main: 'Colour', trail: 'Trail colour' },
  burst(c) {
    // a few chunky comets in a wide upward cone: they rise, arch over and fall as fronds shedding heavy sparks
    c.stars({ n: 8, dirs: 'cone', angle: 68, radius: 80, k: 0.017, T: 2.3, life: [4.2, 5.2], size: 0.55, inten: 90, speedVar: 0.06, jitter: 0.5, grav: 1.0, trail: c.trail('thick', { inten: 14, rate: 300, life: [1.2, 2.6], k: 0.22, size: 0.1, speed: 3 }), smoke: 0.9 });
    // short central trunk: slow sparks sinking from the break point
    c.stars({ n: 4, dirs: (n, rng) => { const d = new Float32Array(n * 3); for (let i = 0; i < n; i++) { d[i * 3] = rng.gauss() * 0.15; d[i * 3 + 1] = -1; d[i * 3 + 2] = rng.gauss() * 0.15; } return d; }, radius: 22, k: 0.05, life: [3, 4], size: 0.3, inten: 30, grav: 0.6, trail: c.trail('thick', { rate: 200, inten: 8, life: [1, 2.2] }) });
  },
};
