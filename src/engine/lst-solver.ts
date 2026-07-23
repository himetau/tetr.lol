// Perfect-fill LST loop solver: the piece that the greedy loop player and
// Cold Clear could never be (see lst-loop.ts) - instead of picking one move
// per decision with a short preview, it takes the drill's *whole* seeded
// queue and searches, with backtracking across TSD cycles, for a complete
// goal-legal line: every T a full TSD at the well, no other clears, no I
// spent, back-to-back never touched.
//
// The structure rules are the LST canon (Circu1ation / orz / swng / Kixenon
// volume + parity guides) reduced to what the physics doesn't already give
// us for free:
//
//  - the spin column ("well", col 2, or col 7 mirrored) is only ever filled
//    by the T. That single invariant makes the rest self-enforcing: a full
//    T-spin that clears 2 lines is then only *possible* at the well, and a
//    T has no third row of well cells, so a TST can't exist - "every T
//    clear is a well TSD" is physics, not policy.
//  - covered empty cells are allowed only in the notch columns beside the
//    well (cols 1 and 3). A 2-high SZ overhang, a 1-high LJ overhang, and
//    the stacked voids of a double-up are all exactly this; a covered cell
//    anywhere else is a permanent hole the run cannot afford (volume theory:
//    each bag nets +8 cells over the TSD's -20, so 20 TSDs end around row
//    16-17 only under near-perfect fill - a couple of holes tops the run
//    into the spawn ceiling).
//  - after every placement some col-2 TSD site must still be buildable
//    (findLstSite): the guides' "keep the next slot alive" rule.
//
// The even/odd (2121) overhang alternation is not enforced - it is what the
// search *finds*, because with these invariants the only surviving lines
// are the ones the theory describes.

import { Board, BOARD_W } from "../core/board";
import { cellsAt, type PieceType, type Rot } from "../core/pieces";
import type { SpinKind } from "../core/spin";
import { enumeratePlacements, type Placement } from "./enumerate";
import { dropY, shape } from "./masks";
import { findLstSite, LST_SPIN_COL, quadWellDepth, stackSideImbalance } from "./eval";

export interface SolvedMove {
  piece: PieceType;
  cells: [number, number][];
  spin: SpinKind;
  linesCleared: number;
  /** board key (Board.key()) this move expects - playback resyncs on mismatch */
  beforeKey: string;
  isTsd: boolean;
}

export interface SolveResult {
  moves: SolvedMove[];
  /** TSDs the line fires (== target when solved is true) */
  tsds: number;
  solved: boolean;
  mirrored: boolean;
  nodes: number;
}

export interface SolveOptions {
  /** wall-clock budget for the search */
  budgetMs?: number;
  /** search node budget (placements tried) */
  nodeBudget?: number;
  /** candidate placements kept per decision (branching cap) */
  maxBranch?: number;
  /** alternative complete solutions collected per cycle before ranking */
  cycleSolutions?: number;
  /** within-cycle search node cap per collection pass */
  cycleNodeCap?: number;
  /** final cycles searched with widened caps and no discrepancy charge:
   * the endgame is where the volume math leaves near-zero slack, so it
   * gets full search while the loose early cycles stay heuristic */
  tailFree?: number;
  /** log per-pass search progress to the console */
  debug?: boolean;
  /** cap on discrepancy widening (diagnostics) */
  maxDisc?: number;
  /** rows above the site base a placement may reach (overhang band) */
  frontierBand?: number;
  /** allow the well quad (I dropped in the well when its base is >=4 deep) as a
   * cycle clear - real LST's volume drain, which lets `target` exceed the ~20
   * TSD ceiling. Off by default: TSD-only solving is byte-identical. When on,
   * `target` counts total clears (TSDs + quads). */
  allowQuad?: boolean;
  /** S/Z reserve toll (0 = off). Penalizes spending an S/Z as stack-side fill
   * instead of the well-side overhang: the builder alternation needs an S/Z for
   * every 2-high overhang, so burning one on flat fill (or a premature "fractal")
   * forces a stall waiting for the next builder. Soft - a forced S/Z fill still
   * lands, it just loses to reserving the S/Z (playing a non-builder, holding the
   * S/Z) when both are legal. Meant for LIVE bounded-window solves, where cross-
   * window continuability matters more than single-solve depth; left 0 for offline
   * full-queue pool solving (which commits one coherent plan and slightly prefers
   * raw depth). Default 0 keeps behavior byte-identical (Rust parity). */
  szReserve?: number;
  /** When the target can't be reached, return the HEALTHIEST equal-depth
   * partial line instead of the first one found: fewest pieces consumed
   * (more queue left for the next window), then lowest stack-side checker
   * imbalance (Feltheshovel parity). Only which line is *remembered* changes -
   * search order, pruning and node counts are untouched, and solved lines are
   * identical. Meant for LIVE bounded-window solves, where the mistake
   * diagnostician showed committed partial tails are what kill the next
   * window. Default false keeps behavior byte-identical (Rust parity). */
  partialHealth?: boolean;
  /** LST left-side rule (0 = off). The outer-left wall (cols 0-1) is reserved
   * for the OL double-up: an O may only be placed there if an L is coming within
   * the next N upcoming pieces (or is in hold) to cap it. A bare O with no L to
   * cap strands the column and drops the build out of LST into general 2-7
   * stacking - the "no lens fired" planning mistake the diagnostician flagged at
   * solved-window tails. Hard move-gen constraint (removes the placement, so it
   * changes node counts). Default 0 keeps behavior byte-identical (Rust parity). */
  leftOCapHorizon?: number;
}

