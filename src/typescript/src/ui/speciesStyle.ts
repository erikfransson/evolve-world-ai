// How the Great Hunt species look, shared by the page, the brain view and the landing card.

// Line, swatch and label colour per species index: prey blue, predators red.
export const SPECIES_COLORS: readonly string[] = ["#60a5fa", "#f87171"];

export const HUNTER_NOSE = 2; // a hunter's nose tip, in radii ahead of its centre
const NOSE_HALF = Math.acos(1 / HUNTER_NOSE); // where the nose lines touch the round back, so the outline is a smooth teardrop

// Adds a hunter's outline to the current path: a round back with a pointed nose along its heading.
export function hunterPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, heading: number): void {
  ctx.moveTo(x + Math.cos(heading) * r * HUNTER_NOSE, y + Math.sin(heading) * r * HUNTER_NOSE);
  ctx.arc(x, y, r, heading + NOSE_HALF, heading - NOSE_HALF + 2 * Math.PI);
  ctx.closePath();
}

// Distance from the centre within which the whole hunter outline lies, in radii.
export const HUNTER_REACH = HUNTER_NOSE;
