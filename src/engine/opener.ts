// TKI opener book-matching. Each four.lol target shape is an exact piece
// decomposition (every letter is one tetromino), so the drill matches
// placement-by-placement: each locked piece's cells must equal that piece's
// cells in at least one target that also fits every earlier placement.

import { Board } from "../core/board";
import type { PieceType } from "../core/pieces";
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

function sameCells(a: [number, number][], b: [number, number][]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const key = (c: [number, number]) => c[0] * 32 + c[1];
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
