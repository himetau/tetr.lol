// Deterministic solver-efficiency benchmark: for a fixed panel of known-
// solvable seeds, solve the same target at a big budget and report how many
// NODES the search spent to reach it (plus solved-count as the guard). No
// random bags, no live playback - the only variable is the ranking/search, so
// an A/B here isolates a solver change cleanly (lower nodes = better ordering).
//   npx tsx tools/solve-bench.ts [target] [budgetMs] [seeds...]

import { Game } from "../src/core/game";
import { planOpener } from "../src/engine/opener";
import { solveLstRun, clearSolveCache } from "../src/engine/lst-solver";
import type { PieceType } from "../src/core/pieces";

// Node-capped (not time-capped) so the metric is deterministic and immune to
// CPU contention: "TSDs reached within NODECAP nodes" is a pure function of the
// ranking, so A/B configs can even run in parallel.
const TARGET = Number(process.argv[2] ?? 16);
const NODECAP = Number(process.argv[3] ?? 400_000);
const SEEDS =
  process.argv.length > 4
    ? process.argv.slice(4).map(Number)
    : [1, 2, 9, 10, 11, 12, 13, 14, 15, 17, 21, 22, 24, 27, 28, 31, 33, 55, 59, 97];

function solveSeed(seed: number): { solved: boolean; tsds: number; nodes: number; ms: number } {
  clearSolveCache(); // never let a memoized line mask the ranking under test
  const game = new Game(seed);
  const plan = planOpener([game.active!.type, ...game.peekQueue(9)]);
  if (!plan) return { solved: false, tsds: 0, nodes: 0, ms: 0 };
  let tsds = 0;
  for (const mv of plan.moves) {
    const ev = game.applyMove(mv.piece, mv.cells, mv.spin);
    if (!ev) return { solved: false, tsds: 0, nodes: 0, ms: 0 };
    if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) tsds++;
  }
  const queue = [game.active!.type, ...game.peekQueue(TARGET * 9 + 20)] as PieceType[];
  const t0 = Date.now();
  const res = solveLstRun(game.board, queue, game.hold, TARGET - tsds, {
    budgetMs: 600_000, // effectively unlimited; NODECAP is the real stop
    nodeBudget: NODECAP,
    tailFree: 3,
    allowQuad: true,
  });
  const ms = Date.now() - t0;
  if (!res) return { solved: false, tsds, nodes: 0, ms };
  return { solved: res.solved, tsds: tsds + res.tsds, nodes: res.nodes, ms };
}

let solved = 0;
let nodesSolved = 0;
let msSolved = 0;
let tsdsTotal = 0;
const rows: string[] = [];
for (const seed of SEEDS) {
  const r = solveSeed(seed);
  tsdsTotal += r.tsds;
  if (r.solved) {
    solved++;
    nodesSolved += r.nodes;
    msSolved += r.ms;
  }
  rows.push(
    `  seed ${String(seed).padStart(4)}: ${r.solved ? "OK " : "-- "} tsds=${String(r.tsds).padStart(2)} nodes=${String(r.nodes).padStart(9)} ${r.ms}ms`,
  );
}
console.log(`solve-bench target=${TARGET} nodeCap=${NODECAP}  (${SEEDS.length} seeds)`);
console.log(rows.join("\n"));
console.log(
  `SUMMARY: solved=${solved}/${SEEDS.length}  tsdsReached=${tsdsTotal}  nodes(solved)=${nodesSolved}  ms(solved)=${msSolved}  nodes/solve=${solved ? Math.round(nodesSolved / solved) : 0}`,
);
