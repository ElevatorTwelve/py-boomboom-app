// Memory layout of the light-particle pool (array-of-structs in one Float32Array).
export const S = 35; // stride
export const PX = 0, PY = 1, PZ = 2, VX = 3, VY = 4, VZ = 5;
export const AGE = 6, LIFE = 7, DRAG = 8, SIZE = 9, INTEN = 10;
export const R1 = 11, G1 = 12, B1 = 13, R2 = 14, G2 = 15, B2 = 16;
export const SHIFT = 17, KIND = 18, TRATE = 19, TSPEC = 20;
export const SHZ = 21, SDUTY = 22, PHASE = 23, EVT = 24, EVAT = 25, EVSPEC = 26;
export const GRAV = 27, SMRATE = 28, FLK = 29, LB = 30;
export const LID = 31, PUFF = 32, PUFFR = 33, SER = 34;   // launch (fire) id, death-puff probability, puff size scale, serial (per-launch particle number for stars/pops; world number for sparks)

export const K_STAR = 0, K_SPARK = 1, K_POP = 2, K_FLASH = 3, K_TAIL = 4;

export const EV_SPLIT = 1, EV_POP = 2;

// smoke pool layout
export const SS = 16;
export const SPX = 0, SPY = 1, SPZ = 2, SVX = 3, SVY = 4, SVZ = 5, SAGE = 6, SLIFE = 7;
export const SR0 = 8, SR1 = 9, SDENS = 10, SROT = 11, SSEED = 12, SBUOY = 13, SKIND = 14, SFID = 15;