const DEFAULTS: Required<SolveOptions> = {
  budgetMs: 8000,
  nodeBudget: 4_000_000,
  maxBranch: 12,
  cycleSolutions: 24,
  cycleNodeCap: 5000,
  tailFree: 2,
  debug: false,
  maxDisc: 64,
  frontierBand: 4,
  allowQuad: false,
  szReserve: 0,
  partialHealth: false,
  leftOCapHorizon: 0,
};

// Candidate-ranking weights (the heuristic that orders moves in the LDS). The
// discrepancy the search needs is exponential, so a better ranking = far fewer
// nodes; these are exposed mutably so an offline pass can tune them against
// solve-cost. Defaults are the original hand-tuned values (identical behavior).
export const RANK_WEIGHTS = {
  bump: 3, // surface bumpiness (skips the well seams)
  max: 5, // fill-side height
  notch: 4, // covered notch voids beside the well
  missingHi: 110, // site completion cells still empty, with a T in hand (urgent)
  missingLo: 25, // site completion cells still empty, no T pressure
  missingCyc: 6, // same, in the cycle-solution ranking (surfCostOf)
  misfit: 500, // a next queue piece can't land hole-free here
  canyon: 70, // self-inflicted 1-wide I-dependencies
  roof: 12, // bonus (subtracted) when the slot roof is already in place
  lag: 1500, // fill built past the wall before the O that plugs the 2-gap
};

// Stack rows the search may use. The spawn box sits at rows 18-19; volume
// theory puts the 20th TSD around row 16, so the cap is real headroom, not
// slack - anything above it is a line that was going to top out anyway.
const HEIGHT_CAP = 18;

// A cycle is one TSD per bag (7 pieces), but consecutive T's can sit up to
// two full bags apart (T first in bag k, last in bag k+2 minus the held
// carry) - a branch stacking longer than that without firing is drifting,
// not building, and gets cut.
const MAX_PIECES_PER_CYCLE = 16;

// Notch voids beside the well: a double-up keeps two stacked, a triple-up
// more - but a board hoarding covered cells is building a tower, not a loop.
const MAX_NOTCH_HOLES = 4;

const MIRROR_PIECE: Record<PieceType, PieceType> = {
  I: "I",
  O: "O",
  T: "T",
  S: "Z",
  Z: "S",
  J: "L",
  L: "J",
};

function mirrorBoard(board: Board): Board {
  const out = new Board();
  for (let y = 0; y < board.rows.length; y++) {
    let r = board.rows[y];
    let m = 0;
    for (let x = 0; x < BOARD_W; x++) {
      if ((r >>> x) & 1) {
        m |= 1 << (BOARD_W - 1 - x);
      }
    }
    out.rows[y] = m;
  }
  return out;
}

function isTsd(p: Placement): boolean {
  return p.type === "T" && p.spin === "full" && p.linesCleared >= 2;
}

/** The well quad: an I dropped into the well clearing its (>=4-deep) base. */
function isQuad(p: Placement): boolean {
  return p.type === "I" && p.linesCleared === 4;
}

/** Any cycle-ending clear (a TSD, or - when enabled - a well quad). */
function isClear(p: Placement, allowQuad: boolean): boolean {
  return isTsd(p) || (allowQuad && isQuad(p));
}

/** Covered empty cells outside the notch columns (1 and 3), and inside.
 * Well cells (col 2) are never covered because nothing crosses the well.
 * Placement `after` boards are immutable and shared down the search tree,
 * so the audit is cached per board. */
const auditCache = new WeakMap<Board, { bad: number; notch: number; notchMinY: number }>();

function auditHoles(board: Board): { bad: number; notch: number; notchMinY: number } {
  const hit = auditCache.get(board);
  if (hit) {
    return hit;
  }
  let bad = 0;
  let notch = 0;
  let notchMinY = Infinity;
  const rows = board.rows;
  for (let x = 0; x < BOARD_W; x++) {
    if (x === LST_SPIN_COL) {
      continue;
    }
    const h = board.columnHeight(x);
    for (let y = 0; y < h; y++) {
      if (((rows[y] >>> x) & 1) === 0) {
        if (x === LST_SPIN_COL - 1 || x === LST_SPIN_COL + 1) {
          notch++;
          if (y < notchMinY) {
            notchMinY = y;
          }
        } else {
          bad++;
        }
      }
    }
  }
  const res = { bad, notch, notchMinY };
  auditCache.set(board, res);
  return res;
}

// Soft preference for the flat 1-high L/J lid ("J-L" form) over the 2-high
// S/Z diagonal ("J-Z" form): each notch void stacked beyond the first flat
// lid pays this. It only re-ranks complete, goal-legal lines, so a seed that
// can only reach 20 via a double-up still solves - it just loses to any
// equivalent line that stays flat. See eval.ts WEIGHTS.lstDiagonalOverhang.
const DIAG_OVERHANG_COST = 30;

// Cost for spending an O beside the well (notch col 1 or 3) - see
// search.ts O_NOTCH_TOLL. Soft: re-ranks lines, never blocks a solve.
const O_NOTCH_COST = 60;

