// Placement enumeration.
//
// `enumeratePlacements` - exact BFS over (x, y, rot, last-rotation-kick)
// with shift/rotate/soft-drop moves from spawn: finds every reachable lock
// position including tucks and spins. Used at the top level where the user's
// real alternatives (and their finesse paths) matter.
//
// `enumerateFast` - straight hard-drops per (rot, x) plus reachable T-slot
// spins for T pieces. Used inside the lookahead search where speed matters.

import { Board, BOARD_W } from "../core/board";
import { cellsAt, type Cell, type PieceType, type Rot } from "../core/pieces";
import { tryRotate } from "../core/srs";
import { detectSpin, type SpinKind } from "../core/spin";
import { SPAWN_X, SPAWN_Y } from "../core/game";
import { collidesFast, dropY, shape } from "./masks";

/** Canonical "piece:sorted-cells" key for matching placements by their cells. */
export function placementKey(piece: string, cells: readonly (readonly [number, number])[]): string {
  return (
    piece +
    ":" +
    cells
      .map(([x, y]) => x * 32 + y)
      .sort((a, b) => a - b)
      .join(",")
  );
}

export interface Placement {
  type: PieceType;
  rot: Rot;
  x: number;
  y: number;
  cells: Cell[];
  spin: SpinKind;
  linesCleared: number;
  /** board after stamping + clearing */
  after: Board;
  /** move path from spawn (exact enumeration only), e.g. ["left","cw","sd"] */
  path: string[];
}

type Move = "left" | "right" | "sd" | "cw" | "ccw" | "180";
const MOVES: Move[] = ["left", "right", "sd", "cw", "ccw", "180"];

// Node key packing: x in [-3,12], y in [-3,28], rot 0-3, kick class 0-2
// (kick class: 0 = last move not a rotation, 1 = rotation w/ normal kick,
// 2 = rotation w/ the spin-upgrading kick index 4)
function key(x: number, y: number, rot: number, kc: number): number {
  return (((y + 3) * 16 + (x + 3)) * 4 + rot) * 3 + kc;
}

interface Node {
  x: number;
  y: number;
  rot: Rot;
  lastKick: number; // -1 = last move was not a rotation
  parent: Node | null;
  move: Move | null;
}

const SPIN_RANK: Record<SpinKind, number> = { none: 0, mini: 1, full: 2 };

function finishPlacement(
  board: Board,
  type: PieceType,
  rot: Rot,
  x: number,
  y: number,
  spin: SpinKind,
  path: string[],
): Placement {
  const cells = cellsAt(type, rot, x, y);
  const after = board.clone();
  after.place(cells);
  const cleared = after.clearLines();
  return { type, rot, x, y, cells, spin, linesCleared: cleared.length, after, path };
}

export function enumeratePlacements(board: Board, type: PieceType): Placement[] {
  if (collidesFast(board, type, 0, SPAWN_X, SPAWN_Y)) {
    return [];
  }
  const start: Node = { x: SPAWN_X, y: SPAWN_Y, rot: 0, lastKick: -1, parent: null, move: null };

  const kickClass = (k: number) => (k < 0 ? 0 : k === 4 ? 2 : 1);
  const seen = new Set<number>([key(start.x, start.y, start.rot, 0)]);
  const queue: Node[] = [start];
  let qh = 0;
  const results = new Map<string, { node: Node; spin: SpinKind }>();

  while (qh < queue.length) {
    const n = queue[qh++];

    // grounded? -> record a lock candidate
    if (collidesFast(board, type, n.rot, n.x, n.y - 1)) {
      const spin = detectSpin(board, type, n.rot, n.x, n.y, n.lastKick >= 0, n.lastKick);
      // canonical key: same resulting cells for S/Z/I opposite rotations
      const ckey = canonicalKey(type, n.rot, n.x, n.y);
      const prev = results.get(ckey);
      if (!prev || SPIN_RANK[spin] > SPIN_RANK[prev.spin]) {
        results.set(ckey, { node: n, spin });
      }
    }

    for (const move of MOVES) {
      let nx = n.x,
        ny = n.y,
        nrot = n.rot,
        nkick = -1;
      if (move === "left" || move === "right") {
        nx += move === "left" ? -1 : 1;
        if (collidesFast(board, type, nrot, nx, ny)) {
          continue;
        }
      } else if (move === "sd") {
        ny -= 1;
        if (collidesFast(board, type, nrot, nx, ny)) {
          continue;
        }
      } else {
        const dir = move === "cw" ? 1 : move === "ccw" ? -1 : 2;
        const res = tryRotate(board, type, n.rot, n.x, n.y, dir);
        if (!res) {
          continue;
        }
        nx = res.x;
        ny = res.y;
        nrot = res.rot;
        nkick = res.kickIndex;
      }
      const k = key(nx, ny, nrot, kickClass(nkick));
      if (seen.has(k)) {
        continue;
      }
      seen.add(k);
      queue.push({ x: nx, y: ny, rot: nrot, lastKick: nkick, parent: n, move });
    }
  }

  const placements: Placement[] = [];
  for (const { node, spin } of results.values()) {
    const path: string[] = [];
    for (let p: Node | null = node; p && p.move; p = p.parent) {
      path.unshift(p.move);
    }
    placements.push(finishPlacement(board, type, node.rot, node.x, node.y, spin, path));
  }
  return placements;
}

/** Cell-set-canonical key: S/Z/I rot 2/3 produce the same cells as 0/1 shifted. */
function canonicalKey(type: PieceType, rot: Rot, x: number, y: number): string {
  const s = shape(type, rot);
  // identify by absolute bounding box origin + a per-cellset shape id
  const shapeId = type === "O" ? 0 : type === "I" || type === "S" || type === "Z" ? rot % 2 : rot;
  return `${shapeId}:${x + s.minDx},${y + s.minDy}`;
}

/** Fast approximate enumeration for lookahead: hard drops + T-slot spins. */
export function enumerateFast(board: Board, type: PieceType): Placement[] {
  const rots: Rot[] =
    type === "O" ? [0] : type === "I" || type === "S" || type === "Z" ? [0, 1] : [0, 1, 2, 3];
  const out: Placement[] = [];
  for (const rot of rots) {
    const s = shape(type, rot);
    for (let x = -s.minDx; x < BOARD_W - s.maxDx; x++) {
      const y = dropY(board, type, rot, x);
      out.push(finishPlacement(board, type, rot as Rot, x, y, "none", []));
    }
  }
  if (type === "T") {
    // add T-spin placements: T rot2 fits under a roof and >= 3 corners filled
    const maxY = Math.min(board.maxHeight() + 1, 22);
    for (let y = 0; y <= maxY; y++) {
      for (let x = 1; x < BOARD_W - 1; x++) {
        if (collidesFast(board, "T", 2, x, y)) {
          continue;
        }
        // must be grounded with a roof to spin under
        if (!collidesFast(board, "T", 2, x, y - 1)) {
          continue;
        }
        if (!board.filled(x - 1, y + 1) && !board.filled(x + 1, y + 1)) {
          continue;
        }
        const spin = detectSpin(board, "T", 2, x, y, true, 0);
        if (spin === "none") {
          continue;
        }
        // straight drop would land above; only add if this is a genuine tuck
        if (dropY(board, "T", 2, x) !== y) {
          out.push(finishPlacement(board, "T", 2, x, y, spin, []));
        }
      }
    }
  }
  return out;
}
