// Heuristic board evaluation tuned for LST stacking: keep the stack clean,
// always have (or be building) a T-spin-double slot, never burn lines,
// never bury cells. Returns a score plus a per-feature breakdown used to
// generate human explanations ("this created a hole", "this killed your
// T-slot", ...).

import { Board, BOARD_W } from '../core/board';
import { cellsAt } from '../core/pieces';
import { detectSpin } from '../core/spin';
import type { SpinKind } from '../core/spin';
import type { Rot } from '../core/pieces';
import { collidesFast } from './masks';
import { neuralValue } from './neural';

export interface EvalBreakdown {
  holes: number;          // buried empty cells (T-slot cells excluded)
  deepHoles: number;      // holes buried under 2+ cells (never book moves)
  tslots: number;         // structural full-T-spin slots available
  tsdReady: number;       // slots that would clear 2 lines right now
  bumpiness: number;
  maxHeight: number;
  badOverhangs: number;   // overhang cells not part of a T-slot
  deepWells: number;      // wells of depth >= 3 (I-piece dependencies)
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
  heightOver: -14,   // per row above soft cap
  heightCap: 10,
  badOverhang: -45,
  deepWell: -35,
  // action rewards (applied to the placement, not the board)
  tsd: 480,
  tss: 60,           // fine in free play…
  tssOffPlan: -120,  // …but under LST bias a TSS spends the T without the
                     // TSD: half the payoff, the whole T - a wasted piece
  tspinMiniClear: -30,
  burn: -80,          // per line cleared without a T-spin
  tetris: 120,        // I-piece 4-line: fine in free play…
  quadOffPlan: -120,  // …but off-plan under LST bias: the goal is TSDs only,
                      // and a quad spends the I plus four rows of structure
  // LST-structure bias (four.lol: the spin column is column index 2,
  // left wall on columns 0-1, fill on 3-9)
  lstSlotOnColumn: 90,     // extra for a T-slot sitting on the LST column
  // loop viability dominates everything: a dead loop is the worst outcome,
  // progress toward completing the next TSD site is the direction to play
  lstLoopDead: -650,
  lstSiteAlive: 120,
  lstMissingCell: -13,     // per unfilled completion cell at the site
  lstRoofReady: 45,
};

/** Find structural T-slots: positions where a T (pointing down) fits as a
 * full T-spin. Returns slot centers. */
export function findTSlots(board: Board): { x: number; y: number; clears2: boolean }[] {
  const out: { x: number; y: number; clears2: boolean }[] = [];
  const maxY = Math.min(board.maxHeight() + 1, 22);
  for (let y = 0; y <= maxY; y++) {
    for (let x = 1; x < BOARD_W - 1; x++) {
      if (collidesFast(board, 'T', 2, x, y)) continue;
      // grounded?
      if (!collidesFast(board, 'T', 2, x, y - 1)) continue;
      // needs an overhang (a lid) so the T must spin in
      const lidLeft = board.filled(x - 1, y + 1);
      const lidRight = board.filled(x + 1, y + 1);
      if (!lidLeft && !lidRight) continue;
      if (detectSpin(board, 'T', 2 as Rot, x, y, true, 0) !== 'full') continue;
      // would it clear two lines if dropped in now?
      const cells = cellsAt('T', 2, x, y);
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
 * else is just a hole. */
function countHoles(
  board: Board,
  tslotCells: Set<number>,
): { deep: number; shallowSpin: number; shallowOther: number } {
  let deep = 0;
  let shallowSpin = 0;
  let shallowOther = 0;
  for (let x = 0; x < BOARD_W; x++) {
    const h = board.columnHeight(x);
    for (let y = 0; y < h; y++) {
      if (board.filled(x, y) || tslotCells.has(x * 32 + y)) continue;
      let cover = 0;
      for (let yy = y + 1; yy < h; yy++) if (board.filled(x, yy)) cover++;
      if (cover > 1) deep++;
      else if (x >= LST_SPIN_COL - 1 && x <= LST_SPIN_COL + 1) shallowSpin++;
      else shallowOther++;
    }
  }
  return { deep, shallowSpin, shallowOther };
}

export const LST_SPIN_COL = 2;

const FULL = (1 << BOARD_W) - 1;
const BASE_MASK = FULL & ~(1 << LST_SPIN_COL);          // full except col 2
const SLOT_MASK = FULL & ~(0b111 << (LST_SPIN_COL - 1)); // full except cols 1,2,3

export interface LstSite {
  y: number;        // base row of the next TSD (stem row); slot row is y+1
  missing: number;  // empty completion cells left in rows y and y+1
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
  if (hit !== undefined) return hit;
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
      if ((board.rows[yy] & ~BASE_MASK) !== 0) { ok = false; break; }
    }
    if (!ok) continue;
    if ((board.rows[y] & ~BASE_MASK) !== 0) continue;
    if ((board.rows[y + 1] & ~SLOT_MASK) !== 0) continue;

    // completion cells still empty must be open to the sky
    let missing = 0;
    let reachable = true;
    const openToSky = (x: number, fromY: number) => {
      for (let yy = fromY + 1; yy <= maxY; yy++) if (board.filled(x, yy)) return false;
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
        if (!openToSky(x, y + 1)) { reachable = false; break; }
      }
    }
    if (!reachable) continue;

    const roofReady = board.filled(1, y + 2) || board.filled(3, y + 2);
    return { y, missing, roofReady };
  }
  return null;
}

