// Beam-search lookahead: given a board and the upcoming queue (+hold),
// find the best achievable score within the preview horizon. Used both to
// rank the user's placement against alternatives ("what could this position
// have become") and to produce principal-variation lines for the paths viewer.

import { Board } from '../core/board';
import type { PieceType } from '../core/pieces';
import { enumerateFast, type Placement } from './enumerate';
import { evaluateBoard, clearReward, findLstSite } from './eval';

// Passing through a loop-dead state costs the line permanently, even if a
// later burn "revives" the loop — otherwise death gets laundered through
// recovery lines and plugging moves rank as if they were fine.
export const LOOP_DEATH_TOLL = -260;

// In LST every T is TSD fuel: a line that spends a T without a full spin
// pays for it (holding the T instead is free and therefore preferred).
export const WASTED_T_TOLL = -180;

// Back-to-back is part of the LST canon: every clear must be a spin (or a
// quad). A plain 1-3 line clear breaks the chain, and like loop death it is
// a permanent toll on the line — burns must never look like a clean fix.
export const B2B_BREAK_TOLL = -300;

/** A clear that would break back-to-back: lines without a spin, not a quad. */
export function breaksB2b(linesCleared: number, spin: string): boolean {
  return linesCleared > 0 && linesCleared < 4 && spin === 'none';
}

export interface SearchLine {
  score: number;              // accumulated rewards + final board eval
  placements: Placement[];    // principal variation
}

interface BeamNode {
  board: Board;
  hold: PieceType | null;
  canHold: boolean;
  qi: number;                 // index into queue
  reward: number;             // accumulated clear rewards
  line: Placement[];
}

export interface SearchOptions {
  depth: number;      // how many pieces deep to look
  beamWidth: number;
  lstBias?: boolean;  // bias evaluation toward the canonical LST structure
}

export const DEFAULT_SEARCH: SearchOptions = { depth: 4, beamWidth: 14 };

/**
 * Best line from `board` using queue[qi...] with optional hold.
 * Queue must contain at least `depth` pieces from qi.
 */
export function searchBestLine(
  board: Board,
  queue: PieceType[],
  qi: number,
  hold: PieceType | null,
  canHold: boolean,
  opts: SearchOptions = DEFAULT_SEARCH,
): SearchLine {
  const bias = opts.lstBias ?? false;
  let beam: BeamNode[] = [{ board, hold, canHold, qi, reward: 0, line: [] }];
  let best: SearchLine = { score: evaluateBoard(board, bias).score, placements: [] };

  for (let d = 0; d < opts.depth; d++) {
    const next: BeamNode[] = [];
    for (const node of beam) {
      if (node.qi >= queue.length) continue;
      const options: { piece: PieceType; usesHold: boolean; nextHold: PieceType | null; nextQi: number }[] = [];
      const cur = queue[node.qi];
      options.push({ piece: cur, usesHold: false, nextHold: node.hold, nextQi: node.qi + 1 });
      if (node.canHold) {
        if (node.hold) {
          options.push({ piece: node.hold, usesHold: true, nextHold: cur, nextQi: node.qi + 1 });
        } else if (node.qi + 1 < queue.length) {
          options.push({ piece: queue[node.qi + 1], usesHold: true, nextHold: cur, nextQi: node.qi + 2 });
        }
      }
      for (const opt of options) {
        for (const p of enumerateFast(node.board, opt.piece)) {
          let reward = node.reward + clearReward({ linesCleared: p.linesCleared, spin: p.spin }, p.type);
          if (bias && !findLstSite(p.after)) reward += LOOP_DEATH_TOLL;
          if (bias && p.type === 'T' && p.spin !== 'full') reward += WASTED_T_TOLL;
          if (bias && breaksB2b(p.linesCleared, p.spin)) reward += B2B_BREAK_TOLL;
          next.push({
            board: p.after,
            hold: opt.nextHold,
            canHold: true,
            qi: opt.nextQi,
            reward,
            line: [...node.line, p],
          });
        }
      }
    }
    if (next.length === 0) break;
    // score & prune
    const scored = next
      .map((n) => ({ n, s: n.reward + evaluateBoard(n.board, bias).score }))
      .sort((a, b) => b.s - a.s);
    if (scored[0].s > best.score) {
      best = { score: scored[0].s, placements: scored[0].n.line };
    }
    beam = scored.slice(0, opts.beamWidth).map((x) => x.n);
  }
  return best;
}
