// A hard-constrained LST loop continuation player for the "watch book"
// demo. Where the soft-penalty engine (search.ts tolls) will pick a
// "least-bad" move that quietly wastes a T once the stack drifts, this only
// ever considers *goal-legal* placements - no wasted T, no I spent on a
// clear, no back-to-back break, and the loop kept alive - and searches a
// short horizon for the line that fires the most TSDs while staying lowest.
//
// It cannot make the loop perpetual (that needs perfect-fill / PC solving,
// which the cover book was meant to encode but does not close), so it will
// eventually return null when no legal continuation exists - that is the
// honest "the loop can't continue from here" signal, not a wasted T.

import { Board, BOARD_W } from "../core/board";
import type { PieceType } from "../core/pieces";
import type { SpinKind } from "../core/spin";
import { enumeratePlacements, placementKey, type Placement } from "./enumerate";
import {
  findLstSite,
  evaluateBoard,
  oFlanksWell,
  isLstState,
  volumeGap,
  lstHoles,
  quadWellDepth,
  stackSideImbalance,
  LST_SPIN_COL,
} from "./eval";
import { O_NOTCH_TOLL } from "./search";
import { bookAdvice } from "./book";

export interface LoopMove {
  piece: PieceType;
  cells: [number, number][];
  spin: SpinKind;
  linesCleared: number;
  usesHold: boolean;
}

/** A full T-spin double - the loop's payoff and the only legal use of a T. */
function isTsd(p: Placement): boolean {
  return p.type === "T" && p.spin === "full" && p.linesCleared >= 2;
}

/** A tetris (quad) - real LST's volume drain: TSDs net +8 cells/bag and would
 * top out ~20, but a quad clears 40 cells, so periodic quads balance volume and
 * let the loop run indefinitely (swng: "a well in which you do quads"). */
function isQuad(p: Placement): boolean {
  return p.linesCleared === 4;
}

/** Fill has out-grown the well by this many rows -> a double-up is due (swng:
 * "at or after 6.66 TSD"); the loop must be allowed to build a taller overhang
 * that momentarily has no ready col-2 site. */
const DOUBLEUP_VOL = 2;

/** Goal-legal in the loop phase: keep every T for a TSD, never spend the I on
 * a clear, never break back-to-back, and never kill the loop (the TSD itself
 * is always allowed - it clears back into a fresh site).
 *
 * `allowDoubleUp` relaxes the "keep a ready site" rule for the volume-escape
 * maneuver: while stacking a double-up the notch is being rebuilt higher, so
 * intermediate boards legitimately have no immediate findLstSite - they are
 * still legal as long as the board stays a valid LST shape (isLstState:
 * unobstructed well + alternating overhang parity). Without this the player is
 * structurally unable to double-up and dies overstacking the well. */
function legal(p: Placement, allowDoubleUp: boolean, allowQuad: boolean): boolean {
  if (p.type === "T" && !isTsd(p)) {
    return false;
  }
  // Left-wall rule: a Z touching the outer-left wall (cols 0-1) is the general-
  // 2-7 leak (a Z capping the left O instead of the L) - never part of the LST
  // left build. Mirrors the solver's hard prune (SolveOptions.leftOCapHorizon)
  // so the reactive fallback keeps the left wall clean too.
  if (p.type === "Z" && Math.min(...p.cells.map(([x]) => x)) <= 1) {
    return false;
  }
  // I may only clear as a full quad (the volume drain); never a 1-3 line waste
  if (p.type === "I" && p.linesCleared > 0 && !(allowQuad && isQuad(p))) {
    return false;
  }
  if (p.linesCleared > 0 && p.linesCleared < 4 && p.spin === "none") {
    return false;
  }
  // the TSD and (when allowed) the quad are loop clears that reset into a fresh
  // site; every other move must leave a ready site (or be a legal double-up).
  const isLoopClear = isTsd(p) || (allowQuad && isQuad(p));
  if (!isLoopClear && !findLstSite(p.after)) {
    return allowDoubleUp && isLstState(p.after);
  }
  return true;
}