/** Is an L available to cap an O on the outer-left wall (the OL double-up) -
 * sitting in hold now, or arriving within the next `horizon` upcoming pieces?
 * Used by the leftOCapHorizon left-side rule. */
function lCapAvailable(
  queue: PieceType[],
  nextQi: number,
  nextHold: PieceType | null,
  horizon: number,
): boolean {
  if (nextHold === "L") {
    return true;
  }
  const end = Math.min(queue.length, nextQi + horizon);
  for (let i = nextQi; i < end; i++) {
    if (queue[i] === "L") {
      return true;
    }
  }
  return false;
}

/** Extra stacked notch voids beside the well at/above the site base - the
 * 2-high S/Z diagonal signature (see eval.ts diagonalOverhangs). Zero for a
 * clean flat-lid build. */
function diagonalOverhangs(board: Board, siteY: number): number {
  let extra = 0;
  for (const c of [LST_SPIN_COL - 1, LST_SPIN_COL + 1]) {
    const h = board.columnHeight(c);
    let covered = 0;
    for (let y = siteY; y < h; y++) {
      if (((board.rows[y] >>> c) & 1) === 0) {
        covered++;
      }
    }
    if (covered > 1) {
      extra += covered - 1;
    }
  }
  return extra;
}

/** Compact exact state key: one char per row (10 bits fit a char code). */
function boardKey(board: Board): string {
  const h = board.maxHeight();
  let s = "";
  for (let y = 0; y < h; y++) {
    s += String.fromCharCode(board.rows[y]);
  }
  return s;
}

/** Surface cost of a board between TSDs. Lower is better. Bumpiness skips
 * the well seam (the well is supposed to be a cliff); a flat, low fill side
 * is the volume-theory ideal that leaves room for the bags still to come,
 * and fewer missing site cells means the next payoff is closer. */
function surfaceCost(board: Board, notchHoles: number): number {
  const h: number[] = [];
  for (let x = 0; x < BOARD_W; x++) {
    h.push(board.columnHeight(x));
  }
  // bumpiness over the FILL side only (cols LST_SPIN_COL+2 .. 9). The structure
  // side (left overhang + well + notches, cols 0..LST_SPIN_COL+1) is SUPPOSED to
  // be uneven - that's the LST shape - so penalizing its height diffs made the
  // ranking prefer flattening the structure over building it. Fill flatness
  // (clean, tuckable) is what bumpiness should reward.
  let bump = 0;
  for (let x = LST_SPIN_COL + 2; x < BOARD_W - 1; x++) {
    bump += Math.abs(h[x] - h[x + 1]);
  }
  let max = 0;
  for (let x = 0; x < BOARD_W; x++) {
    if (x !== LST_SPIN_COL) {
      max = Math.max(max, h[x]);
    }
  }
  const site = findLstSite(board);
  const missing = site ? site.missing : 20;
  const roof = site?.roofReady ? RANK_WEIGHTS.roof : 0;
  const diag = site ? diagonalOverhangs(board, site.y) * DIAG_OVERHANG_COST : 0;
  return (
    bump * RANK_WEIGHTS.bump +
    max * RANK_WEIGHTS.max +
    notchHoles * RANK_WEIGHTS.notch +
    missing * RANK_WEIGHTS.missingLo -
    roof +
    diag
  );
}

interface Candidate {
  /** lazily materialized on expansion; T (TSD) candidates carry it eagerly */
  p: Placement | null;
  piece: PieceType;
  rot: Rot;
  x: number;
  y: number;
  usesHold: boolean;
  nextHold: PieceType | null;
  nextQi: number;
  score: number; // higher first
}

interface Step {
  p: Placement;
  usesHold: boolean;
}

const WELL_BIT = 1 << LST_SPIN_COL;
const SLOT_BITS = 0b111 << (LST_SPIN_COL - 1);

/** findLstSite semantics on (parent rows + a small placement overlay),
 * without materializing the board: scan up for the first row pair where all
 * rows below avoid the well column, the pair fits the base/slot shape, and
 * every still-empty completion cell is open to the sky (column height at or
 * below it). Heights are post-placement. */
function overlaySite(
  rows: Uint32Array,
  ov: Map<number, number>,
  heights: number[],
  maxH: number,
): { y: number; missing: number; roofReady: boolean } | null {
  const row = (y: number) => (rows[y] | (ov.get(y) ?? 0)) >>> 0;
  for (let y = 0; y <= maxH; y++) {
    const r0 = row(y);
    if ((r0 & WELL_BIT) !== 0) {
      return null; // a well cell at/below every remaining candidate base
    }
    const r1 = row(y + 1);
    if ((r1 & SLOT_BITS) !== 0) {
      continue;
    }
    let missing = 0;
    let reachable = true;
    for (let x = 0; x < BOARD_W && reachable; x++) {
      if (x !== LST_SPIN_COL && ((r0 >>> x) & 1) === 0) {
        missing++;
        if (heights[x] > y + 1) {
          reachable = false;
        }
      }
      if (x !== 1 && x !== LST_SPIN_COL && x !== 3 && ((r1 >>> x) & 1) === 0) {
        missing++;
        if (heights[x] > y + 2) {
          reachable = false;
        }
      }
    }
    if (!reachable) {
      continue;
    }
    const r2 = row(y + 2);
    const roofReady = ((r2 >>> 1) & 1) === 1 || ((r2 >>> 3) & 1) === 1;
    return { y, missing, roofReady };
  }
  return null;
}

