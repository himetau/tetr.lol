// Center 4-wide geometry shared by the book generator (tools/gen-fourwide-db)
// and the runtime engine: the well sits on columns 3-6 with "infinite" wall
// columns either side, and a residual state is the bottom-3-rows pattern of
// the well encoded as a 12-bit key (bit = row * 4 + col, row 0 = bottom).

import { Board, BOARD_H, BOARD_W } from "../core/board";

export const WELL_X = 3;
export const WELL_W = 4;
/** walls span the whole board ("infinite" columns) so a piece can never be
 * steered over the top of them and out of the well; topped up after clears */
export const WALL_H = BOARD_H;

let WALL_MASK = 0;
for (let x = 0; x < BOARD_W; x++) {
  if (x < WELL_X || x >= WELL_X + WELL_W) {
    WALL_MASK |= 1 << x;
  }
}
const WELL_MASK = ((1 << WELL_W) - 1) << WELL_X;

export function wallMask(): number {
  return WALL_MASK;
}

/** Top the wall columns back up after clears - the "infinite" sides. */
export function refillWalls(board: Board): void {
  for (let y = 0; y < WALL_H; y++) {
    board.rows[y] |= WALL_MASK;
  }
}

/** Fresh trainer board: walls + a residual state in the well. */
export function stateToBoard(stateKey: number): Board {
  const b = new Board();
  refillWalls(b);
  for (let bit = 0; bit < 12; bit++) {
    if ((stateKey >>> bit) & 1) {
      const row = Math.floor(bit / WELL_W);
      const col = bit % WELL_W;
      b.rows[row] |= 1 << (WELL_X + col);
    }
  }
  return b;
}

/**
 * The well contents as a 12-bit residual key, or null when the well is not a
 * clean 3-cell residual in the bottom 3 rows (mid-piece mess, burned stack).
 * Wall height doesn't matter here - only well columns are read.
 */
export function residualKey(board: Board): number | null {
  let key = 0;
  let count = 0;
  for (let y = 0; y < BOARD_H; y++) {
    const wellBits = (board.rows[y] & WELL_MASK) >>> WELL_X;
    if (wellBits === 0) {
      continue;
    }
    // a residual must live in the bottom 3 rows
    if (y >= 3) {
      return null;
    }
    key |= wellBits << (y * WELL_W);
    for (let b = wellBits; b; b >>>= 1) {
      count += b & 1;
    }
  }
  return count === 3 ? key : null;
}
