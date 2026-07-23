// Heuristic board evaluation tuned for LST stacking: keep the stack clean,
// always have (or be building) a T-spin-double slot, never burn lines,
// never bury cells. Returns a score plus a per-feature breakdown used to
// generate human explanations ("this created a hole", "this killed your
// T-slot", ...).

import { Board, BOARD_W, BOARD_H } from "../core/board";
import { cellsAt } from "../core/pieces";
import { detectSpin } from "../core/spin";
import type { SpinKind } from "../core/spin";
import type { Rot } from "../core/pieces";
import { collidesFast } from "./masks";
import { neuralValue } from "./neural";

export interface EvalBreakdown {
  holes: number; // buried empty cells (T-slot cells excluded)
  deepHoles: number; // holes buried under 2+ cells (never book moves)
  tslots: number; // structural full-T-spin slots available
  tsdReady: number; // slots that would clear 2 lines right now
  bumpiness: number;
  maxHeight: number;
  badOverhangs: number; // overhang cells not part of a T-slot
  deepWells: number; // wells of depth >= 3 (I-piece dependencies)
}

export interface EvalResult {
  score: number;
  b: EvalBreakdown;
}

export interface ClearInfo {
  linesCleared: number;
  spin: SpinKind;
}

export const WEIGHTS = {
  hole: -160,
  tslot: 130,
  tsdReady: 60,
  bumpiness: -9,
  heightOver: -14, // per row above soft cap
  heightCap: 10,
  badOverhang: -45,
  deepWell: -35,
  // action rewards (applied to the placement, not the board)
  tsd: 480,
  tss: 60, // fine in free play…
  tssOffPlan: -120, // …but under LST bias a TSS spends the T without the
  // TSD: half the payoff, the whole T - a wasted piece
  tspinMiniClear: -30,
  burn: -80, // per line cleared without a T-spin
  tetris: 120, // I-piece 4-line: fine in free play…
  quadOffPlan: -120, // …but off-plan under LST bias: the goal is TSDs only,
  // and a quad spends the I plus four rows of structure
  // LST-structure bias (four.lol: the spin column is column index 2,
  // left wall on columns 0-1, fill on 3-9)
  lstSlotOnColumn: 90, // extra for a T-slot sitting on the LST column
  // loop viability dominates everything: a dead loop is the worst outcome,
  // progress toward completing the next TSD site is the direction to play
  lstLoopDead: -650,
  lstSiteAlive: 120,
  lstMissingCell: -13, // per unfilled completion cell at the site
  lstRoofReady: 45,
  // Overhang handedness: the loop's roof can be a flat 1-high L/J lid ("J-L"
  // form) or a 2-high S/Z diagonal ("J-Z" form). Both are legal and the
  // canon alternates them, but the flat lid is the more practical build, so
  // the diagonal pays a soft toll per extra stacked notch void. Soft on
  // purpose: when the queue forces the double (no flat continuation) every
  // candidate pays it equally and structure still decides - the loop is
  // never blocked, only nudged toward the L/J shape.
  lstDiagonalOverhang: -40, // per notch void beyond the first flat lid
  // Volume theory (swng / Kixenon): the fill side outgrows the well by ~0.7
  // rows/bag, so a double-up (the 2-high S/Z overhang) is *due on a cadence*
  // to move that volume back - it is scheduled by the stack/well imbalance,
  // not a last resort. So the diagonal toll above only applies while the
  // stack is balanced; once the fill has over-risen above the slot, a
  // double-up is the correct move and is rewarded instead.
  lstDoubleupDue: 55, // per notch void when the stack is over-risen
  // Parity theory (Feltheshovel): checkerboard imbalance (CI, ±1 per filled
  // cell) must stay small - good LST parity keeps |CI| <= 1 and cycles
  // 0,+1,0,-1 with the TSD count; drift to ±2 quietly dooms the loop a few
  // bags later, which a short-horizon player cannot otherwise see.
  lstParity: -55, // per unit of |CI| beyond 1
  // Fill has risen this far above the slot roof -> the well is behind and a
  // double-up should catch it up (volume theory's over-stack trigger).
  lstOverstackThreshold: 2,
  // Direct volume-imbalance penalty: the fill side towering above the well is
  // how the loop dies (the fill buries the slot before a double-up can bring
  // the well up). Penalizing the gap itself forces the player to keep the
  // well level with the fill - i.e. to schedule double-ups early instead of
  // over-stacking into an unrecoverable position.
  lstOverstack: -45, // per row the fill sits above the slot roof
};

