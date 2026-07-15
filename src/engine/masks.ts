// Precomputed row-bitmask piece data for fast collision tests (no per-check
// allocation, unlike cellsAt + Board.collides).

import { PIECE_CELLS, PIECE_TYPES, type PieceType, type Rot } from '../core/pieces';
import { BOARD_W, BOARD_H, type Board } from '../core/board';

export interface Span {
  dy: number;
  bits: number;  // cells of this row, bit (dx - minDx)
  minDx: number;
  maxDx: number;
}

export interface RotShape {
  spans: Span[];
  minDx: number;   // leftmost cell offset of the whole shape
  maxDx: number;
  minDy: number;
  /** for each x-offset column present: lowest dy (bottom profile) */
  bottom: { dx: number; dy: number }[];
}

const SHAPES = new Map<string, RotShape>();

for (const type of PIECE_TYPES) {
  for (let rot = 0 as Rot; rot < 4; rot++) {
    const cells = PIECE_CELLS[type][rot];
    const byDy = new Map<number, number[]>();
    for (const [dx, dy] of cells) {
      if (!byDy.has(dy)) byDy.set(dy, []);
      byDy.get(dy)!.push(dx);
    }
    const spans: Span[] = [];
    for (const [dy, dxs] of byDy) {
      const minDx = Math.min(...dxs);
      const maxDx = Math.max(...dxs);
      let bits = 0;
      for (const dx of dxs) bits |= 1 << (dx - minDx);
      spans.push({ dy, bits, minDx, maxDx });
    }
    const allDx = cells.map((c) => c[0]);
    const allDy = cells.map((c) => c[1]);
    const bottomMap = new Map<number, number>();
    for (const [dx, dy] of cells) {
      const cur = bottomMap.get(dx);
      if (cur === undefined || dy < cur) bottomMap.set(dx, dy);
    }
    SHAPES.set(`${type}${rot}`, {
      spans,
      minDx: Math.min(...allDx),
      maxDx: Math.max(...allDx),
      minDy: Math.min(...allDy),
      bottom: [...bottomMap.entries()].map(([dx, dy]) => ({ dx, dy })),
    });
  }
}

export function shape(type: PieceType, rot: Rot): RotShape {
  return SHAPES.get(`${type}${rot}`)!;
}

/** Fast collision: true if the piece at (x,y) overlaps stack/walls/floor. */
export function collidesFast(board: Board, type: PieceType, rot: Rot, x: number, y: number): boolean {
  const s = shape(type, rot);
  if (x + s.minDx < 0 || x + s.maxDx >= BOARD_W) return true;
  if (y + s.minDy < 0) return true;
  const rows = board.rows;
  for (const sp of s.spans) {
    const ry = y + sp.dy;
    if (ry >= BOARD_H) continue;
    if ((rows[ry] & (sp.bits << (x + sp.minDx))) !== 0) return true;
  }
  return false;
}

/** Landing y for a straight drop of (type,rot) at column x (from above). */
export function dropY(board: Board, type: PieceType, rot: Rot, x: number): number {
  const s = shape(type, rot);
  let y = -s.minDy; // lowest legal
  for (const { dx, dy } of s.bottom) {
    const h = board.columnHeight(x + dx);
    y = Math.max(y, h - dy);
  }
  return y;
}
