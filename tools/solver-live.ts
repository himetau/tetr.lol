// Online window-solver: each move, run solveLstRun over ONLY the visible pieces
// (current + preview + hold) with a tiny budget, play the first move, replan.
// This is the "read the bag and plan" player - the solver's hard-constrained
// clean stacking applied live, instead of the reactive soft-weight beam.
//   npx tsx tools/solver-live.ts [runs] [window] [budgetMs]

import { Board } from "../src/core/board";
import type { PieceType } from "../src/core/pieces";
import { solveLstRun } from "../src/engine/lst-solver";
import { lstHoles } from "../src/engine/eval";
import coverData from "../src/data/lst-cover.json";

const PIECES: PieceType[] = ["I", "O", "T", "S", "Z", "J", "L"];
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function bag(rng: () => number): PieceType[] {
  const b = [...PIECES];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}
function startBoard(): Board {
  const g = coverData.groups.find((x) => x.name === "flattop LST bag 2")!;
  return Board.fromStrings(g.start.map((r) => r.replace(/[^X]/g, ".")));
}

const RUNS = Number(process.argv[2] ?? 20);
const WINDOW = Number(process.argv[3] ?? 7);
const BUDGET = Number(process.argv[4] ?? 40);

function runOne(seed: number): { tsds: number; maxHoles: number } {
  const rng = mulberry32(seed);
  let board = startBoard();
  let hold: PieceType | null = null;
  let queue: PieceType[] = [];
  let tsds = 0;
  let maxHoles = 0;
  for (let step = 0; step < 400; step++) {
    while (queue.length < WINDOW + 2) queue.push(...bag(rng));
    const window = queue.slice(0, WINDOW);
    const res = solveLstRun(board, window, hold, 20, { budgetMs: BUDGET });
    if (!res || res.moves.length === 0) break;
    const mv = res.moves[0];
    // infer hold bookkeeping from which piece the solver chose to play first
    let usesHold = false;
    if (mv.piece === queue[0]) {
      queue.shift();
    } else if (hold !== null && mv.piece === hold) {
      hold = queue.shift()!;
      usesHold = true;
    } else if (hold === null && mv.piece === queue[1]) {
      hold = queue.shift()!;
      queue.shift();
      usesHold = true;
    } else {
      break; // couldn't map the move to a legal hold action
    }
    void usesHold;
    board.place(mv.cells);
    board.clearLines();
    if (mv.isTsd) tsds++;
    maxHoles = Math.max(maxHoles, lstHoles(board));
    if (board.maxHeight() >= 20) break;
  }
  return { tsds, maxHoles };
}

const vals: number[] = [];
let dirty = 0;
const t0 = Date.now();
for (let i = 0; i < RUNS; i++) {
  const r = runOne(6000 + i);
  vals.push(r.tsds);
  if (r.maxHoles > 0) dirty++;
}
const mean = vals.reduce((a, b) => a + b, 0) / RUNS;
const sorted = [...vals].sort((a, b) => a - b);
console.log(
  `online-solver window=${WINDOW} budget=${BUDGET}ms: n=${RUNS} ` +
    `mean=${mean.toFixed(1)} median=${sorted[RUNS >> 1]} max=${Math.max(...vals)} ` +
    `reach15=${vals.filter((v) => v >= 15).length} reach20=${vals.filter((v) => v >= 20).length} ` +
    `runsWithAnyHole=${dirty}/${RUNS} (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
);
console.log("dist:", sorted.join(","));