/** Find structural T-slots: positions where a T (pointing down) fits as a
 * full T-spin. Returns slot centers. */
export function findTSlots(board: Board): { x: number; y: number; clears2: boolean }[] {
  const out: { x: number; y: number; clears2: boolean }[] = [];
  const maxY = Math.min(board.maxHeight() + 1, 22);
  for (let y = 0; y <= maxY; y++) {
    for (let x = 1; x < BOARD_W - 1; x++) {
      if (collidesFast(board, "T", 2, x, y)) {
        continue;
      }
      // grounded?
      if (!collidesFast(board, "T", 2, x, y - 1)) {
        continue;
      }
      // needs an overhang (a lid) so the T must spin in
      const lidLeft = board.filled(x - 1, y + 1);
      const lidRight = board.filled(x + 1, y + 1);
      if (!lidLeft && !lidRight) {
        continue;
      }
      if (detectSpin(board, "T", 2 as Rot, x, y, true, 0) !== "full") {
        continue;
      }
      // would it clear two lines if dropped in now?
      const cells = cellsAt("T", 2, x, y);
      const test = board.clone();
      test.place(cells);
      const clears2 = test.clearLines().length >= 2;
      out.push({ x, y, clears2 });
    }
  }
  return out;
}

/** Cells that are empty but have something above them in their column.
 * Split by cover depth and location: a depth-1 cover inside the spin region
 * (cols 1-3) is how LST builds its next spin space; the same thing anywhere
 * else is just a hole. Scans each column top-down once, tracking the filled
 * cells above - this runs for every candidate board, so it stays O(height). */
function countHoles(
  board: Board,
  tslotCells: Set<number>,
  heights: number[],
): { deep: number; shallowSpin: number; shallowOther: number } {
  let deep = 0;
  let shallowSpin = 0;
  let shallowOther = 0;
  const rows = board.rows;
  for (let x = 0; x < BOARD_W; x++) {
    let cover = 0;
    for (let y = heights[x] - 1; y >= 0; y--) {
      if ((rows[y] >>> x) & 1) {
        cover++;
        continue;
      }
      if (tslotCells.has(x * 32 + y)) {
        continue;
      }
      if (cover > 1) {
        deep++;
      } else if (x >= LST_SPIN_COL - 1 && x <= LST_SPIN_COL + 1) {
        shallowSpin++;
      } else {
        shallowOther++;
      }
    }
  }
  return { deep, shallowSpin, shallowOther };
}

export const LST_SPIN_COL = 2;

const FULL = (1 << BOARD_W) - 1;
const BASE_MASK = FULL & ~(1 << LST_SPIN_COL); // full except col 2
const SLOT_MASK = FULL & ~(0b111 << (LST_SPIN_COL - 1)); // full except cols 1,2,3

export interface LstSite {
  y: number; // base row of the next TSD (stem row); slot row is y+1
  missing: number; // empty completion cells left in rows y and y+1
  roofReady: boolean;
}

// Search and grading ask for the same board's site several times (clear-
// reward toll, then evaluateBoard, then reasons). Placement result boards
// are never mutated after creation, so the answer can be cached per board.
const siteCache = new WeakMap<Board, LstSite | null>();

/**
 * The LST loop is alive iff a col-2 TSD is still buildable somewhere:
 * a row pair (y, y+1) where every row below fits the base shape (anything
 * but col 2), row y+1 keeps cols 1-3 open for the T, and every completion
 * cell that is still empty is reachable from the sky. Derived from the
 * four.lol loop structure (base rows / slot row alternation).
 */
export function findLstSite(board: Board): LstSite | null {
  const hit = siteCache.get(board);
  if (hit !== undefined) {
    return hit;
  }
  const site = computeLstSite(board);
  siteCache.set(board, site);
  return site;
}