/**
 * Solve for `target` TSDs from this position in canonical (left-well) space.
 *
 * Limited-discrepancy search over the whole remaining run: pass 0 plays the
 * heuristic's first choice everywhere (the guides' "standard" build), pass
 * D allows deviating from it in at most D decisions. That matches how tight
 * this domain is - the structure rules leave few legal moves, the heuristic
 * ranks them well, and when a line dies 15 cycles later the failure is
 * almost always one early mis-ranked choice, which low-discrepancy passes
 * find without drowning in tail permutations. A transposition memo records
 * the discrepancy budget each dead state failed with, so later passes only
 * re-open states when they arrive with more freedom than before.
 */
function solveCanonical(
  board: Board,
  queue: PieceType[],
  hold: PieceType | null,
  target: number,
  opts: Required<SolveOptions>,
): { moves: Step[]; tsds: number; solved: boolean; nodes: number } {
  const deadline = Date.now() + opts.budgetMs;
  let nodes = 0;
  let aborted = false;
  let deathsLogged = 0;
  // per-state: the largest discrepancy budget that still failed here
  const failedAt = new Map<string, number>();
  let bestLine: Step[] = [];
  let bestTsds = 0;
  // partialHealth: exit quality of bestLine, lower is better. Pieces consumed
  // dominate (x64), stack-side parity breaks ties. Integer-valued so the
  // choice is deterministic under a node budget (the Rust parity contract).
  let bestHealth = 0;
  const healthOf = (qi: number, b: Board) => qi * 64 + Math.abs(stackSideImbalance(b));

  const nh: number[] = new Array(BOARD_W).fill(0); // per-candidate heights scratch
  const ov = new Map<number, number>(); // per-candidate row overlay scratch

  /** Does `piece` have any hole-free hard drop on this height profile?
   * The stacking judgment the guides drill hardest: an S/Z on flat ground
   * always digs a hole, so a surface is only as good as its fit for what
   * the queue sends next. Pure profile math - no board needed. */
  const fitsSomewhere = (hh: number[], frontier: number, piece: PieceType): boolean => {
    const rots: Rot[] =
      piece === "O"
        ? [0]
        : piece === "I" || piece === "S" || piece === "Z"
          ? [0, 1]
          : [0, 1, 2, 3];
    for (const rot of rots) {
      const s = shape(piece, rot);
      let maxDy = 0;
      for (const sp of s.spans) {
        if (sp.dy > maxDy) {
          maxDy = sp.dy;
        }
      }
      for (let x = -s.minDx; x < BOARD_W - s.maxDx; x++) {
        if (x + s.minDx <= LST_SPIN_COL && x + s.maxDx >= LST_SPIN_COL) {
          continue;
        }
        let y = 0;
        for (const bp of s.bottom) {
          const rest = hh[x + bp.dx] - bp.dy;
          if (rest > y) {
            y = rest;
          }
        }
        if (y + maxDy > frontier + opts.frontierBand || y + maxDy >= HEIGHT_CAP) {
          continue;
        }
        let ok = true;
        for (const bp of s.bottom) {
          const col = x + bp.dx;
          if (
            y + bp.dy > hh[col] &&
            col !== LST_SPIN_COL - 1 &&
            col !== LST_SPIN_COL + 1
          ) {
            ok = false;
            break;
          }
        }
        if (ok) {
          return true;
        }
      }
    }
    return false;
  };

  /** Structure-legal candidates for one piece-in-hand option.
   * `siteMissing` is the current site's unfilled completion-cell count: a
   * TSD is physically impossible until it is 0, so the (expensive) exact T
   * enumeration only runs then - the T's other role, waiting in hold, is
   * handled by the option layer, not here.
   *
   * Non-T candidates are scored without materializing a board: a hard drop
   * with no clear only changes the touched columns, so hole deltas come
   * from the piece's bottom profile vs the column heights, and the site
   * re-check runs on a 4-row overlay. The board clone happens lazily, only
   * when the search actually expands the candidate. */
  const candidates = (
    b: Board,
    heights: number[],
    audit0: { bad: number; notch: number; notchMinY: number },
    piece: PieceType,
    usesHold: boolean,
    nextHold: PieceType | null,
    nextQi: number,
    frontier: number,
    siteMissing: number,
    tPressure: boolean,
  ): Candidate[] => {
    const out: Candidate[] = [];
    if (piece === "T") {
      if (siteMissing !== 0) {
        return out;
      }
      for (const p of enumeratePlacements(b, "T")) {
        if (!isTsd(p)) {
          continue;
        }
        const audit = auditHoles(p.after);
        if (audit.bad > audit0.bad) {
          continue;
        }
        // a notch void left below the next site after the clear is garbage
        // no future TSD can ever sweep - the leak that kills the volume math
        const nextSite = findLstSite(p.after);
        if (nextSite && audit.notchMinY < nextSite.y) {
          continue;
        }
        out.push({
          p,
          piece,
          rot: p.rot,
          x: p.x,
          y: p.y,
          usesHold,
          nextHold,
          nextQi,
          score: 1e6 - surfaceCost(p.after, audit.notch),
        });
      }
      return out;
    }
    // the well quad: an I into the well whose base is >=4 deep clears four
    // rows (real LST's volume drain). A cycle terminal like the TSD, so it is
    // scored the same way; the structure above the base survives and drops.
    if (opts.allowQuad && piece === "I" && quadWellDepth(b) >= 4) {
      for (const p of enumeratePlacements(b, "I")) {
        if (!isQuad(p) || !findLstSite(p.after)) {
          continue;
        }
        const audit = auditHoles(p.after);
        if (audit.bad > audit0.bad) {
          continue;
        }
        out.push({
          p,
          piece,
          rot: p.rot,
          x: p.x,
          y: p.y,
          usesHold,
          nextHold,
          nextQi,
          score: 1e6 - surfaceCost(p.after, audit.notch),
        });
      }
    }
    // straight hard drops per (rot, x): board physics guarantees a piece
    // that avoids the well can never complete a row, so no clear check
    const rots: Rot[] =
      piece === "O"
        ? [0]
        : piece === "I" || piece === "S" || piece === "Z"
          ? [0, 1]
          : [0, 1, 2, 3];
    for (const rot of rots) {
      const s = shape(piece, rot);
      for (let x = -s.minDx; x < BOARD_W - s.maxDx; x++) {
        if (x + s.minDx <= LST_SPIN_COL && x + s.maxDx >= LST_SPIN_COL) {
          continue; // nothing but the T ever touches the well
        }
        // LST left-side rule: the outer-left wall (cols 0-1) is reserved for the
        // LST vocabulary (L, S, I, J, and the OL double-up). Two rejects:
        //  - a Z touching cols 0-1 is the general-2-7 leak (a Z capping the left
        //    O instead of the L) - never part of the left build;
        //  - a bare O at cols 0-1 is only allowed if an L is coming to cap it
        //    (in hold, or within leftOCapHorizon upcoming pieces), else it strands.
        // (T never reaches this loop - it is only ever the well TSD.) See SolveOptions.
        if (opts.leftOCapHorizon > 0) {
          const leftmost = x + s.minDx;
          if (piece === "Z" && leftmost <= 1) {
            continue;
          }
          if (
            piece === "O" &&
            leftmost === 0 &&
            !lCapAvailable(queue, nextQi, nextHold, opts.leftOCapHorizon)
          ) {
            continue;
          }
        }
        const y = dropY(b, piece, rot, x);
        // frontier discipline: build at the site, not above it - the loop
        // fills its two payoff rows plus the overhang band (a double-up's
        // roof at most 4 above the base), never a tower ahead of the clear
        const top = y + s.spans.reduce((m, sp) => Math.max(m, sp.dy), 0);
        if (top > frontier + opts.frontierBand || top >= HEIGHT_CAP) {
          continue;
        }
        // hole deltas from the bottom profile: new voids appear between the
        // old column top and the piece's lowest cell in that column
        let notch = audit0.notch;
        let notchMinY = audit0.notchMinY;
        let bad = false;
        for (const bp of s.bottom) {
          const col = x + bp.dx;
          const voids = y + bp.dy - heights[col];
          if (voids > 0) {
            if (col === LST_SPIN_COL - 1 || col === LST_SPIN_COL + 1) {
              notch += voids;
              if (heights[col] < notchMinY) {
                notchMinY = heights[col];
              }
            } else {
              bad = true; // a covered cell outside the notch: permanent hole
              break;
            }
          }
        }
        if (bad || notch > MAX_NOTCH_HOLES) {
          continue;
        }
        // post-placement heights and row overlay
        let maxH = 0;
        for (let i = 0; i < BOARD_W; i++) {
          nh[i] = heights[i];
          if (heights[i] > maxH) {
            maxH = heights[i];
          }
        }
        ov.clear();
        for (const sp of s.spans) {
          const ry = y + sp.dy;
          ov.set(ry, (ov.get(ry) ?? 0) | (sp.bits << (x + sp.minDx)));
          const t = ry + 1;
          for (let cx = x + sp.minDx; cx <= x + sp.maxDx; cx++) {
            if (((sp.bits >>> (cx - x - sp.minDx)) & 1) === 1 && t > nh[cx]) {
              nh[cx] = t;
              if (t > maxH) {
                maxH = t;
              }
            }
          }
        }
        const site = overlaySite(b.rows, ov, nh, maxH);
        if (!site) {
          continue; // the next TSD must stay buildable
        }
        // notch voids are only legal at the live site (the slot being
        // roofed, or a double-up's second void right above it); one below
        // the site's base is a hole no future TSD can ever sweep
        if (notchMinY < site.y) {
          continue;
        }
        // surface cost, inline (bumpiness = fill side only, cols LST_SPIN_COL+2+)
        let bump = 0;
        let max = 0;
        for (let i = LST_SPIN_COL + 2; i < BOARD_W - 1; i++) {
          bump += Math.abs(nh[i] - nh[i + 1]);
        }
        for (let i = 0; i < BOARD_W; i++) {
          if (i !== LST_SPIN_COL && nh[i] > max) {
            max = nh[i];
          }
        }
        // forward check: a surface the next pieces can't land on cleanly is
        // a trap, however flat it looks
        let misfit = 0;
        for (let k = 0; k < 3; k++) {
          const np = queue[nextQi + k];
          if (np && np !== "T" && !fitsSomewhere(nh, site.y, np)) {
            misfit++;
          }
        }
        // deep 1-wide canyons outside the well need an I (or worse); the
        // guides call these self-inflicted I-dependencies
        let canyons = 0;
        for (let i = 0; i < BOARD_W; i++) {
          if (i === LST_SPIN_COL) {
            continue;
          }
          const l = i === 0 || i - 1 === LST_SPIN_COL ? 99 : nh[i - 1];
          const r = i === BOARD_W - 1 || i + 1 === LST_SPIN_COL ? 99 : nh[i + 1];
          const depth = Math.min(l, r) - nh[i];
          if (depth >= 2) {
            canyons += depth - 1;
          }
        }
        // NOTE: a scored bonus for the tutorial's canonical lids (2-high S/Z,
        // 1-high L/J overhangs) was tried here and made solves *worse* -
        // rewarding early roofing derails the fill discipline. The canon is
        // enforced by the hard rules instead (well untouched by non-T,
        // notch-only voids, mirrored solving); the alternation emerges.
        // with a T in hand the site's completion is on a deadline: the next
        // T that arrives with hold already full has nowhere to go
        const missingW = tPressure ? RANK_WEIGHTS.missingHi : RANK_WEIGHTS.missingLo;
        // O spent beside the well (into notch col 1 or 3) rigidly flat-tops
        // the flank - the wrong piece for the spin region; keep it on the
        // fill side. x is the piece's min col, and O can't touch the well,
        // so it flanks iff it sits at cols 0-1 or 3-4.
        const oNotch =
          piece === "O" && (x === LST_SPIN_COL - 2 || x === LST_SPIN_COL + 1)
            ? O_NOTCH_COST
            : 0;
        // S/Z reserve: an S/Z that adds a notch void beside the well IS the
        // 2-high overhang (the builder doing its job); one that adds no notch
        // void is stack-side fill - a burned builder that forces a later stall
        // waiting for the next S/Z. Toll the fill case so the search prefers to
        // reserve the S/Z (play a non-builder, hold the S/Z for the overhang).
        const szFill =
          opts.szReserve && (piece === "S" || piece === "Z") && notch <= audit0.notch
            ? opts.szReserve
            : 0;
        const cost =
          bump * RANK_WEIGHTS.bump +
          max * RANK_WEIGHTS.max +
          notch * RANK_WEIGHTS.notch +
          site.missing * missingW +
          misfit * RANK_WEIGHTS.misfit +
          canyons * RANK_WEIGHTS.canyon +
          oNotch +
          szFill -
          (site.roofReady ? RANK_WEIGHTS.roof : 0);
        out.push({
          p: null,
          piece,
          rot,
          x,
          y,
          usesHold,
          nextHold,
          nextQi,
          score: -cost - (usesHold ? 2 : 0),
        });
      }
    }
    return out;
  };

  /** Surface cost of a materialized board (cycle-solution ranking): same
   * ingredients as candidate scoring, including how well the next queue
   * pieces will land on it. */
  const surfCostOf = (b: Board, qi: number): number => {
    const audit = auditHoles(b);
    const site = findLstSite(b);
    if (!site) {
      return 1e9;
    }
    const hh: number[] = [];
    for (let x = 0; x < BOARD_W; x++) {
      hh.push(b.columnHeight(x));
    }
    let bump = 0;
    let max = 0;
    for (let i = LST_SPIN_COL + 2; i < BOARD_W - 1; i++) {
      bump += Math.abs(hh[i] - hh[i + 1]);
    }
    for (let i = 0; i < BOARD_W; i++) {
      if (i !== LST_SPIN_COL && hh[i] > max) {
        max = hh[i];
      }
    }
    let canyons = 0;
    for (let i = 0; i < BOARD_W; i++) {
      if (i === LST_SPIN_COL) {
        continue;
      }
      const l = i === 0 || i - 1 === LST_SPIN_COL ? 99 : hh[i - 1];
      const r = i === BOARD_W - 1 || i + 1 === LST_SPIN_COL ? 99 : hh[i + 1];
      const depth = Math.min(l, r) - hh[i];
      if (depth >= 2) {
        canyons += depth - 1;
      }
    }
    let misfit = 0;
    for (let k = 0; k < 3; k++) {
      const np = queue[qi + k];
      if (np && np !== "T" && !fitsSomewhere(hh, site.y, np)) {
        misfit++;
      }
    }
    // wall lag: the fill side pre-built past the wall columns leaves a
    // 2-deep wall gap beside the well that only an O (or an early pair)
    // can plug - deadly when the queue doesn't deliver one before the T
    const wallLag = Math.max(0, site.y - Math.min(hh[0], hh[1]));
    let lagCost = wallLag * 180;
    if (wallLag > 0) {
      let oBeforeT = false;
      for (let k = 0; k < queue.length - qi; k++) {
        const np = queue[qi + k];
        if (np === "T") {
          break;
        }
        if (np === "O") {
          oBeforeT = true;
          break;
        }
      }
      if (!oBeforeT) {
        lagCost += RANK_WEIGHTS.lag;
      }
    }
    return (
      bump * RANK_WEIGHTS.bump +
      max * RANK_WEIGHTS.max +
      audit.notch * RANK_WEIGHTS.notch +
      site.missing * RANK_WEIGHTS.missingCyc +
      misfit * RANK_WEIGHTS.misfit +
      canyons * RANK_WEIGHTS.canyon +
      lagCost +
      diagonalOverhangs(b, site.y) * DIAG_OVERHANG_COST
    );
  };

  /** One complete way to play the next cycle: build, then fire the TSD. */
  interface CycleSol {
    steps: Step[];
    board: Board;
    qi: number;
    hold: PieceType | null;
    cost: number;
  }

  /** Bounded within-cycle DFS collecting complete cycle solutions. The
   * cycle - not the piece - is the unit the run search deviates over. */
  const cycleSolutions = (
    b0: Board,
    qi0: number,
    h0: PieceType | null,
    widen: boolean,
    disc: number,
  ): CycleSol[] => {
    // caps grow with the discrepancy budget: a later pass revisiting this
    // cycle deserves a deeper collection, not the same capped set again
    const grow = 1 + disc * 0.5;
    const solCap = Math.ceil(opts.cycleSolutions * (widen ? 4 : 1) * grow);
    const nodeCap = Math.ceil(opts.cycleNodeCap * (widen ? 6 : 1) * grow);
    const sols: CycleSol[] = [];
    const seenAfter = new Set<string>();
    const seenState = new Set<string>(); // transpositions: fill order doesn't matter
    const steps: Step[] = [];
    let cycleNodes = 0;

    const dfs = (b: Board, qi: number, h: PieceType | null, depth: number): void => {
      if (sols.length >= solCap || cycleNodes > nodeCap || aborted) {
        return;
      }
      if (qi >= queue.length || depth > MAX_PIECES_PER_CYCLE) {
        return;
      }
      if ((nodes & 511) === 0 && Date.now() > deadline) {
        aborted = true;
        return;
      }
      if (nodes > opts.nodeBudget) {
        aborted = true;
        return;
      }
      const stateKey = boardKey(b) + "|" + qi + "|" + (h ?? "-");
      if (seenState.has(stateKey)) {
        return;
      }
      seenState.add(stateKey);

      const audit0 = auditHoles(b);
      const site = findLstSite(b);
      const frontier = site ? site.y : 0;
      const missing = site ? site.missing : 99;
      const heights: number[] = [];
      for (let x = 0; x < BOARD_W; x++) {
        heights.push(b.columnHeight(x));
      }
      const cur = queue[qi];
      const tPressure = cur === "T" || h === "T";
      let cands = candidates(
        b, heights, audit0, cur, false, h, qi + 1, frontier, missing, tPressure,
      );
      if (h && h !== cur) {
        cands = cands.concat(
          candidates(b, heights, audit0, h, true, cur, qi + 1, frontier, missing, tPressure),
        );
      } else if (!h && qi + 1 < queue.length && queue[qi + 1] !== cur) {
        cands = cands.concat(
          candidates(b, heights, audit0, queue[qi + 1], true, cur, qi + 2, frontier, missing, tPressure),
        );
      }
      cands.sort((a, c) => c.score - a.score);
      const branchCap = widen ? 32 : opts.maxBranch;
      if (cands.length > branchCap) {
        cands.length = branchCap;
      }
      for (const c of cands) {
        if (sols.length >= solCap || ++cycleNodes > nodeCap || aborted) {
          return;
        }
        nodes++;
        let p = c.p;
        if (!p) {
          const cells = cellsAt(c.piece, c.rot, c.x, c.y);
          const after = b.clone();
          after.place(cells);
          p = {
            type: c.piece, rot: c.rot, x: c.x, y: c.y,
            cells, spin: "none", linesCleared: 0, after, path: [],
          };
          c.p = p;
        }
        steps.push({ p, usesHold: c.usesHold });
        if (isClear(p, opts.allowQuad)) {
          const k = boardKey(p.after) + "|" + c.nextQi + "|" + (c.nextHold ?? "-");
          if (!seenAfter.has(k)) {
            seenAfter.add(k);
            sols.push({
              steps: steps.slice(),
              board: p.after,
              qi: c.nextQi,
              hold: c.nextHold,
              cost: surfCostOf(p.after, c.nextQi),
            });
          }
        } else {
          dfs(p.after, c.nextQi, c.nextHold, depth + 1);
        }
        steps.pop();
      }
    };

    dfs(b0, qi0, h0, 0);
    sols.sort((a, c) => a.cost - c.cost);
    return sols;
  };

  const line: Step[] = [];
  const run = (b: Board, qi: number, h: PieceType | null, tsds: number, disc: number): boolean => {
    if (tsds >= target) {
      return true;
    }
    if (aborted) {
      return false;
    }
    const key = boardKey(b) + "|" + qi + "|" + (h ?? "-");
    const failedDisc = failedAt.get(key);
    if (failedDisc !== undefined && failedDisc >= disc) {
      return false;
    }
    const inTail = target - tsds <= opts.tailFree;
    const sols = cycleSolutions(b, qi, h, inTail, disc);
    if (opts.debug && sols.length === 0 && deathsLogged < 4) {
      deathsLogged++;
      console.log(
        `[lst-solver] dead cycle: qi=${qi} hold=${h ?? "-"} tsds=${tsds}\n` +
          b.toStrings(Math.max(4, b.maxHeight())).join("\n"),
      );
    }
    for (let i = 0; i < sols.length; i++) {
      const cost = inTail || i === 0 ? 0 : 1; // deviating from the best-ranked cycle
      if (cost > disc) {
        break;
      }
      const sol = sols[i];
      line.push(...sol.steps);
      if (tsds + 1 > bestTsds) {
        bestTsds = tsds + 1;
        bestLine = line.slice();
        if (opts.partialHealth) bestHealth = healthOf(sol.qi, sol.board);
      } else if (opts.partialHealth && tsds + 1 === bestTsds) {
        const h = healthOf(sol.qi, sol.board);
        if (h < bestHealth) {
          bestHealth = h;
          bestLine = line.slice();
        }
      }
      if (run(sol.board, sol.qi, sol.hold, tsds + 1, disc - cost)) {
        return true;
      }
      line.length -= sol.steps.length;
      if (aborted) {
        return false;
      }
    }
    if (failedDisc === undefined || disc > failedDisc) {
      failedAt.set(key, disc);
    }
    return false;
  };

  // iterative discrepancy widening; the memo makes each pass incremental
  let solved = false;
  for (let disc = 0; !solved && !aborted && disc <= opts.maxDisc; disc++) {
    const passStart = nodes;
    solved = run(board, 0, hold, 0, disc);
    if (opts.debug) {
      console.log(
        `[lst-solver] disc=${disc} nodes=${nodes} (+${nodes - passStart}) best=${bestTsds}/${target} states=${failedAt.size}`,
      );
    }
  }
  return { moves: solved ? line : bestLine, tsds: solved ? target : bestTsds, solved, nodes };
}

