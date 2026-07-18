// A hard-constrained LST loop continuation player for the "watch book"
// demo. Where the soft-penalty engine (search.ts tolls) will pick a
// "least-bad" move that quietly wastes a T once the stack drifts, this only
// ever considers *goal-legal* placements — no wasted T, no I spent on a
// clear, no back-to-back break, and the loop kept alive — and searches a
// short horizon for the line that fires the most TSDs while staying lowest.
//
// It cannot make the loop perpetual (that needs perfect-fill / PC solving,
// which the cover book was meant to encode but does not close), so it will
// eventually return null when no legal continuation exists — that is the
// honest "the loop can't continue from here" signal, not a wasted T.

import { Board } from '../core/board';
import type { PieceType } from '../core/pieces';
import type { SpinKind } from '../core/spin';
import { enumeratePlacements, type Placement } from './enumerate';
import { findLstSite, evaluateBoard } from './eval';

export interface LoopMove {
  piece: PieceType;
  cells: [number, number][];
  spin: SpinKind;
  linesCleared: number;
  usesHold: boolean;
}

/** A full T-spin double — the loop's payoff and the only legal use of a T. */
function isTsd(p: Placement): boolean {
  return p.type === 'T' && p.spin === 'full' && p.linesCleared >= 2;
}

/** Goal-legal in the loop phase: keep every T for a TSD, never spend the I on
 * a clear, never break back-to-back, and never kill the loop (the TSD itself
 * is always allowed — it clears back into a fresh site). */
function legal(p: Placement): boolean {
  if (p.type === 'T' && !isTsd(p)) return false;
  if (p.type === 'I' && p.linesCleared > 0) return false;
  if (p.linesCleared > 0 && p.linesCleared < 4 && p.spin === 'none') return false;
  if (!isTsd(p) && !findLstSite(p.after)) return false;
  return true;
}

interface Node {
  board: Board;
  hold: PieceType | null;
  qi: number;
  tsds: number;
  first: Placement | null;
  firstUsesHold: boolean;
}

const DEFAULT_HORIZON = 7;
const DEFAULT_BEAM = 24;

/**
 * Best goal-legal loop continuation from this position, or null when none
 * exists (the loop is genuinely stuck — the caller should park the T or fall
 * back). Objective: fire the most TSDs over the horizon, then stay low and
 * tight (height, buried cells) and keep the next site ready.
 */
export function lstLoopMove(
  board: Board,
  queue: PieceType[],
  hold: PieceType | null,
  horizon = DEFAULT_HORIZON,
  beamWidth = DEFAULT_BEAM,
): LoopMove | null {
  if (queue.length === 0) return null;
  let beam: Node[] = [{ board, hold, qi: 0, tsds: 0, first: null, firstUsesHold: false }];
  let best: { node: Node; score: number } | null = null;

  for (let d = 0; d < horizon; d++) {
    const next: Node[] = [];
    for (const node of beam) {
      if (node.qi >= queue.length) continue;
      const cur = queue[node.qi];
      const opts: { piece: PieceType; usesHold: boolean; nextHold: PieceType | null; nextQi: number }[] = [
        { piece: cur, usesHold: false, nextHold: node.hold, nextQi: node.qi + 1 },
      ];
      if (node.hold && node.hold !== cur) {
        opts.push({ piece: node.hold, usesHold: true, nextHold: cur, nextQi: node.qi + 1 });
      } else if (!node.hold && node.qi + 1 < queue.length) {
        opts.push({ piece: queue[node.qi + 1], usesHold: true, nextHold: cur, nextQi: node.qi + 2 });
      }
      for (const opt of opts) {
        for (const p of enumeratePlacements(node.board, opt.piece)) {
          if (!legal(p)) continue;
          next.push({
            board: p.after,
            hold: opt.nextHold,
            qi: opt.nextQi,
            tsds: node.tsds + (isTsd(p) ? 1 : 0),
            first: node.first ?? p,
            firstUsesHold: node.first ? node.firstUsesHold : opt.usesHold,
          });
        }
      }
    }
    if (next.length === 0) break;
    const scored = next
      .map((n) => ({ n, score: scoreNode(n) }))
      .sort((a, b) => b.score - a.score);
    if (!best || scored[0].score > best.score) best = { node: scored[0].n, score: scored[0].score };
    beam = scored.slice(0, beamWidth).map((x) => x.n);
  }

  if (!best || !best.node.first) return null;
  const p = best.node.first;
  return {
    piece: p.type,
    cells: p.cells.map(([a, b]) => [a, b] as [number, number]),
    spin: p.spin,
    linesCleared: p.linesCleared,
    usesHold: best.node.firstUsesHold,
  };
}

/** TSDs dominate; then keep the stack low and the next site ready. Buried
 * cells and height are the drift the loop must fight. */
function scoreNode(n: Node): number {
  const site = findLstSite(n.board);
  const ev = evaluateBoard(n.board, true).score;
  let cells = 0;
  for (let y = 0; y < n.board.maxHeight(); y++) {
    let r = n.board.rows[y];
    while (r) { cells += r & 1; r >>>= 1; }
  }
  return (
    n.tsds * 100000 +
    ev -
    n.board.maxHeight() * 60 -
    cells * 6 -
    (site ? site.missing * 30 : 5000)
  );
}
