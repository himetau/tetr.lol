// Decisive experiment: drive the LST loop with a SHORT live solve each step
// (mini-solveLstRun for the next few TSDs, play only the first move, repeat)
// instead of the greedy beam. If the planner sustains the loop where the beam
// dies at ~2.5 TSDs, that proves live play should mini-solve, not beam.
//   npx tsx tools/solver-loop-probe.ts [runs] [miniTarget] [budgetMs]

import { Board } from "../src/core/board";
import type { PieceType } from "../src/core/pieces";
import { solveLstRun } from "../src/engine/lst-solver";
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
const MINI = Number(process.argv[3] ?? 4);
const BUDGET = Number(process.argv[4] ?? 400);

function runOne(seed: number): number {
  const rng = mulberry32(seed);
  let board = startBoard();
  let hold: PieceType | null = null;
  let queue: PieceType[] = [];
  let tsds = 0;
  for (let step = 0; step < 200; step++) {
    while (queue.length < MINI * 9 + 14) queue.push(...bag(rng));
    // mini-solve the next MINI clears from here; play only the first move
    const res = solveLstRun(board, queue, hold, MINI, {
      budgetMs: BUDGET,
      nodeBudget: 50_000_000,
      tailFree: 2,
      allowQuad: true,
    });
    if (!res || res.moves.length === 0) return tsds;
    const m = res.moves[0];
    if (board.key() !== m.beforeKey) return tsds; // shouldn't happen
    // advance the queue/hold to match the played piece
    const cur = queue[0];
    if (m.piece === cur) {
      queue.shift();
    } else if (hold === m.piece) {
      hold = cur;
      queue.shift();
    } else if (hold === null) {
      hold = queue.shift()!; // held cur, played next
      queue.shift();
    } else {
      return tsds; // move references an unavailable piece
    }
    board.place(m.cells);
    const cleared = board.clearLines().length;
    if (m.piece === "T" && m.spin === "full" && cleared >= 2) tsds++;
    if (board.maxHeight() >= 20) return tsds;
  }
  return tsds;
}

const vals: number[] = [];
for (let i = 0; i < RUNS; i++) vals.push(runOne(5000 + i));
vals.sort((a, b) => a - b);
const mean = vals.reduce((a, b) => a + b, 0) / RUNS;
console.log(
  `solver-driven loop (miniTarget=${MINI}, budget=${BUDGET}ms, ${RUNS} runs, seeds 5000+):`,
);
console.log(`  TSDs: mean=${mean.toFixed(1)} median=${vals[RUNS >> 1]} max=${Math.max(...vals)} min=${Math.min(...vals)}`);