function computeLstSite(board: Board): LstSite | null {
  const maxY = board.maxHeight();
  for (let y = 0; y <= maxY; y++) {
    // all rows strictly below must fit the base shape
    let ok = true;
    for (let yy = 0; yy < y; yy++) {
      if ((board.rows[yy] & ~BASE_MASK) !== 0) {
        ok = false;
        break;
      }
    }
    if (!ok) {
      continue;
    }
    if ((board.rows[y] & ~BASE_MASK) !== 0) {
      continue;
    }
    if ((board.rows[y + 1] & ~SLOT_MASK) !== 0) {
      continue;
    }

    // completion cells still empty must be open to the sky
    let missing = 0;
    let reachable = true;
    const openToSky = (x: number, fromY: number) => {
      for (let yy = fromY + 1; yy <= maxY; yy++) {
        if (board.filled(x, yy)) {
          return false;
        }
      }
      return true;
    };
    for (let x = 0; x < BOARD_W; x++) {
      if (x !== LST_SPIN_COL && !board.filled(x, y)) {
        missing++;
        if (!openToSky(x, y)) {
          // covered completion cell -> this site cannot be finished
          reachable = false;
          break;
        }
      }
      if (x !== 1 && x !== LST_SPIN_COL && x !== 3 && !board.filled(x, y + 1)) {
        missing++;
        if (!openToSky(x, y + 1)) {
          reachable = false;
          break;
        }
      }
    }
    if (!reachable) {
      continue;
    }

    const roofReady = board.filled(1, y + 2) || board.filled(3, y + 2);
    return { y, missing, roofReady };
  }
  return null;
}

/**
 * Extra stacked notch voids beside the well at the live site - the signature
 * of the 2-high S/Z diagonal overhang (the "J-Z" form). A flat 1-high L/J
 * lid leaves exactly one covered void per notch column (the T's arm under
 * the lid); the diagonal stacks a second (a double-up stacks more). Returns
 * the count of voids beyond that first flat lid, summed over cols 1 and 3 -
 * zero for a clean J-L build. Voids below the site base are permanent
 * garbage handled elsewhere (lstLoopDead / hole counting), so they are
 * excluded here.
 */
function diagonalOverhangs(board: Board, site: LstSite | null): number {
  if (!site) {
    return 0;
  }
  let extra = 0;
  for (const c of [LST_SPIN_COL - 1, LST_SPIN_COL + 1]) {
    const h = board.columnHeight(c);
    let covered = 0;
    for (let y = site.y; y < h; y++) {
      if (!board.filled(c, y)) {
        covered++;
      }
    }
    if (covered > 1) {
      extra += covered - 1;
    }
  }
  return extra;
}

/** True when a placement drops an O immediately beside the well (a cell in
 * notch column 1 or 3). An O there rigidly fills that notch column two rows
 * high - it cannot touch the well - which flat-tops the flank and destroys
 * the overhang flexibility the LST slot needs. The notch walls must be
 * filled, but by pieces that keep a workable lid; O is the wrong tool, so
 * only O placements consult this (callers gate on piece === "O"). */
export function oFlanksWell(cells: readonly (readonly [number, number])[]): boolean {
  for (const [x] of cells) {
    if (x === LST_SPIN_COL - 1 || x === LST_SPIN_COL + 1) {
      return true;
    }
  }
  return false;
}

/**
 * The overhang heights up one wall of the well: the filled runs that sit
 * between successive covered voids (T-spin slots) in column `col`, bottom to
 * top, over rows [0, top]. A height-2 run is an S/Z overhang, height-1 an L/J
 * lid, height-4 a Z/Z double-up, etc. The unfinished top run (no void above
 * it yet) is not reported. Used to validate LST shape and to detect double-ups.
 */
export function lstOverhangHeights(board: Board, col: number, top: number): number[] {
  const heights: number[] = [];
  let lastVoid = -1;
  for (let y = 0; y <= top; y++) {
    if (!board.filled(col, y)) {
      if (lastVoid >= 0) {
        const h = y - lastVoid - 1;
        if (h > 0) {
          heights.push(h);
        }
      }
      lastVoid = y;
    }
  }
  return heights;
}

