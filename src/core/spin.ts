// Spin detection. T uses the guideline 3-corner rule with front-corner
// full/mini distinction (the final TST kick, index 4, upgrades mini→full).
// Every other piece uses the tetr.io "all-spin" immobility rule: a piece
// rotated into a spot where it cannot move up, down, left or right is a spin
// and keeps back-to-back.

import { cellsAt, type PieceType, type Rot } from './pieces';
import type { Board } from './board';

export type SpinKind = 'none' | 'mini' | 'full';

// For each T rotation state, the two "front" corner offsets (the side the T
// points toward) and the two "back" corners, relative to the T center.
const FRONT: Record<Rot, [number, number][]> = {
  0: [[-1, 1], [1, 1]],
  1: [[1, 1], [1, -1]],
  2: [[-1, -1], [1, -1]],
  3: [[-1, 1], [-1, -1]],
};
const BACK: Record<Rot, [number, number][]> = {
  0: [[-1, -1], [1, -1]],
  1: [[-1, 1], [-1, -1]],
  2: [[-1, 1], [1, 1]],
  3: [[1, 1], [1, -1]],
};

export function detectSpin(
  board: Board,
  type: PieceType,
  rot: Rot,
  x: number,
  y: number,
  lastMoveWasRotation: boolean,
  lastKickIndex: number,
): SpinKind {
  if (!lastMoveWasRotation) return 'none';
  if (type !== 'T') {
    // all-spin: any non-T piece boxed in on all four sides after a rotation
    return isImmobile(board, type, rot, x, y) ? 'full' : 'none';
  }
  const frontFilled = FRONT[rot].filter(([dx, dy]) => board.filled(x + dx, y + dy)).length;
  const backFilled = BACK[rot].filter(([dx, dy]) => board.filled(x + dx, y + dy)).length;
  if (frontFilled + backFilled < 3) return 'none';
  if (frontFilled === 2) return 'full';
  return lastKickIndex === 4 ? 'full' : 'mini';
}

/** A piece that cannot shift left, right, up or down is "immobile". */
function isImmobile(board: Board, type: PieceType, rot: Rot, x: number, y: number): boolean {
  return board.collides(cellsAt(type, rot, x - 1, y))
    && board.collides(cellsAt(type, rot, x + 1, y))
    && board.collides(cellsAt(type, rot, x, y - 1))
    && board.collides(cellsAt(type, rot, x, y + 1));
}
