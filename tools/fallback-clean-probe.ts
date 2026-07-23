// Prove the opener-miss fallback degrades cleanly instead of drifting. For the
// bags planOpener CAN'T set up, drive lstCleanBuildMove from empty (park the T
// when it says so) and compare against the old bestMove drift, over N pieces:
// buried holes ever cut, whether the col-2 well was ever filled, TSDs fired,
// and whether the board reaches a continuable LST state (loop can take over).
//   npx tsx tools/fallback-clean-probe.ts [sample=15] [pieces=20]

import { Board } from "../src/core/board";
import type { PieceType } from "../src/core/pieces";
import { enumeratePlacements } from "../src/engine/enumerate";
import { lstHoles, findLstSite, isLstState, LST_SPIN_COL } from "../src/engine/eval";
import { lstCleanBuildMove, type LoopMove } from "../src/engine/lst-loop";
import { planOpener } from "../src/engine/opener";
import { bestMove } from "../src/engine/grade";

const PIECES: PieceType[] = ["I", "O", "T", "S", "Z", "J", "L"];
function mul(s: number) { let a = s >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function bag(r: () => number) { const b = [...PIECES]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }
const key = (cs: readonly (readonly [number, number])[]) => cs.map(([x, y]) => x * 32 + y).sort((a, b) => a - b).join(",");
const wellFilled = (b: Board) => { for (let y = 0; y < b.maxHeight(); y++) if (b.filled(LST_SPIN_COL, y)) return true; return false; };

interface Stat { holes: number; wellHit: boolean; tsds: number; pieces: number; continuable: boolean }

function runClean(seed: number, nPieces: number): Stat {
  const r = mul(9000 + seed);
  const q: PieceType[] = [];
  let board = new Board();
  let hold: PieceType | null = null;
  let holes = 0, wellHit = false, tsds = 0, placed = 0;
  for (let i = 0; i < nPieces; i++) {
    while (q.length < 3) q.push(...bag(r));
    const active = q[0];
    const mv = lstCleanBuildMove(board, active);
    if (!mv) {
      // clean-build said park: stash active in hold (or swap)
      if (hold === null) { hold = q.shift()!; continue; }
      // hold occupied: try the held piece instead
      const hm = lstCleanBuildMove(board, hold);
      if (!hm) break;
      board = apply(board, hm); hold = active; q.shift();
    } else {
      board = apply(board, mv); q.shift();
      if (mv.spin === "full" && mv.linesCleared >= 2) tsds++;
    }
    placed++;
    holes = Math.max(holes, lstHoles(board));
    if (wellFilled(board)) wellHit = true;
  }
  return { holes, wellHit, tsds, pieces: placed, continuable: isLstState(board) && findLstSite(board) !== null };
}

function runBest(seed: number, nPieces: number): Stat {
  const r = mul(9000 + seed);
  const q: PieceType[] = [];
  let board = new Board();
  let hold: PieceType | null = null;
  let holes = 0, wellHit = false, tsds = 0, placed = 0;
  for (let i = 0; i < nPieces; i++) {
    while (q.length < 3) q.push(...bag(r));
    const mv = bestMove(Array.from(board.rows), [...q], hold, true);
    if (!mv) break;
    const p = enumeratePlacements(board, mv.piece as PieceType).find((x) => key(x.cells) === key(mv.cells));
    if (!p) break;
    // resolve hold like the game would
    if (mv.piece !== q[0]) { if (hold === null) { hold = q.shift()!; } else { hold = q[0]; } }
    q.shift();
    board = p.after;
    if (p.type === "T" && p.spin === "full" && p.linesCleared >= 2) tsds++;
    placed++;
    holes = Math.max(holes, lstHoles(board));
    if (wellFilled(board)) wellHit = true;
  }
  return { holes, wellHit, tsds, pieces: placed, continuable: isLstState(board) && findLstSite(board) !== null };
}

function apply(board: Board, mv: LoopMove): Board {
  const p = enumeratePlacements(board, mv.piece).find((x) => key(x.cells) === key(mv.cells));
  return p ? p.after : board;
}

const SAMPLE = Number(process.argv[2] ?? 15);
const NP = Number(process.argv[3] ?? 20);
const clean: Stat[] = [], best: Stat[] = [];
for (let i = 0; i < SAMPLE; i++) {
  const r = mul(9000 + i);
  const bagQ = [...bag(r), ...bag(r)];
  if (planOpener(bagQ)) continue; // only the bags the fixed planner drops
  clean.push(runClean(i, NP));
  best.push(runBest(i, NP));
}
const avg = (a: Stat[], f: (s: Stat) => number) => (a.reduce((x, s) => x + f(s), 0) / a.length).toFixed(2);
const pct = (a: Stat[], f: (s: Stat) => boolean) => `${((100 * a.filter(f).length) / a.length).toFixed(0)}%`;
console.log(`failing bags tested: ${clean.length}, ${NP} pieces each\n`);
console.log(`                     clean-build fallback   bestMove drift`);
console.log(`  max holes cut ever:  ${avg(clean, (s) => s.holes).padStart(6)}                ${avg(best, (s) => s.holes)}`);
console.log(`  ever filled the well: ${pct(clean, (s) => s.wellHit).padStart(5)}                 ${pct(best, (s) => s.wellHit)}`);
console.log(`  reached continuable:  ${pct(clean, (s) => s.continuable).padStart(5)}                 ${pct(best, (s) => s.continuable)}`);
console.log(`  TSDs fired (avg):    ${avg(clean, (s) => s.tsds).padStart(6)}                ${avg(best, (s) => s.tsds)}`);
