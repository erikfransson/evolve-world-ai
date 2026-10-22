const TAU = 2 * Math.PI;

// An angle in [-pi, pi). Headings grow without bound while a creature spins, and a float32 of a large one is coarse.
export const wrapAngle = (a: number): number => a - TAU * Math.floor((a + Math.PI) / TAU);