/**
 * Covered empty cells outside the LST spin region (cols 1-3) and the well - the
 * "real holes" a clean build must never make. The left wall (col 0) and the
 * fill side (cols 4-9) are solid in a clean LST stack, so any empty cell with a
 * filled cell above it there is a hole; the spin columns 1/2/3 legitimately
 * hold the open well and the covered T-slot voids and are excluded. Zero = the
 * clean, flush stacking the solver produces; the live beam's soft hole penalty
 * lets this drift, so the planner uses it as a hard no-new-holes constraint.
 */
export function lstHoles(board: Board): number {
  let holes = 0;
  const top = board.maxHeight();
  for (let x = 0; x < BOARD_W; x++) {
    if (x >= LST_SPIN_COL - 1 && x <= LST_SPIN_COL + 1) {
      continue; // spin region: well (col 2) + notch slot voids (cols 1, 3)
    }
    let roof = false;
    for (let y = top - 1; y >= 0; y--) {
      if (board.filled(x, y)) {
        roof = true;
      } else if (roof) {
        holes++;
      }
    }
  }
  return holes;
}

/**
 * Community shape-based LST legality check (kzl's `isLST_state`, adapted to the
 * engine's bottom-up bitboard). A board is a legal LST state when the well is
 * an unobstructed column and, on each wall of it, the overhang heights alternate
 * in parity going up - the "2 1 2 1" pattern, generalized so double-/n-ups
 * (+2 rows) keep an overhang in its own parity class (2->4 stays even, 1->3
 * stays odd). Two same-parity overhangs in a row (e.g. 2 then 2 = ST stacking)
 * are excluded. The topmost, still-unfinished overhang is not constrained.
 *
 * This is the leaderboard's definition of "still LST", independent of the
 * engine's own col-2 site machinery (findLstSite), and is the correctness
 * oracle for generated double-up cover states.
 */
export function isLstState(board: Board): boolean {
  const top = board.maxHeight();
  if (top === 0) {
    return true; // empty board is trivially loop-legal
  }
  // the well is the unobstructed empty interior column
  let wellCol = -1;
  for (let x = 1; x < BOARD_W - 1; x++) {
    let open = true;
    for (let y = 0; y < top; y++) {
      if (board.filled(x, y)) {
        open = false;
        break;
      }
    }
    if (open) {
      wellCol = x;
      break;
    }
  }
  if (wellCol < 0) {
    return false; // no clear well
  }
  const parityAlternates = (hs: number[]): boolean => {
    for (let i = 1; i < hs.length; i++) {
      if ((hs[i] & 1) === (hs[i - 1] & 1)) {
        return false; // two same-parity overhangs in a row: not LST
      }
    }
    return true;
  };
  return (
    parityAlternates(lstOverhangHeights(board, wellCol - 1, top)) &&
    parityAlternates(lstOverhangHeights(board, wellCol + 1, top))
  );
}

/**
 * The true-LST residue invariant: a correct loop carries a 2-tall base residue
 * on the 1st and 5th columns (cols 0 and 4). Since TSDs clear full rows and the
 * stack shifts down, that residue always sits at the bottom, so rows 0-1 are the
 * absolute test. NOTE this is a health *tendency*, not a strict every-step law -
 * verified 20-TSD lines drop it ~7% of the time during openers / double-up
 * rebuilds - so it must be used with avoidability gating (only a violation when
 * an alternative kept it), never as an unconditional per-move rule.
 */
export function hasStartResidue(board: Board): boolean {
  return board.filled(0, 0) && board.filled(0, 1) && board.filled(4, 0) && board.filled(4, 1);
}

/**
 * Depth of the worst interior "valley" in the surface profile - a column lower
 * than the stacks on BOTH sides of it (the "two separated mountains" a broken
 * LST profile shows). The well column is excluded (its emptiness is by design).
 * 0 = a single clean mountain / monotonic slope; the LST profile law wants 0.
 */
