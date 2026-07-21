// LST cover-book matching (swng flat-top LST data, see tools/gen-lst-cover.ts).
//
// Each book solution is a start field plus an exact tetromino decomposition of
// the finished build. A solution is "consistent" with the current board when
// the board is exactly the start field plus a subset of whole placements -
// matching is by cells, so it works mid-build and in any placement order.
// Queue viability is decided at runtime with the engine's own reachability
// (enumeratePlacements) and real hold rules, instead of shipping sfinder's
// 5040-row cover tables: this stays faithful to the trainer's SRS+ kicks and
// correctly handles a piece the player is already holding.
//
// Both orientations are loaded: the raw data and its mirror (x -> 9-x,
// L<->J, S<->Z), because four.lol builds the loop on the left while parts of
// the swng data are right-handed.

import { Board, BOARD_H, BOARD_W } from "../core/board";
import type { PieceType } from "../core/pieces";
import { enumeratePlacements, placementKey } from "./enumerate";
import coverData from "../data/lst-cover.json";

interface RawPlacement {
  piece: string;
  cells: [number, number][];
  clears: number;
}

interface BookPlacement {
  piece: PieceType;
  cells: [number, number][];
  /** bitmask per row, aligned with Board.rows */
  masks: Map<number, number>;
  /** completes rows when placed (the stage-ending TSD): must be placed last */
  finisher: boolean;
  key: string;
}

interface BookSolution {
  group: string;
  name: string;
  start: Uint32Array; // row masks
  startHeight: number;
  cellCount: number; // start field cells
  placements: BookPlacement[];
}

export interface BookMove {
  piece: PieceType;
  cells: [number, number][];
  usesHold: boolean;
  solution: string;
}

export interface BookAdvice {
  /** the board is a book build in progress (start field + whole pieces) */
  onBook: boolean;
  /** some consistent solution is completable with the visible queue + hold */
  sustainable: boolean;
  /** placements (this piece or via hold) that keep a completable build */
  moves: BookMove[];
  /** parking the active piece in hold keeps a completable build */
  holdIsBook: boolean;
  /** names of consistent solutions, sustainable ones first */
  solutions: string[];
}

export const OFF_BOOK: BookAdvice = {
  onBook: false,
  sustainable: false,
  moves: [],
  holdIsBook: false,
  solutions: [],
};

const MIRROR_PIECE: Record<string, PieceType> = {
  I: "I",
  O: "O",
  T: "T",
  S: "Z",
  Z: "S",
  J: "L",
  L: "J",
};

function toPlacement(piece: PieceType, cells: [number, number][], clears: number): BookPlacement {
  const masks = new Map<number, number>();
  for (const [x, y] of cells) {
    masks.set(y, (masks.get(y) ?? 0) | (1 << x));
  }
  return { piece, cells, masks, finisher: clears > 0, key: placementKey(piece, cells) };
}

function loadSolutions(): BookSolution[] {
  const out: BookSolution[] = [];
  for (const group of coverData.groups) {
    // start rows are top-down strings; convert to bottom-up masks
    const start = new Uint32Array(BOARD_H);
    let cellCount = 0;
    const h = group.start.length;
    for (let i = 0; i < h; i++) {
      const y = h - 1 - i;
      for (let x = 0; x < Math.min(BOARD_W, group.start[i].length); x++) {
        if (group.start[i][x] === "X") {
          start[y] |= 1 << x;
          cellCount++;
        }
      }
    }
    const mirrorStart = new Uint32Array(BOARD_H);
    for (let y = 0; y < BOARD_H; y++) {
      for (let x = 0; x < BOARD_W; x++) {
        if ((start[y] >>> x) & 1) {
          mirrorStart[y] |= 1 << (BOARD_W - 1 - x);
        }
      }
    }
    for (const sol of group.solutions) {
      const raw = sol.placements as RawPlacement[];
      out.push({
        group: group.name,
        name: sol.name,
        start,
        startHeight: h,
        cellCount,
        placements: raw.map((p) => toPlacement(p.piece as PieceType, p.cells, p.clears)),
      });
      out.push({
        group: group.name,
        name: `${sol.name} (mirrored)`,
        start: mirrorStart,
        startHeight: h,
        cellCount,
        placements: raw.map((p) =>
          toPlacement(
            MIRROR_PIECE[p.piece],
            p.cells.map(([x, y]) => [BOARD_W - 1 - x, y] as [number, number]),
            p.clears,
          ),
        ),
      });
    }
  }
  return out;
}