export function evaluateBoard(board: Board, lstBias = false): EvalResult {
  // In LST mode only col-2 slots are real slots; a roofed notch anywhere
  // else is stack damage and must not shield its cells from hole counting.
  const slots = lstBias
    ? findTSlots(board).filter((s) => s.x === LST_SPIN_COL)
    : findTSlots(board);
  const tslotCells = new Set<number>();
  for (const s of slots) {
    for (const [cx, cy] of cellsAt('T', 2, s.x, s.y)) tslotCells.add(cx * 32 + cy);
  }

  const heights: number[] = [];
  for (let x = 0; x < BOARD_W; x++) heights.push(board.columnHeight(x));

  let bumpiness = 0;
  for (let x = 0; x < BOARD_W - 1; x++) bumpiness += Math.abs(heights[x] - heights[x + 1]);

  const maxHeight = Math.max(...heights);

  // overhang cells: filled with an empty cell directly below
  let badOverhangs = 0;
  for (let x = 0; x < BOARD_W; x++) {
    for (let y = 1; y < heights[x]; y++) {
      if (board.filled(x, y) && !board.filled(x, y - 1)) {
        // part of a T-slot lid? (cell below or diagonal-below is slot space)
        const nearSlot =
          tslotCells.has(x * 32 + (y - 1)) ||
          tslotCells.has((x - 1) * 32 + (y - 1)) ||
          tslotCells.has((x + 1) * 32 + (y - 1));
        if (!nearSlot) badOverhangs++;
      }
    }
  }

  // wells: column lower than both neighbours by >= 3
  let deepWells = 0;
  for (let x = 0; x < BOARD_W; x++) {
    const l = x === 0 ? 99 : heights[x - 1];
    const r = x === BOARD_W - 1 ? 99 : heights[x + 1];
    const depth = Math.min(l, r) - heights[x];
    if (depth >= 3) deepWells++;
  }

  const holeSplit = countHoles(board, tslotCells);
  const holes = holeSplit.deep + holeSplit.shallowSpin + holeSplit.shallowOther;
  const tslots = slots.length;
  const tsdReady = slots.filter((s) => s.clears2).length;

  const b: EvalBreakdown = { holes, deepHoles: holeSplit.deep, tslots, tsdReady, bumpiness, maxHeight, badOverhangs, deepWells };

  // LST-structure bias: the loop is alive iff a col-2 TSD is still
  // buildable; steer toward completing it (fewer missing cells, roof up).
  let lstScore = 0;
  if (lstBias) {
    if (slots.some((s) => s.x === LST_SPIN_COL)) lstScore += WEIGHTS.lstSlotOnColumn;
    const site = findLstSite(board);
    if (site) {
      lstScore += WEIGHTS.lstSiteAlive + WEIGHTS.lstMissingCell * site.missing;
      if (site.roofReady) lstScore += WEIGHTS.lstRoofReady;
    } else {
      lstScore += WEIGHTS.lstLoopDead;
    }
    // learned correction on top of the hand-tuned weights (zero when the
    // net is disabled or untrained)
    const avgHeight = heights.reduce((a, h) => a + h, 0) / BOARD_W;
    lstScore += neuralValue([
      holeSplit.deep + holeSplit.shallowOther, holeSplit.deep, slots.length,
      slots.filter((s) => s.clears2).length, bumpiness, maxHeight,
      badOverhangs, deepWells,
      site ? 1 : 0, site ? Math.min(site.missing, 20) : 20, site?.roofReady ? 1 : 0,
      heights[LST_SPIN_COL], avgHeight, holeSplit.shallowSpin,
    ]);
  }

  // in LST mode a shallow overhang cell in the spin region is often the
  // book move building the next spin space - soften only those; shallow
  // covers elsewhere are ordinary holes
  const holeScore = lstBias
    ? WEIGHTS.hole * (holeSplit.deep + holeSplit.shallowOther) + WEIGHTS.hole * 0.4 * holeSplit.shallowSpin
    : WEIGHTS.hole * holes;

  const score =
    lstScore +
    holeScore +
    // only the first slot counts fully; extra slots are worth little
    WEIGHTS.tslot * Math.min(tslots, 1) + 15 * Math.max(0, Math.min(tslots, 2) - 1) +
    WEIGHTS.tsdReady * Math.min(tsdReady, 1) +
    WEIGHTS.bumpiness * bumpiness +
    WEIGHTS.heightOver * Math.max(0, maxHeight - WEIGHTS.heightCap) +
    WEIGHTS.badOverhang * badOverhangs +
    WEIGHTS.deepWell * deepWells;

  return { score, b };
}

