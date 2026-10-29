// The one place that says where things sit in a resident creature row, in the 64-byte sense record and in the call blocks of the kernels (fill, step, crowd, members, sense).
// The TypeScript side reads the offsets from here, and scripts/wasmAssemble.ts substitutes them for the {{NAME}} tokens of the .wat files, so the two sides cannot drift apart.
// Offsets are in bytes from the start of the row or block.

import { GROUND_BLOCK_SHIFT, GROUND_HALF, GROUND_PAD } from "../groundField.ts";
import { EXTRA_INPUTS, EXTRA_SIDE, EXTRA_SPEED, EXTRA_TERRAIN, EXTRA_TURN } from "../sensors.ts";

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
  R_EXTRAS: 104, // EXTRAS f64, to R_OUT
  R_EXTRA_SPEED: 104 + 8 * EXTRA_SPEED,
  R_EXTRA_SIDE: 104 + 8 * EXTRA_SIDE,
  R_EXTRA_TURN: 104 + 8 * EXTRA_TURN,
  R_EXTRA_GROUND: 104 + 8 * EXTRA_TERRAIN,
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
  // brain input extras: how many, and the byte offset of the first memory unit from the first extra
  EXTRAS: EXTRA_INPUTS,
  UNITS_AT: 4 * EXTRA_INPUTS,
  // sense record, 64 bytes (fill.wat writes it, sense.wat reads it; senser.ts reads the same offsets): f64 x y cos sin ray length, i32 crowd index of the creature, rays,
  // byte address of its ray offset tables, byte address of its brain input, and where to write its rays for the UI (0 for none)
  REC_BYTES: 64,
  REC_SHIFT: 6, // log2 of REC_BYTES
  REC_X: 0,
  REC_Y: 8,
  REC_COS: 16,
  REC_SIN: 24,
  REC_RAY_LENGTH: 32,
  REC_SELF: 40,
  REC_RAYS: 44,
  REC_OFFSETS: 48,
  REC_INPUT: 52,
  REC_DETAIL: 56,
  // call block of sense (sense.wat; the tick's item grid, crowd columns, rock tables and batch). f64 and f32 where marked, else i32 (addresses in bytes)
  S_WORLD_W: 0, // f64
  S_WORLD_H: 8, // f64
  S_ITEM_R: 16, // f64
  S_INV_ITEM_CELL: 24, // f64
  S_INV_CROWD_CELL: 32, // f32
  S_CROWD_R: 36, // f32
  S_ITEM_COLS: 40,
  S_ITEM_ROWS: 44,
  S_ITEM_START: 48,
  S_ITEM_XY: 56,
  S_ITEM_KIND: 64,
  S_CROWD_COLS: 68,
  S_CROWD_ROWS: 72,
  S_CROWD_START: 76,
  S_SX: 80,
  S_SY: 84,
  S_OWN: 88,
  S_SIG: 92,
  S_REC: 96,
  S_N: 100,
  S_STRIDE: 104,
  S_CAND: 108,
  S_SCRATCH: 112,
  S_SPECIES: 116,
  S_ROCK_MAX_R: 128, // f64
  S_INV_ROCK_CELL: 136, // f64
  S_ROCK_COLS: 144,
  S_ROCK_ROWS: 148,
  S_ROCK_START: 152,
  S_ROCK_ORDER: 156,
  S_ROCK_XYR: 160,
  S_ROCK_LB: 168, // f32 per rock cell, a lower bound of the distance to the nearest disc edge (rockLowerBound)
  S_BYTES: 192,
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
  F_OWNERS: 40,
  F_CROWD_N: 44,
  F_BYTES: 64,
  // call block of prepare (fill.wat; i32 unless noted) and its species block (f64): the speeds, turn rate and ground under each creature as brain input extras, and the ground factor
  G_N: 0,
  G_ROWS: 4,
  G_SPECIES: 8, // address of the species blocks
  G_RASTER: 12, // address of the ground field's nodes (2 bytes each), 0 for none
  G_STRIDE: 16, // bytes per raster row
  G_EMPTY: 20, // 1 when the map has no rock and no patches
  G_INV: 24, // f64: the field's 1 / cell
  G_COL_MAX: 32, // f64: cols - 1.0001
  G_ROW_MAX: 40, // f64: rows - 1.0001
  G_SLOW: 48, // f64: speed factor on mud and on firm ground
  G_FAST: 56, // f64
  G_MASK: 64, // address of the ground field's block flags (GroundField.blockFlags)
  G_MASK_COLS: 68, // blocks per row of them
  G_BYTES: 80,
  G_BLOCK_SHIFT: GROUND_BLOCK_SHIFT,
  G_PAD: GROUND_PAD, // the field's constants, as values for the wat
  G_HALF: GROUND_HALF,
  H_DRAG: 0,
  H_MAX_THRUST: 8,
  H_MAX_TURN: 16,
  H_BYTES: 24,
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
  P_CLEAR_SHIFT: 72,
  P_AGING_START: 80, // f64
  P_AGING_PER_TICK: 88, // f64
  P_BYTES: 96,
  // call block of crowd (i32 unless noted)
  C_N: 0,
  C_ROW_AT: 4, // f64 index of each creature's row, in creature order
  C_CELL_OF: 8, // scratch
  C_COLS: 12,
  C_ROWS: 16,
  C_RADIX_BITS: 20,
  C_RADIX_PASSES: 24,
  C_COUNT: 28, // scratch of the radix sort
  C_PERM: 32,
  C_PERM_B: 36,
  C_CELL_START: 40, // the grid, as Crowd's arrays
  C_OCCUPIED: 44,
  C_SPECIES_IN: 48, // species of each creature in creature order, 0 for none
  C_XS: 52,
  C_YS: 56,
  C_ENERGIES: 60,
  C_SPECIES: 64,
  C_OWNERS: 68,
  C_OCCUPIED_COUNT: 72, // out
  C_SX: 76, // pack's outputs, f32 per creature in sorted order
  C_SY: 80,
  C_SIG: 84,
  C_CELL: 88, // f64
  C_START_ENERGY: 96, // f64, pack's input
  C_ITEM_START: 104, // touch's inputs: the packed item rows of the sense kernel and the item grid, and where the item of each creature goes
  C_ITEM_XY: 108,
  C_ITEM_IDS: 112,
  C_ITEM_COLS: 116,
  C_ITEM_ROWS: 120,
  C_TOUCH_OUT: 124,
  C_INV_ITEM_CELL: 128, // f64
  C_ITEM_REACH: 136, // f64
  C_REACH2: 144, // f64, the sweep's squared contact distance
  C_SW_O: 152, // the sweep's place: occupied cell, first creature, which run, second creature, and whether the next call resumes there
  C_SW_S: 156,
  C_SW_PHASE: 160,
  C_SW_T: 164,
  C_SW_RESUME: 168,
  C_HIT_S: 172, // out: the pair found, as sorted slots
  C_HIT_T: 176,
  C_SIG_ROWS: 180, // pack's input: nonzero also stores each energy signal into its row's first extra (as f64)
  C_BYTES: 184,
  // call block of members (i32)
  M_N: 0,
  M_ROW_AT: 4, // f64 index of each member's row, in member order
  M_OUT: 8, // the list of member indices found
  M_OUT_COUNT: 12,
  M_THRESHOLDS: 16, // f64 per member
  M_FIRST: 20, // birthCandidates: the member to look at next (the kernel advances it)
  M_SEED: 24, // mutateScan: the generator state in, and out after the last draw
  M_LIMIT: 28, // mutateScan: a gene mutates when its draw is below this (unsigned)
  M_MAX: 32, // birthCandidates: stop after this many found
  M_STEPS: 36, // birthCandidates: members looked at so far
  M_BYTES: 40,
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
  Q_NEAR: 136, // i32: address of the clear-of-rock raster, a bit per square, for this species' radius
  Q_BYTES: 144,
} as const;

// The offset in f64 elements, for a byte offset of an f64 field.
export const f64At = (bytes: number): number => bytes / 8;
// The offset in i32 elements.
export const i32At = (bytes: number): number => bytes / 4;
