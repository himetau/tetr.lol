// Random board generator for the all-spin B2B trainer. Each board carries at
// least one genuine spin slot (a covered notch a rotation can tuck into),
// verified reachable through the real SRS kick tables. The player has to read
// the board, build/keep the setup, and clear with a spin to hold back-to-back.

import { Game } from "../core/game";
import { Board, BOARD_H, BOARD_W } from "../core/board";
import { cellsAt, type PieceType, type Rot } from "../core/pieces";
import { mulberry32 } from "../core/rng";

const FULL = (1 << BOARD_W) - 1;
const SPIN_PIECES: PieceType[] = ["T", "S", "Z", "L", "J"];

// Carve a board whose completed spin (piece at rot,x,y) fills `lines` rows,
// minus the piece cells, plus an overhang cell forcing a real tuck.
function carve(
  piece: PieceType,
  rot: Rot,
  x: number,
  y: number,
  overhang: [number, number][],
): Board | null {
  const cells = cellsAt(piece, rot, x, y);
  for (const [cx, cy] of cells) {
    if (cx < 0 || cx >= BOARD_W || cy < 0) {
      return null;
    }
  }
  const ys = [...new Set(cells.map(([, cy]) => cy))].sort((a, b) => a - b);
  const board = new Board();
  const isPiece = (cx: number, cy: number) => cells.some(([a, b]) => a === cx && b === cy);
  for (const ry of ys) {
    board.rows[ry] = FULL;
    for (const [cx, cy] of cells) {
      if (cy === ry) {
        board.rows[ry] &= ~(1 << cx);
      }
    }
  }
  for (const [ox, oy] of overhang) {
    if (ox < 0 || ox >= BOARD_W || oy < 0 || isPiece(ox, oy)) {
      return null;
    }
    board.rows[oy] |= 1 << ox;
  }
  // no row may already be complete (that would clear on its own)
  for (const ry of ys) {
    if (board.rows[ry] === FULL) {
      return null;
    }
  }
  return board;
}

// Drop leading empty bottom rows so the stack rests on the floor.
function settle(board: Board): Board {
  let shift = 0;
  while (
    shift < BOARD_H &&
    board.rows[shift] === 0 &&
    board.rows.some((r, i) => i > shift && r !== 0)
  ) {
    shift++;
  }
  if (shift === 0) {
    return board;
  }
  const b = new Board();
  for (let y = 0; y + shift < BOARD_H; y++) {
    b.rows[y] = board.rows[y + shift];
  }
  return b;
}

// Brute-force a spin entry (orient, shift, soft-drop, rotate-tuck, lock) and
// report whether some entry lands a clean spin *double* - the satisfying
// B2B-keeping clear the board is built around. Doubles clear both slot rows
// with no leftover holes, so the taught move is unambiguous and clean.
function hasSpinDouble(board: Board, piece: PieceType): boolean {
  for (let preRot = 0 as Rot; preRot < 4; preRot = (preRot + 1) as Rot) {
    for (let preX = 0; preX < BOARD_W; preX++) {
      for (const dir of [1, -1, 2] as const) {
        const g = new Game(1);
        g.reset(board.clone(), 1, [piece]);
        orient(g, preRot);
        if (!shiftTo(g, preX)) {
          continue;
        }
        g.softDropToFloor();
        if (!g.rotate(dir)) {
          continue;
        }
        const ev = g.hardDrop();
        if (ev && ev.spin !== "none" && ev.linesCleared >= 2) {
          return true;
        }
      }
    }
  }
  return false;
}
function orient(g: Game, rot: Rot): void {
  if (rot === 1) {
    g.rotate(1);
  } else if (rot === 3) {
    g.rotate(-1);
  } else if (rot === 2) {
    g.rotate(2);
  }
}
function shiftTo(g: Game, x: number): boolean {
  let guard = 20;
  while (g.active && g.active.x < x && guard-- > 0) {
    if (!g.moveRight()) {
      break;
    }
  }
  guard = 20;
  while (g.active && g.active.x > x && guard-- > 0) {
    if (!g.moveLeft()) {
      break;
    }
  }
  return !!g.active && g.active.x === x;
}

export interface AllspinSetup {
  board: Board;
  spinPiece: PieceType;
}

/**
 * Generate a random spin-able board. `garbage` adds a couple of cluttered rows
 * under the slot for the messier "keep B2B through garbage" flavour. Returns a
 * board plus the piece the seeded slot is for (used to front-load the queue).
 */
export function genAllspin(seed: number, garbage = false): AllspinSetup {
  const rng = mulberry32(seed);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];
  for (let attempt = 0; attempt < 400; attempt++) {
    const piece = pick(SPIN_PIECES);
    const rot = Math.floor(rng() * 4) as Rot;
    const cx = 2 + Math.floor(rng() * 6); // slot centre column
    const ohSide = rng() < 0.5 ? -1 : 1;
    const overhang: [number, number][] = [
      [cx + ohSide, 2],
      ...(rng() < 0.4 ? [[cx + ohSide, 3] as [number, number]] : []),
    ];
    let board = carve(piece, rot, cx, 1, overhang);
    if (!board) {
      continue;
    }
    board = settle(board);
    if (garbage) {
      board = addGarbage(board, rng);
    }
    if (board.maxHeight() > 12) {
      continue;
    }
    if (hasSpinDouble(board, piece)) {
      return { board, spinPiece: piece };
    }
  }
  // fallback: a guaranteed T-spin double
  return { board: Board.fromStrings(["___X______", "XXX___XXXX", "XXXX_XXXXX"]), spinPiece: "T" };
}

// Insert 1-2 garbage rows at the bottom (full minus a couple of holes),
// keeping the holes off the slot columns so the tuck path stays clear.
function addGarbage(board: Board, rng: () => number): Board {
  const rows = 1 + Math.floor(rng() * 2);
  const b = new Board();
  for (let y = 0; y + rows < BOARD_H; y++) {
    b.rows[y + rows] = board.rows[y];
  }
  for (let i = 0; i < rows; i++) {
    let row = FULL;
    const holes = 1 + Math.floor(rng() * 2);
    for (let h = 0; h < holes; h++) {
      row &= ~(1 << Math.floor(rng() * BOARD_W));
    }
    b.rows[i] = row;
  }
  return b;
}