/** Feature vector for the learned evaluator - must stay in sync with the
 * inline extraction in evaluateBoard and tools/train-lst-eval.ts. */
export function lstFeatureVector(board: Board): number[] {
  const slots = findTSlots(board).filter((s) => s.x === LST_SPIN_COL);
  const tslotCells = new Set<number>();
  for (const s of slots) {
    for (const [cx, cy] of cellsAt('T', 2, s.x, s.y)) tslotCells.add(cx * 32 + cy);
  }
  const heights: number[] = [];
  for (let x = 0; x < BOARD_W; x++) heights.push(board.columnHeight(x));
  let bumpiness = 0;
  for (let x = 0; x < BOARD_W - 1; x++) bumpiness += Math.abs(heights[x] - heights[x + 1]);
  const maxHeight = Math.max(...heights);
  let badOverhangs = 0;
  for (let x = 0; x < BOARD_W; x++) {
    for (let y = 1; y < heights[x]; y++) {
      if (board.filled(x, y) && !board.filled(x, y - 1)) {
        const nearSlot =
          tslotCells.has(x * 32 + (y - 1)) ||
          tslotCells.has((x - 1) * 32 + (y - 1)) ||
          tslotCells.has((x + 1) * 32 + (y - 1));
        if (!nearSlot) badOverhangs++;
      }
    }
  }
  let deepWells = 0;
  for (let x = 0; x < BOARD_W; x++) {
    const l = x === 0 ? 99 : heights[x - 1];
    const r = x === BOARD_W - 1 ? 99 : heights[x + 1];
    if (Math.min(l, r) - heights[x] >= 3) deepWells++;
  }
  const holeSplit = countHoles(board, tslotCells);
  const site = findLstSite(board);
  const avgHeight = heights.reduce((a, h) => a + h, 0) / BOARD_W;
  return [
    holeSplit.deep + holeSplit.shallowOther, holeSplit.deep, slots.length,
    slots.filter((s) => s.clears2).length, bumpiness, maxHeight,
    badOverhangs, deepWells,
    site ? 1 : 0, site ? Math.min(site.missing, 20) : 20, site?.roofReady ? 1 : 0,
    heights[LST_SPIN_COL], avgHeight, holeSplit.shallowSpin,
  ];
}

/** Reward/penalty for the line-clear action itself. Under LST bias the goal
 * is TSDs only - a quad keeps B2B but spends the I and is off-plan. */
export function clearReward(info: ClearInfo, piece?: string, lstBias = false): number {
  const { linesCleared, spin } = info;
  if (linesCleared === 0) return 0;
  if (spin === 'full') {
    if (linesCleared >= 2) return WEIGHTS.tsd;
    return lstBias ? WEIGHTS.tssOffPlan : WEIGHTS.tss;
  }
  if (spin === 'mini') return WEIGHTS.tspinMiniClear;
  if (linesCleared === 4 && piece === 'I') return lstBias ? WEIGHTS.quadOffPlan : WEIGHTS.tetris;
  return WEIGHTS.burn * linesCleared;
}