interface Node {
  board: Board;
  hold: PieceType | null;
  qi: number;
  tsds: number;
  quads: number;
  first: Placement | null;
  firstUsesHold: boolean;
  firstBook: boolean; // the committed first move is a cover-book move
  penalty: number; // accumulated placement tolls (O-in-notch)
}

const DEFAULT_HORIZON = 7;
const DEFAULT_BEAM = 24;
/** How many previews the book is allowed to see (real drill shows PREVIEW_N). */
const BOOK_PREVIEW = 6;

/**
 * Best goal-legal loop continuation from this position, or null when none
 * exists (the loop is genuinely stuck - the caller should park the T or fall
 * back). Objective: fire the most TSDs over the horizon, then stay low and
 * tight (height, buried cells) and keep the next site ready.
 */
export function lstLoopMove(
  board: Board,
  queue: PieceType[],
  hold: PieceType | null,
  horizon = DEFAULT_HORIZON,
  beamWidth = DEFAULT_BEAM,
  useBook = false,
  allowQuad = false,
  ruleMode = false,
): LoopMove | null {
  if (queue.length === 0) {
    return null;
  }
  // Pattern recognition: if the board is a cover-book build with a sustainable
  // continuation, put the loop on rails - the root move must be a book move (or
  // the finishing TSD). This is what a human loop player does: they don't
  // re-derive every ply, they follow a known repeating pattern.
  let bookKeys: Set<string> | null = null;
  if (useBook) {
    const adv = bookAdvice(board, queue.slice(0, BOOK_PREVIEW), hold);
    if (adv.onBook && adv.sustainable && adv.moves.length > 0) {
      bookKeys = new Set(adv.moves.map((m) => placementKey(m.piece, m.cells)));
    }
  }
  let beam: Node[] = [
    {
      board,
      hold,
      qi: 0,
      tsds: 0,
      quads: 0,
      first: null,
      firstUsesHold: false,
      firstBook: false,
      penalty: 0,
    },
  ];
  let best: { node: Node; score: number } | null = null;
  let bestKey: number[] | null = null;

  for (let d = 0; d < horizon; d++) {
    const next: Node[] = [];
    for (const node of beam) {
      if (node.qi >= queue.length) {
        continue;
      }
      // volume trigger: is a double-up due from this node's board?
      const curSite = findLstSite(node.board);
      const allowDoubleUp = curSite ? volumeGap(node.board, curSite.y) >= DOUBLEUP_VOL : false;
      // hard no-new-holes: a clean LST build never buries a cell on the wall or
      // fill side. Enforced as "<= current" (not "== 0") so a pre-existing hole
      // carried in from the opener doesn't deadlock every continuation.
      const curHoles = lstHoles(node.board);
      const cur = queue[node.qi];
      const opts: {
        piece: PieceType;
        usesHold: boolean;
        nextHold: PieceType | null;
        nextQi: number;
      }[] = [{ piece: cur, usesHold: false, nextHold: node.hold, nextQi: node.qi + 1 }];
      if (node.hold && node.hold !== cur) {
        opts.push({ piece: node.hold, usesHold: true, nextHold: cur, nextQi: node.qi + 1 });
      } else if (!node.hold && node.qi + 1 < queue.length) {
        opts.push({
          piece: queue[node.qi + 1],
          usesHold: true,
          nextHold: cur,
          nextQi: node.qi + 2,
        });
      }
      for (const opt of opts) {
        for (const p of enumeratePlacements(node.board, opt.piece)) {
          // at the root, when a sustainable book line exists, only its moves
          // (or the finishing TSD) may be committed; book moves bypass the
          // "keep a site ready" rule since a mid-build board legitimately has
          // none until the build completes.
          // hard rule: never bury a cell (a loop clear - TSD or quad - may
          // momentarily expose the well below the cleared rows, so it's exempt)
          const loopClear = isTsd(p) || (allowQuad && isQuad(p));
          if (!loopClear && lstHoles(p.after) > curHoles) {
            continue;
          }
          const isBookRoot = d === 0 && bookKeys !== null && bookKeys.has(placementKey(p.type, p.cells));
          if (d === 0 && bookKeys !== null) {
            if (!isBookRoot && !isTsd(p)) {
              continue;
            }
            if (!isBookRoot && !legal(p, allowDoubleUp, allowQuad)) {
              continue;
            }
          } else if (!legal(p, allowDoubleUp, allowQuad)) {
            continue;
          }
          next.push({
            board: p.after,
            hold: opt.nextHold,
            qi: opt.nextQi,
            tsds: node.tsds + (isTsd(p) ? 1 : 0),
            quads: node.quads + (allowQuad && isQuad(p) ? 1 : 0),
            first: node.first ?? p,
            firstUsesHold: node.first ? node.firstUsesHold : opt.usesHold,
            firstBook: node.first ? node.firstBook : isBookRoot,
            penalty:
              node.penalty + (p.type === "O" && oFlanksWell(p.cells) ? O_NOTCH_TOLL : 0),
          });
        }
      }
    }
    if (next.length === 0) {
      break;
    }
    if (ruleMode) {
      const keyed = next.map((n) => ({ n, key: ruleKey(n) }));
      keyed.sort((a, b) => cmpRuleKey(a.key, b.key));
      if (!bestKey || cmpRuleKey(keyed[0].key, bestKey) < 0) {
        best = { node: keyed[0].n, score: 0 };
        bestKey = keyed[0].key;
      }
      beam = keyed.slice(0, beamWidth).map((x) => x.n);
    } else {
      const scored = next
        .map((n) => ({ n, score: scoreNode(n, allowQuad) }))
        .sort((a, b) => b.score - a.score);
      if (!best || scored[0].score > best.score) {
        best = { node: scored[0].n, score: scored[0].score };
      }
      beam = scored.slice(0, beamWidth).map((x) => x.n);
    }
  }

  if (!best || !best.node.first) {
    return null;
  }
  const p = best.node.first;
  return {
    piece: p.type,
    cells: p.cells.map(([a, b]) => [a, b] as [number, number]),
    spin: p.spin,
    linesCleared: p.linesCleared,
    usesHold: best.node.firstUsesHold,
  };
}

