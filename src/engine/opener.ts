// TKI opener book-matching. Each four.lol target shape is an exact piece
// decomposition (every letter is one tetromino), so the drill matches
// placement-by-placement: each locked piece's cells must equal that piece's
// cells in at least one target that also fits every earlier placement.

import { Board } from "../core/board";
import type { PieceType } from "../core/pieces";
import type { SpinKind } from "../core/spin";
import tkiData from "../data/tki.json";
import { enumeratePlacements } from "./enumerate";
import { bookAdvice } from "./book";

export interface OpenerTarget {
  name: string;
  rows: string[];
  /** cells per piece letter, absolute board coords */
  pieces: Partial<Record<PieceType, [number, number][]>>;
}

export interface OpenerPlacement {
  piece: PieceType;
  cells: [number, number][];
}

function parseTarget(name: string, rows: string[]): OpenerTarget {
  const pieces: OpenerTarget["pieces"] = {};
  const h = rows.length;
  for (let i = 0; i < h; i++) {
    const y = h - 1 - i;
    for (let x = 0; x < Math.min(10, rows[i].length); x++) {
      const ch = rows[i][x];
      if ("IOTSZJL".includes(ch)) {
        (pieces[ch as PieceType] ??= []).push([x, y]);
      }
    }
  }
  return { name, rows, pieces };
}

export const TKI_TARGETS: OpenerTarget[] = (tkiData.targets as { name: string; rows: string[] }[])
  .map((t) => parseTarget(t.name, t.rows))
  // only exact decompositions (4 cells per letter) are usable as books
  .filter((t) => Object.values(t.pieces).every((cells) => cells.length === 4));

export const LST_START_ROWS: string[] = tkiData.lstStart;

function sameCells(
  a: readonly (readonly [number, number])[],
  b: readonly (readonly [number, number])[],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const key = (c: readonly [number, number]) => c[0] * 32 + c[1];
  const sa = [...a].map(key).sort((x, y) => x - y);
  const sb = [...b].map(key).sort((x, y) => x - y);
  return sa.every((v, i) => v === sb[i]);
}

export interface OpenerMatch {
  ok: boolean;
  /** targets consistent with every placement so far */
  matching: OpenerTarget[];
}

/** Check the full placement history against the TKI book. */
export function matchOpener(placements: OpenerPlacement[]): OpenerMatch {
  const matching = TKI_TARGETS.filter((t) =>
    placements.every((p) => {
      const want = t.pieces[p.piece];
      return want !== undefined && sameCells(want, p.cells);
    }),
  );
  return { ok: matching.length > 0, matching };
}

export function lstStartBoard(): Board {
  return Board.fromStrings(LST_START_ROWS.map((r) => r.replace(/[A-WYZa-z]/g, "X")));
}

export interface OpenerPlan {
  target: OpenerTarget;
  /** every step places a piece; hold churn is implied by piece order */
  moves: { piece: PieceType; cells: [number, number][]; spin: SpinKind }[];
}

/**
 * Plan a complete TKI opener for this exact queue: pick a target (loop-
 * chaining ones first) and order its pieces so every placement is reachable
 * when made, under real hold rules (play the active piece, swap with hold,
 * or stash the active and play the next). The old move-at-a-time heuristic
 * dead-ends whenever the bag order wants a support piece before the piece
 * in hand (e.g. S before its I foundation) while hold is already full; a
 * 7-piece lookahead never has to guess. The T is the finisher and must fire
 * the TSD (clear 2), which physically forces it last.
 */
export function planOpener(queue: PieceType[]): OpenerPlan | null {
  const targets = [...TKI_TARGETS].sort(
    (a, b) => Number(chainsToLoop(b)) - Number(chainsToLoop(a)),
  );
  for (const target of targets) {
    const letters = Object.keys(target.pieces) as PieceType[];
    if (letters.length < 7 || !target.pieces["T"]) {
      continue; // partial targets leave spare bag pieces with nowhere to go
    }
    const moves: { piece: PieceType; cells: [number, number][]; spin: SpinKind }[] = [];
    const placedMask = { v: 0 };
    const idx = new Map(letters.map((p, i) => [p, i] as const));

    const reachableNow = (
      board: Board,
      piece: PieceType,
    ): { cells: [number, number][]; spin: SpinKind } | null => {
      const want = target.pieces[piece]!;
      const hit = enumeratePlacements(board, piece).find(
        (pl) =>
          sameCells(pl.cells, want) &&
          // the finisher must be a real full-spin double, not a soft drop-in
          (piece !== "T" || (pl.spin === "full" && pl.linesCleared >= 2)),
      );
      return hit
        ? { cells: hit.cells.map(([a, b]) => [a, b] as [number, number]), spin: hit.spin }
        : null;
    };

    const dfs = (board: Board, qi: number, hold: PieceType | null): boolean => {
      if (placedMask.v === (1 << letters.length) - 1) {
        return true;
      }
      if (qi >= queue.length) {
        return false;
      }
      const tryPlace = (piece: PieceType, nextHold: PieceType | null, nextQi: number): boolean => {
        const i = idx.get(piece);
        if (i === undefined || (placedMask.v >>> i) & 1) {
          return false;
        }
        // the T is the TSD payoff: only allowed as the finisher
        if (piece === "T" && placedMask.v !== (((1 << letters.length) - 1) & ~(1 << i))) {
          return false;
        }
        const hit = reachableNow(board, piece);
        if (!hit) {
          return false;
        }
        const after = board.clone();
        after.place(hit.cells);
        after.clearLines();
        placedMask.v |= 1 << i;
        moves.push({ piece, cells: hit.cells, spin: hit.spin });
        if (dfs(after, nextQi, nextHold)) {
          return true;
        }
        moves.pop();
        placedMask.v &= ~(1 << i);
        return false;
      };
      const cur = queue[qi];
      if (tryPlace(cur, hold, qi + 1)) {
        return true;
      }
      if (hold && hold !== cur && tryPlace(hold, cur, qi + 1)) {
        return true;
      }
      if (!hold && qi + 1 < queue.length && tryPlace(queue[qi + 1], cur, qi + 2)) {
        return true;
      }
      // pure park: stash the active piece and move on
      if (!hold && dfs(board, qi + 1, cur)) {
        return true;
      }
      return false;
    };

    if (dfs(new Board(), 0, null)) {
      return { target, moves };
    }
  }
  return null;
}

const chainMemo = new Map<OpenerTarget, boolean>();

/** Does completing this target (and its TSD) land on the LST loop book?
 * Targets that don't still count as valid TKI builds, but the loop grader
 * goes off-book after them - prefer the ones that chain. */
export function chainsToLoop(t: OpenerTarget): boolean {
  const memo = chainMemo.get(t);
  if (memo !== undefined) {
    return memo;
  }
  const b = Board.fromStrings(t.rows.map((r) => r.replace(/[A-Za-z]/g, "X")));
  let ok: boolean;
  if (t.pieces["T"]) {
    // the diagram includes the TSD T pre-clear: complete build, clear rows
    b.clearLines();
    ok = bookAdvice(b, [], null).onBook;
  } else {
    const p = enumeratePlacements(b, "T").find((pl) => pl.spin === "full" && pl.linesCleared >= 2);
    ok = p ? bookAdvice(p.after, [], null).onBook : false;
  }
  chainMemo.set(t, ok);
  return ok;
}
