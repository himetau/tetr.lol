// SRS kick tables with tetr.io-style 180 kicks ("SRS+" 180 spins enabled).
// Offsets are (dx, dy) with y up, tried in order.

import type { PieceType, Rot } from './pieces';
import { cellsAt } from './pieces';
import type { Board } from './board';

type Kick = readonly [number, number];

// Key: `${from}>${to}`
const JLSTZ_KICKS: Record<string, Kick[]> = {
  '0>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '1>0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '1>2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '2>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '2>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '3>2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '3>0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '0>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};

const I_KICKS: Record<string, Kick[]> = {
  '0>1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '1>0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '1>2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  '2>1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '2>3': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '3>2': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '3>0': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '0>3': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};

// tetr.io SRS+ 180 kicks (all pieces; I uses the same table there).
const KICKS_180: Record<string, Kick[]> = {
  '0>2': [[0, 0], [0, 1], [1, 1], [-1, 1], [1, 0], [-1, 0]],
  '2>0': [[0, 0], [0, -1], [-1, -1], [1, -1], [-1, 0], [1, 0]],
  '1>3': [[0, 0], [1, 0], [1, 2], [1, 1], [0, 2], [0, 1]],
  '3>1': [[0, 0], [-1, 0], [-1, 2], [-1, 1], [0, 2], [0, 1]],
};

export function kicksFor(type: PieceType, from: Rot, to: Rot): Kick[] {
  const key = `${from}>${to}`;
  if (type === 'O') return [[0, 0]];
  if ((from + 2) % 4 === to) return KICKS_180[key] ?? [[0, 0]];
  return (type === 'I' ? I_KICKS : JLSTZ_KICKS)[key] ?? [[0, 0]];
}

export interface RotateResult {
  x: number;
  y: number;
  rot: Rot;
  kickIndex: number;
}

/** Attempt rotation with kicks; returns the new position or null if blocked. */
export function tryRotate(
  board: Board,
  type: PieceType,
  rot: Rot,
  x: number,
  y: number,
  dir: 1 | -1 | 2,
): RotateResult | null {
  const to = ((rot + dir + 4) % 4) as Rot;
  const kicks = kicksFor(type, rot, to);
  for (let i = 0; i < kicks.length; i++) {
    const [dx, dy] = kicks[i];
    if (!board.collides(cellsAt(type, to, x + dx, y + dy))) {
      return { x: x + dx, y: y + dy, rot: to, kickIndex: i };
    }
  }
  return null;
}