/**
 * Fallback opener build for the ~37% of bags planOpener can't set up (and no
 * book line applies). Instead of handing the board to the plain engine - which
 * optimises for generic Tetris and drifts the stack off the LST structure,
 * burying the col-2 well and cutting holes the loop can never continue from -
 * this keeps a clean, low, single-mountain LST base: it never buries a cell,
 * keeps the col-2 well clear, prefers moves that leave a ready TSD site, and
 * takes a genuine TSD the instant one exists. The T is parked (returns null so
 * the caller stashes it) until it can fire. It won't conjure a TSD from every
 * bag, but it degrades gracefully instead of wrecking the shape.
 */
export function lstCleanBuildMove(board: Board, active: PieceType): LoopMove | null {
  // the T is the payoff: fire a ready TSD, otherwise signal "park it" (null)
  if (active === "T") {
    const tsd = enumeratePlacements(board, "T").find(isTsd);
    return tsd
      ? {
          piece: "T",
          cells: tsd.cells.map(([a, b]) => [a, b] as [number, number]),
          spin: tsd.spin,
          linesCleared: tsd.linesCleared,
          usesHold: false,
        }
      : null;
  }
  const bumpiness = (b: Board): number => {
    let prev = -1;
    let sum = 0;
    for (let x = 0; x < BOARD_W; x++) {
      if (x === LST_SPIN_COL) continue; // the well is a designed notch, not drift
      const h = b.columnHeight(x);
      if (prev >= 0) sum += Math.abs(h - prev);
      prev = h;
    }
    return sum;
  };
  const baseHoles = lstHoles(board);
  let best: { score: number; p: Placement } | null = null;
  for (const p of enumeratePlacements(board, active)) {
    if (p.linesCleared > 0) continue; // only the T clears (a TSD) during the build
    if (lstHoles(p.after) > baseHoles) continue; // never bury a cell
    if (p.cells.some(([x]) => x === LST_SPIN_COL)) continue; // keep the col-2 well clear
    if (p.after.maxHeight() > 12) continue; // stay in the opener/low band
    const hasSite = findLstSite(p.after) ? 1 : 0;
    const score = hasSite * 1000 - p.after.maxHeight() * 10 - bumpiness(p.after);
    if (!best || score > best.score) {
      best = { score, p };
    }
  }
  if (!best) {
    return null;
  }
  return {
    piece: active,
    cells: best.p.cells.map(([a, b]) => [a, b] as [number, number]),
    spin: best.p.spin,
    linesCleared: 0,
    usesHold: false,
  };
}

