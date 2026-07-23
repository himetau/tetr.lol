// Safety check: does the S/Z-reserve toll hurt the OFFLINE full-queue solve
// (the pool-generation path that must keep reaching 20)? Full-queue solve on a
// few random seeds, TS solver, szFill 0 vs SZFILL. Reports TSDs reached + nodes.
//   SZFILL=150 npx tsx tools/lst-fullq-ab.ts [nSeeds] [budgetMs]
import { Game } from "../src/core/game";
import { planOpener } from "../src/engine/opener";
import { lstHoles } from "../src/engine/eval";
import { solveLstRun, clearSolveCache } from "../src/engine/lst-solver";
import type { PieceType } from "../src/core/pieces";

const N = Number(process.argv[2] ?? 6);
const BUDGET = Number(process.argv[3] ?? 8000);
const TARGET = 20;

function reach(seed: number, szReserve: number): { tsds: number; nodes: number; solved: boolean } {
  clearSolveCache();
  const game = new Game(seed);
  const plan = planOpener([game.active!.type, ...game.peekQueue(9)]);
  if (!plan) return { tsds: 0, nodes: 0, solved: false };
  let tsds = 0;
  for (const mv of plan.moves) {
    const ev = game.applyMove(mv.piece, mv.cells, mv.spin);
    if (!ev) return { tsds, nodes: 0, solved: false };
    if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) tsds++;
  }
  const queue = [game.active!.type, ...game.peekQueue(TARGET * 9 + 20)] as PieceType[];
  const res = solveLstRun(game.board, queue, game.hold, TARGET - tsds, { budgetMs: BUDGET, szReserve });
  if (!res || res.moves.length === 0) return { tsds, nodes: res?.nodes ?? 0, solved: false };
  for (const m of res.moves) {
    if (game.board.key() !== m.beforeKey) break;
    const ev = game.applyMove(m.piece, m.cells, m.spin);
    if (!ev) break;
    if (ev.piece === "T" && !(ev.spin === "full" && ev.linesCleared >= 2)) break;
    if (lstHoles(game.board) > 0) break;
    if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) tsds++;
  }
  return { tsds, nodes: res.nodes, solved: res.solved && tsds >= TARGET };
}

const rng = (() => {
  let a = Number(process.env.SEEDBASE ?? 555111);
  return () => ((a = (a * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
})();
const toll = Number(process.env.SZFILL ?? 150);
console.log(`full-queue A/B on ${N} seeds (target 20, ${BUDGET}ms): control vs szFill=${toll}`);
let c20 = 0, t20 = 0;
const cR: number[] = [], tR: number[] = [];
for (let i = 0; i < N; i++) {
  const seed = (rng() * 2 ** 31) | 0;
  const c = reach(seed, 0);
  const t = reach(seed, toll);
  cR.push(c.tsds); tR.push(t.tsds);
  if (c.solved) c20++;
  if (t.solved) t20++;
  console.log(
    `  seed ${String(seed).padStart(10)}: control ${String(c.tsds).padStart(2)} (${c.nodes}n)${c.solved ? " SOLVED" : ""}` +
      `  |  szFill ${String(t.tsds).padStart(2)} (${t.nodes}n)${t.solved ? " SOLVED" : ""}`,
  );
}
const mean = (a: number[]) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
console.log(`\n  control: solved ${c20}/${N}, mean TSD ${mean(cR)}  |  szFill=${toll}: solved ${t20}/${N}, mean TSD ${mean(tR)}`);
