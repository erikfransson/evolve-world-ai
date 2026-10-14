// The one place that says where things sit in a resident creature row and in the fill kernel's call block. resident.ts and fillKernel.ts
// read the offsets from here, and scripts/wasmAssemble.ts substitutes them for the {{NAME}} tokens of fill.wat, so the two sides cannot drift apart.
// Offsets are in bytes from the start of the row or block.

export const LAYOUT = {
  ROW_BYTES: 192,
  // f64 fields of a row
  R_X: 0,
  R_Y: 8,
  R_VX: 16,
  R_VY: 24,
  R_ENERGY: 32,
  R_HEADING: 40,
  R_TURN: 48,
  R_TICKS: 56,
  R_COS: 64,
  R_SIN: 72,
  R_UPKEEP: 80, // the plan's energy per second besides thrust and turning
  R_GROUND_FACTOR: 88, // speed factor of the ground under the creature, set with the sense inputs and used by the step
  R_RAY_LENGTH: 96,
  // the brain input extras the fill kernel copies (as f32) after the ray features: energy signal, forward and sideways speed, turn rate, ground value
  R_EXTRAS: 104, // five f64, to 144
  // i32 fields of a row
  R_OUT: 144, // byte address of the brain outputs: turn, thrust, then one target per memory unit
  R_SPECIES: 148,
  R_SHORT: 152, // short-term memory units
  R_UNIT_COUNT: 156,
  R_UNITS: 160, // byte address of the memory units, f64 each, in a block of their own
  R_RAYS: 164,
  R_OFFSETS: 168, // byte address of the ray offset cos and sin tables
  R_INPUT: 172, // byte address of the brain input vector
  R_SLOT: 176, // brain slot
  // call block of fill (i32 unless noted)
  F_N: 0,
  F_ROWS: 4,
  F_SELVES: 8,
  F_REC: 12,
  F_PLACE: 16,
  F_COUNT: 20,
  F_SLOTS: 24,
  F_DETAIL_PTR: 28,
  F_DETAIL_ROW: 32,
  F_STRIDE: 36,
  F_ITEM_ROWS: 40,
  F_INV_CELL: 48, // f64
  F_BYTES: 64,
} as const;

// The offset in f64 elements, for a byte offset of an f64 field.
export const f64At = (bytes: number): number => bytes / 8;
// The offset in i32 elements.
export const i32At = (bytes: number): number => bytes / 4;
