// Shared trail (spark-shedding) presets. Sparks are drag-heavy falling embers.
const base = { rate: 30, life: [0.4, 1.0], size: 0.045, inten: 4, speed: 1.2, k: 0.28, grav: 0.9, inherit: 0.04, amount: 1, tint: 0.55, color: null, flicker: 0.6 };
const mk = (o) => ({ ...base, ...o });

export const TRAILS = {
  short:  mk({ rate: 26, life: [0.35, 0.8], inten: 4.5 }),
  medium: mk({ rate: 38, life: [0.6, 1.3], inten: 4 }),
  gold:   mk({ rate: 55, life: [0.8, 1.8], inten: 4.5, color: [1.0, 0.45, 0.07], k: 0.3 }),
  willow: mk({ rate: 85, life: [1.4, 2.8], inten: 3.6, color: [1.0, 0.4, 0.06], k: 0.55, grav: 0.8, size: 0.04, speed: 0.8 }),
  kamuro: mk({ rate: 110, life: [1.8, 3.2], inten: 3.2, color: [1.0, 0.5, 0.1], k: 0.5, grav: 0.75, size: 0.035, speed: 1.0, flicker: 0.9 }),
  thick:  mk({ rate: 140, life: [0.6, 1.4], inten: 5.5, size: 0.08, color: [1.0, 0.5, 0.1], k: 0.35, speed: 2.5 }),
  fine:   mk({ rate: 160, life: [0.25, 0.5], inten: 3.5, size: 0.035, color: [1.0, 0.6, 0.2], k: 0.4, speed: 0.5 }),
  glitter: mk({ rate: 22, life: [1.2, 2.4], inten: 7, size: 0.05, color: [1.0, 0.72, 0.35], k: 0.4, flicker: 1 }),
};
export const trail = (name, over = {}) => ({ ...TRAILS[name], ...over });