// Persistent solution cache: a solved line for an exact (board, queue, hold,
// target, quad) input is deterministic to reuse, so memoize it. This makes
// repeated solves - re-dealing a seed, retrying, a deviation re-solve landing
// on a shape already seen - instant, and gets "progressively faster" the more
// it runs. Export/import let the caller persist it (a file in Node tools, or a
// store the app carries across sessions). Time-budget variance means a fresh
// solve *might* find a longer line than a cached partial, but a cached line is
// always a valid line for those inputs, which is what reuse needs.
const SOLVE_CACHE = new Map<string, SolveResult>();

function solveCacheKey(
  board: Board,
  queue: PieceType[],
  hold: PieceType | null,
  target: number,
  allowQuad: boolean,
  szReserve: number,
  partialHealth: boolean,
  leftOCapHorizon: number,
): string {
  return `${board.key()}|${queue.join("")}|${hold ?? "-"}|${target}|${allowQuad ? "q" : "t"}|${szReserve}|${partialHealth ? "h" : "-"}|lo${leftOCapHorizon}`;
}

/** Serialize the cache (for persistence across sessions/scans). */
export function exportSolveCache(): string {
  return JSON.stringify(Array.from(SOLVE_CACHE.entries()));
}

/** Merge a previously-exported cache back in. Malformed input is ignored. */
export function importSolveCache(json: string): void {
  try {
    for (const [k, v] of JSON.parse(json) as [string, SolveResult][]) {
      SOLVE_CACHE.set(k, v);
    }
  } catch {
    /* ignore a corrupt cache */
  }
}