let SOLUTIONS: BookSolution[] | null = null;
function solutions(): BookSolution[] {
  return (SOLUTIONS ??= loadSolutions());
}

/**
 * Board = (start + subset of whole placements) shifted up by `dy` rows? Returns
 * the unplaced rest, already shifted into board coordinates. `dy` lets a
 * low-row pattern match the same shape higher up a rising LST loop
 * (height-invariant matching): everything below the shifted start must be
 * empty, and every board cell at/above it must belong to the pattern.
 */
function matchSolutionAt(sol: BookSolution, board: Board, dy: number): BookPlacement[] | null {
  let extraCells = 0;
  for (let y = 0; y < BOARD_H; y++) {
    const row = board.rows[y];
    const startRow = y - dy >= 0 ? sol.start[y - dy] : 0;
    // a missing start cell means this is not that solution's build
    if ((row & startRow) !== startRow) {
      return null;
    }
    // cells below the shifted pattern base can't be part of this build
    if (y < dy && row !== 0) {
      return null;
    }
    let extra = row & ~startRow;
    while (extra) {
      extraCells += extra & 1;
      extra >>>= 1;
    }
  }
  const remaining: BookPlacement[] = [];
  let placedCells = 0;
  for (const p of sol.placements) {
    let present = 0;
    let inRange = true;
    for (const [y] of p.masks) {
      if (y + dy >= BOARD_H) {
        inRange = false;
        break;
      }
    }
    if (!inRange) {
      return null;
    }
    for (const [y, mask] of p.masks) {
      if ((board.rows[y + dy] & mask) === mask) {
        present++;
      }
    }
    if (present === p.masks.size && !p.finisher) {
      placedCells += p.cells.length;
    } else {
      // shift the placement's cells/masks into board coordinates
      remaining.push(dy === 0 ? p : shiftPlacement(p, dy));
    }
  }
  // every extra cell must be accounted for by whole placements; overlapping
  // pieces would double-count, which this equality also rejects
  if (placedCells !== extraCells) {
    return null;
  }
  return remaining;
}

function shiftPlacement(p: BookPlacement, dy: number): BookPlacement {
  const cells = p.cells.map(([x, y]) => [x, y + dy] as [number, number]);
  const masks = new Map<number, number>();
  for (const [y, mask] of p.masks) {
    masks.set(y + dy, mask);
  }
  return { piece: p.piece, cells, masks, finisher: p.finisher, key: placementKey(p.piece, cells) };
}

/**
 * Try to match `sol` against `board` at any vertical offset, lowest first.
 * Returns the remaining placements (in board coordinates) and the offset used.
 */
function matchSolution(
  sol: BookSolution,
  board: Board,
): { remaining: BookPlacement[]; dy: number } | null {
  const maxDy = Math.max(0, board.maxHeight() - 1);
  for (let dy = 0; dy <= maxDy; dy++) {
    const remaining = matchSolutionAt(sol, board, dy);
    if (remaining !== null) {
      return { remaining, dy };
    }
  }
  return null;
}

const HOLD_SLOTS: (PieceType | null)[] = [null, "I", "O", "T", "S", "Z", "J", "L"];

/**
 * Can `remaining` be completed from `board` given the visible queue and hold?
 * Standard hold rules; a piece with no remaining placement (the loop's T
 * before its slot is in the book, or next-bag pieces) can be parked in hold.
 * Running out of visible queue counts as completable (optimistic horizon).
 * Collects the root actions that lead to a completable line.
 */
