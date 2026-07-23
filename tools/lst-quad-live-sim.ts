// Feasibility harness for the QUAD live loop at a HIGH target (goal: 100).
// Mirrors EXACTLY the live driver I'm wiring into game-view.maybeResolveOnDeviation:
//   opener -> repeat { solve a bounded window (min(remaining,10) clears, allowQuad,
//   szReserve, partialHealth); if empty, ESCALATE the budget before giving up; if
//   the line is a PARTIAL (solved=false), commit only its first CHUNK clear-cycles
//   (least poison) then re-solve; else play the whole line } until target or death.
// A "clear" in quad mode is a TSD (T full >=2) OR a well quad (I, 4 lines). This is
// the number the in-app drill will chase, so if this sustains ~100 the live wiring
// is worth it; if it caps low, quads don't rescue unpooled and we stop here.
//
//   npx tsx tools/lst-quad-live-sim.ts [nSeeds] [target] [budgetMs]
//   env: SEEDBASE (987654321)  SZFILL (150)  CHUNK (1)  WINDOW (10)

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

const N = Number(process.argv[2] ?? 3);
const TARGET = Number(process.argv[3] ?? 100);
const BUDGET = Number(process.argv[4] ?? 4000);
const SZFILL = Number(process.env.SZFILL ?? 150);
const CHUNK = Number(process.env.CHUNK ?? 1);
const WINDOW = Number(process.env.WINDOW ?? 10);

interface WasmMove {
  piece: string; cells: [number, number][]; spin: string;
  linesCleared: number; beforeKey: string; isTsd: boolean;
}
interface WasmResult { moves: WasmMove[]; tsds: number; solved: boolean; mirrored: boolean; nodes: number }
type Spin = "none" | "mini" | "full";

function wasmSolve(game: Game, target: number, budgetMs: number): WasmResult | null {
  const queue = [game.active!.type, ...game.peekQueue(target * 9 + 20)] as PieceType[];
  const out = solve(JSON.stringify({
    rows: Array.from(game.board.rows), queue, hold: game.hold, target,
    opts: { budgetMs, nodeBudget: 200_000_000, tailFree: 3, allowQuad: true, szReserve: SZFILL, partialHealth: true },
  }));
  return JSON.parse(out) as WasmResult | null;
}

interface Result { seed: number; clears: number; tsds: number; quads: number; windows: number; escalations: number; truncations: number; note: string }

function live(seed: number): Result {
  const game = new Game(seed);
  const plan = planOpener([game.active!.type, ...game.peekQueue(9)]);
  if (!plan) return { seed, clears: 0, tsds: 0, quads: 0, windows: 0, escalations: 0, truncations: 0, note: "opener miss" };
  let tsds = 0, quads = 0;
  for (const mv of plan.moves) {
    const ev = game.applyMove(mv.piece, mv.cells, mv.spin);
    if (!ev) return { seed, clears: tsds + quads, tsds, quads, windows: 0, escalations: 0, truncations: 0, note: "opener desync" };
    if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) tsds++;
  }

  let windows = 0, escalations = 0, truncations = 0, note = "reached target";
  const clears = () => tsds + quads;
  while (clears() < TARGET) {
    const wTarget = Math.min(TARGET - clears(), WINDOW);
    let res = wasmSolve(game, wTarget, BUDGET);
    windows++;
    // escalation ladder (live: retry with more time before dropping to the beam)
    for (const mult of [2, 4] as const) {
      if (res && res.moves.length > 0) break;
      escalations++;
      res = wasmSolve(game, wTarget, BUDGET * mult);
    }
    if (!res || res.moves.length === 0) { note = "window returned no line"; break; }

    // partial-truncation: commit only the first CHUNK clear-cycles of a partial
    let toPlay = res.moves;
    if (!res.solved) {
      let cut = 0, fired = 0;
      for (let i = 0; i < toPlay.length; i++) {
        const m = toPlay[i];
        const isClear = (m.piece === "T" && m.spin === "full" && m.linesCleared >= 2) || (m.piece === "I" && m.linesCleared === 4);
        if (isClear) { fired++; if (fired >= CHUNK) { cut = i + 1; break; } }
      }
      if (fired === 0) { note = "partial fires no clear"; break; }
      toPlay = toPlay.slice(0, cut || toPlay.length);
      truncations++;
    }

    let broke = "";
    for (const m of toPlay) {
      if (game.board.key() !== m.beforeKey) { broke = "replay desync"; break; }
      const ev = game.applyMove(m.piece as PieceType, m.cells, m.spin as Spin);
      if (!ev) { broke = "unreachable"; break; }
      if (ev.piece === "T" && !(ev.spin === "full" && ev.linesCleared >= 2)) { broke = "wasted T"; break; }
      if (ev.piece === "I" && ev.linesCleared > 0 && ev.linesCleared < 4) { broke = "partial I"; break; }
      if (lstHoles(game.board) > 0) { broke = "hole"; break; }
      if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) tsds++;
      else if (ev.piece === "I" && ev.linesCleared === 4) quads++;
      if (clears() >= TARGET) break;
    }
    if (broke) { note = broke; break; }
    if (game.board.maxHeight() >= 20) { note = "topped out"; break; }
  }
  return { seed, clears: clears(), tsds, quads, windows, escalations, truncations, note };
}

const rng = (() => {
  let a = Number(process.env.SEEDBASE ?? 987654321);
  return () => ((a = (a * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
})();

console.log(`lst-quad-live-sim: ${N} seeds, target ${TARGET} clears, window ${WINDOW}, budget ${BUDGET}ms, szReserve ${SZFILL}, chunk ${CHUNK}\n`);
const reached: number[] = [];
let hit = 0;
for (let i = 0; i < N; i++) {
  const seed = (rng() * 2 ** 31) | 0;
  const t0 = Date.now();
  const r = live(seed);
  reached.push(r.clears);
  if (r.clears >= TARGET) hit++;
  console.log(
    `  seed ${String(seed).padStart(10)}: ${String(r.clears).padStart(3)} clears (${r.tsds} TSD + ${r.quads} quad)  ` +
      `win=${r.windows} esc=${r.escalations} trunc=${r.truncations}  ${r.note}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`,
  );
}
reached.sort((a, b) => a - b);
const mean = reached.reduce((a, b) => a + b, 0) / N;
console.log(`\n  reached ${TARGET}: ${hit}/${N}  |  clears: min ${reached[0]}, median ${reached[N >> 1]}, mean ${mean.toFixed(1)}, max ${reached[N - 1]}`);
