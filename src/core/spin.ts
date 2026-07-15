// T-spin detection: 3-corner rule with front-corner full/mini distinction.
// The final kick of the TST kick (index 4, the (±1, ∓2) kicks) upgrades a
// mini to a full spin, per guideline.

import type { PieceType, Rot } from './pieces';
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
  if (type !== 'T' || !lastMoveWasRotation) return 'none';
  const frontFilled = FRONT[rot].filter(([dx, dy]) => board.filled(x + dx, y + dy)).length;
  const backFilled = BACK[rot].filter(([dx, dy]) => board.filled(x + dx, y + dy)).length;
  if (frontFilled + backFilled < 3) return 'none';
  if (frontFilled === 2) return 'full';
  return lastKickIndex === 4 ? 'full' : 'mini';
}