/** Clears (TSDs + quads) dominate; then keep the stack low and the next site
 * ready. Buried cells and height are the drift the loop must fight. When quads
 * are allowed and volume has out-grown the well, building the quad well (toward
 * a 4-deep drain) is rewarded so the beam actually stacks into a tetris instead
 * of fighting the height and topping out - real LST's volume escape. */
/** Overstack (fill above the TSD slot) allowed before the volume rule forces a
 * drain. swng/Kixenon: no-doubleup LST accumulates ~0.7 rows/bag and a doubleup
 * is due ~every 5-6.7 bags, i.e. once the overstack reaches a few rows. */
const OVERSTACK_CAP = 3;

/**
 * HARD rule-follower key (the LST construction policy, not a soft eval),
 * grounded in the theory (Feltheshovel parity, swng/Kixenon volume). LST's
 * valid region is narrow, so trading rules against each other (scoreNode's
 * weighted sum) drifts out of it and can't return - the measured failure of
 * every soft lever. This ranks candidate lines lexicographically; the top slots
 * are GATES that read 0 while satisfied (so they never cause procrastination),
 * and the lower slots optimize within them:
 *   1. clears fired (the payoff)         - most TSDs/quads
 *   2. loop alive                        - a col-2 site still exists
 *   3. clean                             - never bury a cell (lstHoles)
 *   4. parity gate                       - stack-side CI stays good (never ±2);
 *                                          this is "keep the residue even" on
 *                                          the STACK side, the overhang gate
 *   5. volume gate                       - overstack not run away (forces the
 *                                          double-up drain on cadence)
 *   6. progress                          - fewest missing completion cells
 *   7. low + tight                       - height, then total cells
 * Higher is better in every slot (negated where lower is better).
 */
function ruleKey(n: Node): number[] {
  const b = n.board;
  const site = findLstSite(b);
  // A board with no immediate col-2 site but a still-valid LST shape is a
  // legitimate mid-double-up state (the notch is being rebuilt higher) - it is
  // NOT dead and its volume is being actively drained, so we must not prune it.
  const midMove = !site && isLstState(b);
  const alive = site !== null || midMove;
  const overstack = site ? volumeGap(b, site.y) : 0;
  let cells = 0;
  for (let y = 0; y < b.maxHeight(); y++) {
    let r = b.rows[y];
    while (r) {
      cells += r & 1;
      r >>>= 1;
    }
  }
  return [
    n.tsds + n.quads,
    alive ? 1 : 0,
    -lstHoles(b),
    -(site ? site.missing : 4), // COMPLETE the current site first (fire the TSD)
    -Math.max(0, Math.abs(stackSideImbalance(b)) - 1), // parity gate
    -Math.max(0, overstack - OVERSTACK_CAP), // volume gate
    -b.maxHeight(),
    -cells,
  ];
}

/** Lexicographic descending compare (better key sorts first). */
function cmpRuleKey(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return b[i] - a[i];
    }
  }
  return 0;
}

function scoreNode(n: Node, allowQuad: boolean): number {
  const site = findLstSite(n.board);
  const ev = evaluateBoard(n.board, true).score;
  let cells = 0;
  for (let y = 0; y < n.board.maxHeight(); y++) {
    let r = n.board.rows[y];
    while (r) {
      cells += r & 1;
      r >>>= 1;
    }
  }
  let quadReward = 0;
  if (allowQuad) {
    const gap = site ? volumeGap(n.board, site.y) : 99;
    if (gap >= 1) {
      // deepening the well toward a quad is worth more than the height it costs
      quadReward = Math.min(quadWellDepth(n.board), 4) * 90;
    }
  }
  return (
    (n.tsds + n.quads) * 100000 +
    (n.firstBook ? 20000 : 0) +
    quadReward +
    ev +
    n.penalty -
    n.board.maxHeight() * 60 -
    cells * 6 -
    (site ? site.missing * 30 : 5000)
  );
}