export function profileValley(board: Board): number {
  const h: number[] = [];
  for (let x = 0; x < BOARD_W; x++) {
    if (x === LST_SPIN_COL) continue; // the well is a designed notch, not a valley
    h.push(board.columnHeight(x));
  }
  let worst = 0;
  for (let i = 1; i < h.length - 1; i++) {
    let leftMax = 0;
    for (let j = 0; j < i; j++) leftMax = Math.max(leftMax, h[j]);
    let rightMax = 0;
    for (let j = i + 1; j < h.length; j++) rightMax = Math.max(rightMax, h[j]);
    worst = Math.max(worst, Math.min(leftMax, rightMax) - h[i]);
  }
  return worst;
}

/** Checkerboard imbalance (Feltheshovel parity theory): overlay ±1 on the
 * board with (0,0) = +1, sum over filled cells. CI = 0 is perfectly flat
 * stacking; good LST parity keeps |CI| small (<= 1). Only the T is
 * parity-odd, so a drifting CI means T's are being spent into bad parity and
 * the loop will die a few bags out - a signal a short horizon can't see. */
export function checkerImbalance(board: Board): number {
  let ci = 0;
  const rows = board.rows;
  const h = board.maxHeight();
  for (let y = 0; y < h; y++) {
    const r = rows[y];
    for (let x = 0; x < BOARD_W; x++) {
      if ((r >>> x) & 1) {
        ci += ((x + y) & 1) === 0 ? 1 : -1;
      }
    }
  }
  return ci;
}

/**
 * Checkerboard imbalance of the STACK SIDE only - the flat fill zone right of
 * the notch (cols LST_SPIN_COL+2 .. 9). Feltheshovel's LST parity theory: the
 * well-side overhangs legitimately swing GLOBAL CI, so global |CI| penalizes
 * the required structure; what must stay controlled is the STACK-SIDE CI, which
 * a perfect LST loop keeps in the pattern 0,+1,0,-1 by (TSDs mod 4) and never
 * lets reach ±2 (the jaggedness that can no longer accommodate L/J/O). This is
 * the correct measure of "keep the residue even" - on the stack side, not the
 * overhang side. Use max(0,|it|-1) as the hard parity rule.
 */
export function stackSideImbalance(board: Board): number {
  let ci = 0;
  const rows = board.rows;
  const h = board.maxHeight();
  for (let y = 0; y < h; y++) {
    const r = rows[y];
    for (let x = LST_SPIN_COL + 2; x < BOARD_W; x++) {
      if ((r >>> x) & 1) {
        ci += ((x + y) & 1) === 0 ? 1 : -1;
      }
    }
  }
  return ci;
}

/** How far the fill side has risen above the current TSD slot's roof - the
 * volume imbalance (swng / Kixenon). Positive means the flat fill has
 * out-grown the well and a double-up is due to move that volume into the
 * well; <= 0 means the well is keeping pace and flat lids are correct. Uses
 * the fill columns right of the notch (cols LST_SPIN_COL+2 .. 9). */
/**
 * How deep a clean quad is set up in the well: the number of consecutive rows
 * from the floor that are complete except the well column (col 2), with the
 * well itself empty there. An I dropped into the well clears exactly this many
 * rows, so depth >= 4 means a tetris (quad) is available - real LST's volume
 * drain (TSDs net +8 cells/bag, a quad clears 40, so periodic quads let the
 * loop run past the ~20 TSD ceiling). Below 4 it's the progress toward one.
 */
export function quadWellDepth(board: Board): number {
  const FULL_ROW = (1 << BOARD_W) - 1;
  let depth = 0;
  for (let y = 0; y < BOARD_H; y++) {
    if (board.filled(LST_SPIN_COL, y)) {
      break; // well plugged here - not a clean quad well
    }
    if ((board.rows[y] | (1 << LST_SPIN_COL)) !== FULL_ROW) {
      break; // this row isn't complete-except-the-well
    }
    depth++;
  }
  return depth;
}

export function volumeGap(board: Board, siteY: number): number {
  let sum = 0;
  let n = 0;
  for (let x = LST_SPIN_COL + 2; x < BOARD_W; x++) {
    sum += board.columnHeight(x);
    n++;
  }
  const fillAvg = n > 0 ? sum / n : 0;
  return fillAvg - (siteY + 2);
}