function searchSolution(
  board: Board,
  remaining: BookPlacement[],
  queue: PieceType[],
  hold: PieceType | null,
  sol: BookSolution,
  rootMoves: Map<string, BookMove>,
  rootHold: { ok: boolean },
  reachCache: Map<string, Set<string>>,
): boolean {
  const memo = new Map<number, boolean>();

  const reachable = (b: Board, piece: PieceType): Set<string> => {
    const k = b.key() + "|" + piece;
    let set = reachCache.get(k);
    if (!set) {
      set = new Set(enumeratePlacements(b, piece).map((p) => placementKey(p.type, p.cells)));
      reachCache.set(k, set);
    }
    return set;
  };

  const dfs = (b: Board, rem: number, qi: number, h: PieceType | null, depth: number): boolean => {
    if (rem === 0) {
      return true;
    }
    if (qi >= queue.length) {
      return true;
    }
    const memoKey = (rem * 8 + HOLD_SLOTS.indexOf(h)) * 8 + qi;
    const hit = memo.get(memoKey);
    if (hit !== undefined && depth > 0) {
      return hit;
    }

    let ok = false;
    const bits: number[] = [];
    for (let i = 0; i < remaining.length; i++) {
      if ((rem >>> i) & 1) {
        bits.push(i);
      }
    }
    const lastOnly = bits.length === 1;

    const tryPlace = (piece: PieceType, usesHold: boolean, nextHold: PieceType | null) => {
      const reach = reachable(b, piece);
      for (const i of bits) {
        const p = remaining[i];
        if (p.piece !== piece) {
          continue;
        }
        // a finisher's clears would shift the remaining placements
        if (p.finisher && !lastOnly) {
          continue;
        }
        if (!reach.has(p.key)) {
          continue;
        }
        const nb = b.clone();
        nb.place(p.cells);
        nb.clearLines();
        if (dfs(nb, rem & ~(1 << i), qi + 1, nextHold, depth + 1)) {
          ok = true;
          if (depth === 0) {
            const existing = rootMoves.get(p.key);
            if (!existing || (existing.usesHold && !usesHold)) {
              rootMoves.set(p.key, {
                piece: p.piece,
                cells: p.cells,
                usesHold,
                solution: `${sol.group}: ${sol.name}`,
              });
            }
          } else {
            // deeper levels only need one witness
            return true;
          }
        }
      }
      return false;
    };

    const active = queue[qi];
    if (tryPlace(active, false, h) && depth > 0) {
      memo.set(memoKey, true);
      return true;
    }
    if (h && h !== active && tryPlace(h, true, active) && depth > 0) {
      memo.set(memoKey, true);
      return true;
    }
    // park the active piece in hold (how the loop's T waits for its slot)
    if (h === null && dfs(b, rem, qi + 1, active, depth + 1)) {
      ok = true;
      if (depth === 0) {
        rootHold.ok = true;
      }
    }
    memo.set(memoKey, ok);
    return ok;
  };

  return dfs(board, (1 << remaining.length) - 1, 0, hold, 0);
}

/**
 * Book advice for a decision point. `queue` is [active, ...preview].
 * Cheap when the board is off-book (bitmask rejection per solution).
 */
export function bookAdvice(board: Board, queue: PieceType[], hold: PieceType | null): BookAdvice {
  // a rising LST loop can carry the pattern up near the spawn ceiling; only bail
  // when there's no vertical room left to seat even a low pattern band
  if (board.maxHeight() > BOARD_H - 4) {
    return OFF_BOOK;
  }
  const moves = new Map<string, BookMove>();
  const rootHold = { ok: false };
  const sustained: string[] = [];
  const consistent: string[] = [];
  const reachCache = new Map<string, Set<string>>(); // shared: solutions revisit the same boards
  for (const sol of solutions()) {
    const matched = matchSolution(sol, board);
    if (matched === null) {
      continue;
    }
    const remaining = matched.remaining;
    // build finished; the next stage matches instead
    if (remaining.length === 0) {
      continue;
    }
    const label = `${sol.group}: ${sol.name}`;
    if (searchSolution(board, remaining, queue, hold, sol, moves, rootHold, reachCache)) {
      sustained.push(label);
    } else {
      consistent.push(label);
    }
  }
  if (sustained.length === 0 && consistent.length === 0) {
    return OFF_BOOK;
  }
  return {
    onBook: true,
    sustainable: sustained.length > 0,
    moves: [...moves.values()],
    holdIsBook: rootHold.ok,
    solutions: [...sustained, ...consistent],
  };
}

/** True when the user's placement is one of the advised book moves. */
export function matchesBookMove(
  advice: BookAdvice,
  piece: PieceType,
  cells: readonly (readonly [number, number])[],
): boolean {
  const key = placementKey(piece, cells);
  return advice.moves.some((m) => placementKey(m.piece, m.cells) === key);
}