export function solveCacheSize(): number {
  return SOLVE_CACHE.size;
}

/** Empty the cache. Required between weight-tuning trials, since RANK_WEIGHTS
 * is not part of the cache key - a stale entry would mask the new ranking. */
export function clearSolveCache(): void {
  SOLVE_CACHE.clear();
}

/**
 * Solve for `target` more TSDs. Detects the loop's handedness (left col-2
 * well, or its mirror) and solves in canonical space; `queue` must be the
 * full lookahead, [active, ...upcoming]. Returns the best line found even
 * when the target wasn't reached (moves may then end short). Results are
 * memoized by exact input (see SOLVE_CACHE) so repeats return instantly.
 */
export function solveLstRun(
  board: Board,
  queue: PieceType[],
  hold: PieceType | null,
  target: number,
  options: SolveOptions = {},
): SolveResult | null {
  const opts = { ...DEFAULTS, ...options };
  const ck = solveCacheKey(board, queue, hold, target, opts.allowQuad, opts.szReserve, opts.partialHealth, opts.leftOCapHorizon);
  const cached = SOLVE_CACHE.get(ck);
  if (cached) {
    return { ...cached, moves: cached.moves };
  }
  let mirrored = false;
  let b = board;
  let q = queue;
  let h = hold;
  if (!findLstSite(board)) {
    const m = mirrorBoard(board);
    if (!findLstSite(m)) {
      return null; // no well on either side - not an LST position
    }
    mirrored = true;
    b = m;
    q = queue.map((p) => MIRROR_PIECE[p]);
    h = hold ? MIRROR_PIECE[hold] : null;
  }

  const res = solveCanonical(b.clone(), q, h, target, opts);
  if (res.moves.length === 0) {
    return { moves: [], tsds: 0, solved: res.solved, mirrored, nodes: res.nodes };
  }

  // replay in real space to stamp per-move expectation keys for playback
  const out: SolvedMove[] = [];
  const scratch = board.clone();
  for (const { p } of res.moves) {
    const cells = mirrored
      ? p.cells.map(([x, y]) => [BOARD_W - 1 - x, y] as [number, number])
      : p.cells.map(([x, y]) => [x, y] as [number, number]);
    out.push({
      piece: mirrored ? MIRROR_PIECE[p.type] : p.type,
      cells,
      spin: p.spin,
      linesCleared: p.linesCleared,
      beforeKey: scratch.key(),
      isTsd: isTsd(p),
    });
    scratch.place(cells);
    scratch.clearLines();
  }
  const result: SolveResult = { moves: out, tsds: res.tsds, solved: res.solved, mirrored, nodes: res.nodes };
  SOLVE_CACHE.set(ck, result);
  return result;
}