type TSlot = { x: number; y: number; clears2: boolean };

function tslotCellSet(slots: TSlot[]): Set<number> {
  const cells = new Set<number>();
  for (const s of slots) {
    for (const [cx, cy] of cellsAt("T", 2, s.x, s.y)) {
      cells.add(cx * 32 + cy);
    }
  }
  return cells;
}

interface BoardFeatures {
  heights: number[];
  avgHeight: number;
  bumpiness: number;
  maxHeight: number;
  badOverhangs: number;
  deepWells: number;
  holeSplit: { deep: number; shallowSpin: number; shallowOther: number };
}

function boardFeatures(board: Board, tslotCells: Set<number>): BoardFeatures {
  const rows = board.rows;
  const heights: number[] = [];
  for (let x = 0; x < BOARD_W; x++) {
    heights.push(board.columnHeight(x));
  }
  const avgHeight = heights.reduce((a, h) => a + h, 0) / BOARD_W;

  let bumpiness = 0;
  for (let x = 0; x < BOARD_W - 1; x++) {
    bumpiness += Math.abs(heights[x] - heights[x + 1]);
  }

  const maxHeight = Math.max(...heights);

  // overhang cells: filled with an empty cell directly below
  let badOverhangs = 0;
  for (let x = 0; x < BOARD_W; x++) {
    for (let y = 1; y < heights[x]; y++) {
      if ((rows[y] >>> x) & 1 && !((rows[y - 1] >>> x) & 1)) {
        // part of a T-slot lid? (cell below or diagonal-below is slot space)
        const nearSlot =
          tslotCells.has(x * 32 + (y - 1)) ||
          tslotCells.has((x - 1) * 32 + (y - 1)) ||
          tslotCells.has((x + 1) * 32 + (y - 1));
        if (!nearSlot) {
          badOverhangs++;
        }
      }
    }
  }

  // wells: column lower than both neighbours by >= 3
  let deepWells = 0;
  for (let x = 0; x < BOARD_W; x++) {
    const l = x === 0 ? 99 : heights[x - 1];
    const r = x === BOARD_W - 1 ? 99 : heights[x + 1];
    if (Math.min(l, r) - heights[x] >= 3) {
      deepWells++;
    }
  }

  return {
    heights,
    avgHeight,
    bumpiness,
    maxHeight,
    badOverhangs,
    deepWells,
    holeSplit: countHoles(board, tslotCells, heights),
  };
}

/** Feature vector for the learned evaluator (shared with tools/train-lst-eval.ts). */
function featureVector(f: BoardFeatures, slots: TSlot[], site: LstSite | null): number[] {
  return [
    f.holeSplit.deep + f.holeSplit.shallowOther,
    f.holeSplit.deep,
    slots.length,
    slots.filter((s) => s.clears2).length,
    f.bumpiness,
    f.maxHeight,
    f.badOverhangs,
    f.deepWells,
    site ? 1 : 0,
    site ? Math.min(site.missing, 20) : 20,
    site?.roofReady ? 1 : 0,
    f.heights[LST_SPIN_COL],
    f.avgHeight,
    f.holeSplit.shallowSpin,
  ];
}

