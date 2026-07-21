// Tune the solver's candidate-ranking weights against SEARCH COST. Objective:
// solve more seeds, and with fewer nodes (nodes-to-solve is deterministic, so
// the result is reproducible and machine-independent). Coordinate descent over
// the 10 weights. The diagnostic showed the LDS needs discrepancy 6-11 with the
// hand-tuned weights, and cost is exponential in discrepancy - so a better
// ranking should cut nodes sharply.
//
//   npx tsx tools/tune-rank.ts [target] [nodeCap] [passes] [seeds...]

import { Game } from "../src/core/game";
import { planOpener } from "../src/engine/opener";
import { solveLstRun, clearSolveCache, RANK_WEIGHTS } from "../src/engine/lst-solver";
import type { PieceType } from "../src/core/pieces";

const TARGET = Number(process.argv[2] ?? 18);
const NODE_CAP = Number(process.argv[3] ?? 2_000_000);
const PASSES = Number(process.argv[4] ?? 2);
const SEEDS = process.argv.slice(5).map(Number);
if (SEEDS.length === 0) SEEDS.push(10, 11, 13, 14, 15, 17);

type Weights = typeof RANK_WEIGHTS;
const DEFAULTS: Weights = { ...RANK_WEIGHTS };

function solveSeed(seed: number): { solved: boolean; nodes: number } {
  const game = new Game(seed);
  const plan = planOpener([game.active!.type, ...game.peekQueue(9)]);
  if (!plan) return { solved: false, nodes: NODE_CAP };
  let tsds = 0;
  for (const mv of plan.moves) {
    const ev = game.applyMove(mv.piece, mv.cells, mv.spin);
    if (!ev) return { solved: false, nodes: NODE_CAP };
    if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) tsds++;
  }
  const queue = [game.active!.type, ...game.peekQueue(TARGET * 9 + 20)] as PieceType[];
  const res = solveLstRun(game.board, queue, game.hold, TARGET - tsds, {
    budgetMs: 120000, // effectively no time limit; the node cap is the budget
    nodeBudget: NODE_CAP,
    tailFree: 3,
  });
  return { solved: !!res?.solved, nodes: res?.nodes ?? NODE_CAP };
}

function evalWeights(w: Weights): { solves: number; nodes: number } {
  Object.assign(RANK_WEIGHTS, w);
  clearSolveCache(); // weights aren't in the cache key
  let solves = 0;
  let nodes = 0;
  for (const s of SEEDS) {
    const r = solveSeed(s);
    if (r.solved) solves++;
    nodes += r.nodes;
  }
  return { solves, nodes };
}

// better = more solves, then fewer nodes
function better(a: { solves: number; nodes: number }, b: { solves: number; nodes: number }): boolean {
  return a.solves > b.solves || (a.solves === b.solves && a.nodes < b.nodes);
}

const keys = Object.keys(DEFAULTS) as (keyof Weights)[];
const FACTORS = [0.5, 1.6];

let best: Weights = { ...DEFAULTS };
let bestScore = evalWeights(best);
const baseline = bestScore;
console.log(
  `baseline: solves=${baseline.solves}/${SEEDS.length} nodes=${baseline.nodes.toLocaleString()} (seeds ${SEEDS.join(",")}, target ${TARGET})`,
);

for (let pass = 0; pass < PASSES; pass++) {
  let improvedThisPass = false;
  for (const key of keys) {
    for (const f of FACTORS) {
      const trial = { ...best, [key]: Math.max(1, Math.round(best[key] * f)) };
      if (trial[key] === best[key]) continue;
      const score = evalWeights(trial);
      if (better(score, bestScore)) {
        best = trial;
        bestScore = score;
        improvedThisPass = true;
        console.log(
          `  pass ${pass} ${String(key)} ${DEFAULTS[key]}->${trial[key]}: solves=${score.solves} nodes=${score.nodes.toLocaleString()} ✓`,
        );
      }
    }
  }
  if (!improvedThisPass) {
    console.log(`  pass ${pass}: no improvement, stopping`);
    break;
  }
}

console.log(`\n=== RESULT ===`);
console.log(
  `baseline: solves=${baseline.solves}/${SEEDS.length} nodes=${baseline.nodes.toLocaleString()}`,
);
console.log(
  `tuned:    solves=${bestScore.solves}/${SEEDS.length} nodes=${bestScore.nodes.toLocaleString()}`,
);
const nodeCut =
  baseline.nodes > 0 ? (100 * (baseline.nodes - bestScore.nodes)) / baseline.nodes : 0;
console.log(`node reduction: ${nodeCut.toFixed(1)}%   extra solves: ${bestScore.solves - baseline.solves}`);
console.log(`tuned weights:`, JSON.stringify(best));
