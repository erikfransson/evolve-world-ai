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
  // call block of step (i32 unless noted)
  P_N: 0,
  P_ROWS: 4,
  P_SPECIES: 8, // address of the species blocks
  P_OUTPUT_SIZE: 12, // brain outputs before the memory targets
  P_AGING: 16, // 1 when old-age upkeep is on
  P_EMPTY: 20, // 1 when the map has no rock and no patches
  P_ROCKS: 24, // rock disc count
  P_ROCK_COLS: 28,
  P_ROCK_ROWS: 32,
  P_ROCK_START: 36, // address of the rock grid tables (Terrain.rockStart, rockOrder) and the discs as x, y, r (f64)
  P_ROCK_ORDER: 40,
  P_ROCK_XYR: 44,
  P_NEAR_COLS: 48, // size of the clear-of-rock rasters
  P_NEAR_ROWS: 52,
  P_MAX_ROCK_R: 56, // f64
  P_INV_ROCK_CELL: 64, // f64
  P_CLEAR_CELL: 72, // f64
  P_AGING_START: 80, // f64
  P_AGING_PER_TICK: 88, // f64
  P_BYTES: 96,
  // species block of step (f64 unless noted), one per species: the config values the step reads and the decay factors
  Q_DT: 0,
  Q_MAX_THRUST: 8,
  Q_DRAG: 16,
  Q_MAX_TURN: 24,
  Q_BRAKE_THRESHOLD: 32,
  Q_MAX_BRAKE: 40,
  Q_THRUST_COST: 48,
  Q_TURN_COST: 56,
  Q_RADIUS: 64,
  Q_WALL_BOUNCE: 72,
  Q_WIDTH: 80,
  Q_HEIGHT: 88,
  Q_SHORT_RATE: 96,
  Q_LONG_RATE: 104,
  Q_DECAY_TURN: 112,
  Q_DECAY_DRAG: 120,
  Q_DECAY_SIDE: 128,
  Q_NEAR: 136, // i32: address of the clear-of-rock raster for this species' radius
  Q_BYTES: 144,
} as const;

// The offset in f64 elements, for a byte offset of an f64 field.
export const f64At = (bytes: number): number => bytes / 8;
// The offset in i32 elements.
export const i32At = (bytes: number): number => bytes / 4;
