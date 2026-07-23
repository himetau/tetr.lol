// Definitive parity gate: solve with the RUST/WASM solver, then replay the line
// through a fresh real Game with every LST goal rule (harvest-core's oracle) --
// no wasted T, no partial-I clear, no B2B break, no hole, correct beforeKey.
// Proves the wasm solver produces goal-legal runs, the "verify identically"
// requirement, not just output equal to the TS solver.
//
//   npx tsx tools/rust-parity-verify.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Game } from "../src/core/game";
import { planOpener } from "../src/engine/opener";
import { lstHoles } from "../src/engine/eval";
import type { PieceType } from "../src/core/pieces";
import { initSync, solve } from "../wasm/lst_solver.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
initSync({ module: readFileSync(join(root, "wasm/lst_solver_bg.wasm")) });

interface WasmMove {
  piece: string;
  cells: [number, number][];
  spin: string;
  linesCleared: number;
  beforeKey: string;
  isTsd: boolean;
}
interface WasmResult {
  moves: WasmMove[];
  tsds: number;
  solved: boolean;
  mirrored: boolean;
  nodes: number;
}

function wasmSolve(
  rows: number[],
  queue: PieceType[],
  hold: PieceType | null,
  target: number,
  opts: object,
): WasmResult | null {
  const out = solve(JSON.stringify({ rows, queue, hold, target, opts }));
  return JSON.parse(out) as WasmResult | null;
}

// harvestSeed, but the solve is the wasm port; returns the verified stat or a reason.
function verifySeed(seed: number, target: number, budgetMs: number, allowQuad: boolean) {
  const game = new Game(seed);
  const plan = planOpener([game.active!.type, ...game.peekQueue(9)]);
  if (!plan) return { ok: false, reason: "no opener plan" };
  let tsds = 0;
  for (const mv of plan.moves) {
    const ev = game.applyMove(mv.piece, mv.cells, mv.spin);
    if (!ev) return { ok: false, reason: "opener move failed" };
    if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) tsds++;
  }
  if (tsds === 0) return { ok: false, reason: "opener fired no TSD" };

  const queue = [game.active!.type, ...game.peekQueue(target * 9 + 20)] as PieceType[];
  const rows = Array.from(game.board.rows);
  const t0 = Date.now();
  const res = wasmSolve(rows, queue, game.hold, target - tsds, {
    budgetMs,
    nodeBudget: 200_000_000,
    tailFree: 3,
    allowQuad,
  });
  const solveMs = Date.now() - t0;
  if (!res || res.moves.length === 0) return { ok: false, reason: "wasm returned no line" };

  let quads = 0;
  for (const m of res.moves) {
    if (game.board.key() !== m.beforeKey) return { ok: false, reason: "beforeKey desync" };
    const ev = game.applyMove(m.piece as PieceType, m.cells, m.spin as "none" | "mini" | "full");
    if (!ev) return { ok: false, reason: "unreachable placement" };
    if (ev.piece === "T" && !(ev.spin === "full" && ev.linesCleared >= 2))
      return { ok: false, reason: "wasted T" };
    if (ev.piece === "I" && ev.linesCleared > 0 && ev.linesCleared < 4)
      return { ok: false, reason: "partial I clear" };
    if (ev.linesCleared > 0 && ev.linesCleared < 4 && ev.spin === "none")
      return { ok: false, reason: "B2B break" };
    if (lstHoles(game.board) > 0) return { ok: false, reason: "hole" };
    if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) tsds++;
    else if (ev.piece === "I" && ev.linesCleared === 4) quads++;
  }
  return {
    ok: true,
    clears: tsds + quads,
    tsds,
    quads,
    solved: res.solved,
    nodes: res.nodes,
    solveMs,
  };
}

const cases: [number, number, boolean][] = [
  [10, 20, false],
  [165, 20, false],
];

let allOk = true;
for (const [seed, target, allowQuad] of cases) {
  const r = verifySeed(seed, target, 180000, allowQuad);
  if (r.ok) {
    console.log(
      `seed ${seed}: VERIFIED goal-legal — ${r.clears} clears (${r.tsds} TSD + ${r.quads} quad), ` +
        `solved=${r.solved}, ${r.nodes} nodes, wasm ${r.solveMs}ms`,
    );
    if (r.clears! < target) allOk = false;
  } else {
    console.log(`seed ${seed}: FAILED — ${r.reason}`);
    allOk = false;
  }
}
console.log(allOk ? "\nRUST/WASM RUNS VERIFY GOAL-LEGAL ✓" : "\nPARITY VERIFY FAILED");
process.exit(allOk ? 0 : 1);