export function evaluateBoard(board: Board, lstBias = false): EvalResult {
  // In LST mode only col-2 slots are real slots; a roofed notch anywhere
  // else is stack damage and must not shield its cells from hole counting.
  const slots = lstBias ? findTSlots(board).filter((s) => s.x === LST_SPIN_COL) : findTSlots(board);
  const tslotCells = tslotCellSet(slots);
  const f = boardFeatures(board, tslotCells);
  const { bumpiness, maxHeight, badOverhangs, deepWells, holeSplit } = f;

  const holes = holeSplit.deep + holeSplit.shallowSpin + holeSplit.shallowOther;
  const tslots = slots.length;
  const tsdReady = slots.filter((s) => s.clears2).length;

  const b: EvalBreakdown = {
    holes,
    deepHoles: holeSplit.deep,
    tslots,
    tsdReady,
    bumpiness,
    maxHeight,
    badOverhangs,
    deepWells,
  };

  // LST-structure bias: the loop is alive iff a col-2 TSD is still
  // buildable; steer toward completing it (fewer missing cells, roof up).
  let lstScore = 0;
  if (lstBias) {
    if (slots.length > 0) {
      lstScore += WEIGHTS.lstSlotOnColumn;
    }
    const site = findLstSite(board);
    if (site) {
      lstScore += WEIGHTS.lstSiteAlive + WEIGHTS.lstMissingCell * site.missing;
      if (site.roofReady) {
        lstScore += WEIGHTS.lstRoofReady;
      }
      // volume-gated overhang: prefer the flat L/J lid while the stack is
      // balanced, but once the fill has over-risen above the slot a double-up
      // is due and the 2-high S/Z void is rewarded, not penalized (volume
      // theory's scheduled double-up instead of a "last resort" one).
      const gap = volumeGap(board, site.y);
      const diag = diagonalOverhangs(board, site);
      if (diag > 0) {
        const overstacked = gap >= WEIGHTS.lstOverstackThreshold;
        lstScore += (overstacked ? WEIGHTS.lstDoubleupDue : WEIGHTS.lstDiagonalOverhang) * diag;
      }
      // volume: penalize the fill towering above the well (forces early
      // double-ups instead of over-stacking the slot into oblivion)
      lstScore += WEIGHTS.lstOverstack * Math.max(0, gap);
      // keep good checkerboard parity - |CI| beyond 1 is the loop dying slow
      lstScore += WEIGHTS.lstParity * Math.max(0, Math.abs(checkerImbalance(board)) - 1);
    } else {
      lstScore += WEIGHTS.lstLoopDead;
    }
    // learned correction on top of the hand-tuned weights (zero when the
    // net is disabled or untrained)
    lstScore += neuralValue(featureVector(f, slots, site));
  }

  // in LST mode a shallow overhang cell in the spin region is often the
  // book move building the next spin space - soften only those; shallow
  // covers elsewhere are ordinary holes
  const holeScore = lstBias
    ? WEIGHTS.hole * (holeSplit.deep + holeSplit.shallowOther) +
      WEIGHTS.hole * 0.4 * holeSplit.shallowSpin
    : WEIGHTS.hole * holes;

  const score =
    lstScore +
    holeScore +
    // only the first slot counts fully; extra slots are worth little
    WEIGHTS.tslot * Math.min(tslots, 1) +
    15 * Math.max(0, Math.min(tslots, 2) - 1) +
    WEIGHTS.tsdReady * Math.min(tsdReady, 1) +
    WEIGHTS.bumpiness * bumpiness +
    WEIGHTS.heightOver * Math.max(0, maxHeight - WEIGHTS.heightCap) +
    WEIGHTS.badOverhang * badOverhangs +
    WEIGHTS.deepWell * deepWells;

  return { score, b };
}

/** Feature vector of a board for training the learned evaluator. */
export function lstFeatureVector(board: Board): number[] {
  const slots = findTSlots(board).filter((s) => s.x === LST_SPIN_COL);
  const f = boardFeatures(board, tslotCellSet(slots));
  return featureVector(f, slots, findLstSite(board));
}

/** Reward/penalty for the line-clear action itself. Under LST bias the goal
 * is TSDs only - a quad keeps B2B but spends the I and is off-plan. */
export function clearReward(info: ClearInfo, piece?: string, lstBias = false): number {
  const { linesCleared, spin } = info;
  if (linesCleared === 0) {
    return 0;
  }
  if (spin === "full") {
    if (linesCleared >= 2) {
      return WEIGHTS.tsd;
    }
    return lstBias ? WEIGHTS.tssOffPlan : WEIGHTS.tss;
  }
  if (spin === "mini") {
    return WEIGHTS.tspinMiniClear;
  }
  if (linesCleared === 4 && piece === "I") {
    return lstBias ? WEIGHTS.quadOffPlan : WEIGHTS.tetris;
  }
  return WEIGHTS.burn * linesCleared;
}
