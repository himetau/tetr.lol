// Faithful sim of the UNPOOLED live drill loop (game-view.maybeResolveOnDeviation):
// plan the opener, then repeatedly solve a bounded window (target = min(remaining,10)
// TSDs, ~110 pieces of lookahead, a live-ish budget), play the WHOLE returned plan
// through a real Game with every goal rule, and re-solve from the resulting board when
// the plan depletes. This is the "get it working on unpooled" metric - how far the
// solver alone drives an off-pool seed, and where it stalls (a window that returns a
// short partial = the fractal-then-stall the reserve policy targets).
//
//   npx tsx tools/lst-live-sim.ts [nSeeds] [budgetMs] [target]

import { Game } from "../src/core/game";
import { planOpener } from "../src/engine/opener";
import { lstHoles } from "../src/engine/eval";
import { solveLstRun, clearSolveCache } from "../src/engine/lst-solver";
import type { PieceType } from "../src/core/pieces";

// A/B knob: SZFILL=<n> sets the S/Z-reserve toll (opts.szReserve) for this run.
const SZRESERVE = Number(process.env.SZFILL ?? 0);

const N = Number(process.argv[2] ?? 8);
const BUDGET = Number(process.argv[3] ?? 2000);
const TARGET = Number(process.argv[4] ?? 20);
const WINDOW = 10; // live cap: min(remaining, 10) TSDs per solve

interface SeedResult {
  seed: number;
  tsds: number;
  windows: number; // solver windows consumed
  stallWindows: number; // windows that returned a partial (solved=false) or empty
  note: string;
}

function live(seed: number): SeedResult {
  const game = new Game(seed);
  const plan = planOpener([game.active!.type, ...game.peekQueue(9)]);
  if (!plan) return { seed, tsds: 0, windows: 0, stallWindows: 0, note: "opener miss" };
  let tsds = 0;
  for (const mv of plan.moves) {
    const ev = game.applyMove(mv.piece, mv.cells, mv.spin);
    if (!ev) return { seed, tsds, windows: 0, stallWindows: 0, note: "opener desync" };
    if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) tsds++;
  }

  let windows = 0;
  let stallWindows = 0;
  let note = "reached target";
  while (tsds < TARGET) {
    const remaining = TARGET - tsds;
    const wTarget = Math.min(remaining, WINDOW);
    const queue = [game.active!.type, ...game.peekQueue(wTarget * 9 + 20)] as PieceType[];
    const res = solveLstRun(game.board, queue, game.hold, wTarget, { budgetMs: BUDGET, szReserve: SZRESERVE });
    windows++;
    if (!res || res.moves.length === 0) {
      note = "window returned no line";
      break;
    }
    if (!res.solved) stallWindows++;

    let played = 0;
    let broke = false;
    for (const m of res.moves) {
      if (game.board.key() !== m.beforeKey) { note = "replay desync"; broke = true; break; }
      const ev = game.applyMove(m.piece, m.cells, m.spin);
      if (!ev) { note = "unreachable placement"; broke = true; break; }
      if (ev.piece === "T" && !(ev.spin === "full" && ev.linesCleared >= 2)) { note = "wasted T"; broke = true; break; }
      if (lstHoles(game.board) > 0) { note = "hole"; broke = true; break; }
      if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) tsds++;
      played++;
      if (tsds >= TARGET) break;
    }
    if (broke) break;
    if (played === 0) { note = "window made no progress"; break; }
    if (game.board.maxHeight() >= 20) { note = "topped out"; break; }
  }
  return { seed, tsds, windows, stallWindows, note };
}

const rng = (() => {
  let a = Number(process.env.SEEDBASE ?? 987654321);
  return () => ((a = (a * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
})();

console.log(`live-sim (unpooled) on ${N} seeds: target ${TARGET}, window ${WINDOW}, budget ${BUDGET}ms, szReserve=${SZRESERVE}`);
const reached: number[] = [];
let hitTarget = 0;
for (let i = 0; i < N; i++) {
  clearSolveCache();
  const seed = (rng() * 2 ** 31) | 0;
  const t0 = Date.now();
  const r = live(seed);
  reached.push(r.tsds);
  if (r.tsds >= TARGET) hitTarget++;
  console.log(
    `  seed ${String(r.seed).padStart(10)}: ${String(r.tsds).padStart(2)} TSD  ` +
      `windows=${r.windows} stalls=${r.stallWindows}  ${r.note}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`,
  );
}
reached.sort((a, b) => a - b);
const mean = reached.reduce((a, b) => a + b, 0) / N;
console.log(
  `\n  reached ${TARGET}: ${hitTarget}/${N}  |  TSD: min ${reached[0]}, median ${reached[N >> 1]}, ` +
    `mean ${mean.toFixed(1)}, max ${reached[N - 1]}`,
);
