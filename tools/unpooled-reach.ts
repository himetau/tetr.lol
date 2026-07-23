// The real test: on RANDOM (unpooled) seeds, how far does a FULL-QUEUE solve
// get toward 20 clean TSDs -- vs the live drill's 10-TSD-window + beam? This
// separates "engine could reach 20 but the live path doesn't" from "this seed
// is genuinely unwinnable". Uses the wasm solver (full deterministic queue),
// then replays the line through a real Game with every goal rule.
//
//   npx tsx tools/unpooled-reach.ts [nSeeds] [budgetMs] [quad]

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Game } from "../src/core/game";
import { planOpener } from "../src/engine/opener";
import { lstHoles } from "../src/engine/eval";
import type { PieceType } from "../src/core/pieces";
import { initSync, solve as wasmSolve } from "../wasm/lst_solver.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
initSync({ module: readFileSync(join(root, "wasm/lst_solver_bg.wasm")) });

const N = Number(process.argv[2] ?? 8);
const BUDGET = Number(process.argv[3] ?? 5000);
const QUAD = process.argv[4] === "quad";
const TARGET = 20;

interface WMove {
  piece: string;
  cells: [number, number][];
  spin: string;
  beforeKey: string;
}

function solveFull(rows: number[], queue: PieceType[], hold: PieceType | null, target: number) {
  const out = wasmSolve(
    JSON.stringify({
      rows,
      queue,
      hold,
      target,
      opts: { budgetMs: BUDGET, nodeBudget: 200_000_000, tailFree: 3, allowQuad: QUAD },
    }),
  );
  return JSON.parse(out) as { moves: WMove[]; tsds: number; solved: boolean } | null;
}

// full pipeline on one seed: opener, then full-queue solve to 20, replay-verify.
function reach(seed: number): { tsds: number; quads: number; solved: boolean; note: string } {
  const game = new Game(seed);
  const plan = planOpener([game.active!.type, ...game.peekQueue(9)]);
  if (!plan) return { tsds: 0, quads: 0, solved: false, note: "no opener plan (opener miss)" };
  let tsds = 0;
  for (const mv of plan.moves) {
    const ev = game.applyMove(mv.piece, mv.cells, mv.spin);
    if (!ev) return { tsds, quads: 0, solved: false, note: "opener desync" };
    if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) tsds++;
  }
  const queue = [game.active!.type, ...game.peekQueue(TARGET * 9 + 20)] as PieceType[];
  const res = solveFull(Array.from(game.board.rows), queue, game.hold, TARGET - tsds);
  if (!res || res.moves.length === 0)
    return { tsds, quads: 0, solved: false, note: "solver found no line past the opener" };

  let quads = 0;
  for (const m of res.moves) {
    if (game.board.key() !== m.beforeKey) return { tsds, quads, solved: false, note: "replay desync" };
    const ev = game.applyMove(m.piece as PieceType, m.cells, m.spin as "none" | "mini" | "full");
    if (!ev) return { tsds, quads, solved: false, note: "unreachable placement" };
    if (ev.piece === "T" && !(ev.spin === "full" && ev.linesCleared >= 2)) break; // wasted T
    if (lstHoles(game.board) > 0) break;
    if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) tsds++;
    else if (ev.piece === "I" && ev.linesCleared === 4) quads++;
  }
  return { tsds, quads, solved: res.solved && tsds >= TARGET, note: res.solved ? "solved" : "partial" };
}

const rng = (() => {
  let a = 1234567;
  return () => ((a = (a * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
})();

console.log(`full-queue solve reach on ${N} random seeds (target ${TARGET}, quad=${QUAD}, ${BUDGET}ms):`);
let hit20 = 0;
const reached: number[] = [];
for (let i = 0; i < N; i++) {
  const seed = (rng() * 2 ** 31) | 0;
  const t0 = Date.now();
  const r = reach(seed);
  const clears = r.tsds + r.quads;
  reached.push(r.tsds);
  if (r.tsds >= TARGET) hit20++;
  console.log(
    `  seed ${String(seed).padStart(10)}: ${String(r.tsds).padStart(2)} TSD` +
      (QUAD ? ` +${r.quads}q` : "") +
      ` (${clears} clears) ${r.solved ? "SOLVED 20" : ""} — ${r.note}  [${Date.now() - t0}ms]`,
  );
}
reached.sort((a, b) => a - b);
console.log(
  `\n  reached 20 TSD: ${hit20}/${N}   |  TSD reached: min ${reached[0]}, median ${reached[N >> 1]}, max ${reached[N - 1]}`,
);
