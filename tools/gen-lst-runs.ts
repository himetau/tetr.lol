// Precompute verified 20-TSD LST runs for the drill's demo seeds.
//
// For each candidate seed: plan the TKI opener, hand the position to the
// perfect-fill solver with a generous offline budget, replay the whole line
// through a real Game enforcing every goal rule, and keep only seeds whose
// replay reaches the full TSD target cleanly. The app ships the resulting
// src/data/lst-runs.json and picks its random drill seeds from it, so the
// "watch book" demo always has a proven 20-TSD line to play - the solver
// stays for pinned seeds and mid-run deviations.
//
// Not every seed is winnable: the goal forbids every clear except the TSDs
// themselves, so each bag nets +8 cells and the stack must finish around
// row 16 - a seed whose 20th T sits late in its bag needs the stack above
// the spawn ceiling before the final fire (volume theory), and checkerboard
// parity (only the T is parity-odd) rules out others. Solver failures here
// are usually the seed's fault, not the search's.
//
// Run: npx tsx tools/gen-lst-runs.ts [maxSeeds] [firstSeed] [lastSeed]

import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Game } from "../src/core/game";
import { planOpener } from "../src/engine/opener";
import { solveLstRun } from "../src/engine/lst-solver";

const TARGET = 20;
const maxSeeds = Number(process.argv[2] ?? 12);
const first = Number(process.argv[3] ?? 1);
const last = Number(process.argv[4] ?? 400);

interface RunMove {
  piece: string;
  cells: [number, number][];
  spin: string;
}

const runs: Record<string, RunMove[]> = {};

for (let seed = first; seed <= last && Object.keys(runs).length < maxSeeds; seed++) {
  const game = new Game(seed);
  const plan = planOpener([game.active!.type, ...game.peekQueue(9)]);
  if (!plan) {
    console.log(`seed ${seed}: no opener plan`);
    continue;
  }
  const line: RunMove[] = [];
  let tsds = 0;
  let bad = "";
  for (const mv of plan.moves) {
    const ev = game.applyMove(mv.piece, mv.cells, mv.spin);
    if (!ev) {
      bad = "opener unreachable";
      break;
    }
    line.push({ piece: mv.piece, cells: mv.cells, spin: mv.spin });
    if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) {
      tsds++;
    }
  }
  if (bad || tsds === 0) {
    console.log(`seed ${seed}: opener failed (${bad || "no TSD"})`);
    continue;
  }

  const queue = [game.active!.type, ...game.peekQueue(TARGET * 8 + 14)];
  const t0 = Date.now();
  const res = solveLstRun(game.board, queue, game.hold, TARGET - tsds, {
    budgetMs: 90000,
    nodeBudget: 40_000_000,
    tailFree: 3,
  });
  const ms = Date.now() - t0;
  if (!res || !res.solved) {
    console.log(`seed ${seed}: unsolved (${res ? res.tsds + tsds : 0}/${TARGET}, ${ms}ms)`);
    continue;
  }

  // replay through the real game, enforcing every goal rule
  let violation = "";
  for (const m of res.moves) {
    if (game.board.key() !== m.beforeKey) {
      violation = "desync";
      break;
    }
    const ev = game.applyMove(m.piece, m.cells, m.spin);
    if (!ev) {
      violation = `unreachable ${m.piece}`;
      break;
    }
    if (ev.piece === "T" && !(ev.spin === "full" && ev.linesCleared >= 2)) {
      violation = "wasted T";
      break;
    }
    if (ev.piece === "I" && ev.linesCleared > 0) {
      violation = "I spent";
      break;
    }
    if (ev.linesCleared > 0 && ev.linesCleared < 4 && ev.spin === "none") {
      violation = "B2B break";
      break;
    }
    line.push({
      piece: m.piece,
      cells: m.cells.map(([a, b]) => [a, b] as [number, number]),
      spin: m.spin,
    });
    if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) {
      tsds++;
    }
  }
  if (violation || tsds < TARGET) {
    console.log(`seed ${seed}: replay failed (${violation || tsds + " TSDs"})`);
    continue;
  }
  runs[String(seed)] = line;
  console.log(`seed ${seed}: VERIFIED ${tsds} TSDs, ${line.length} moves, ${ms}ms`);
}

const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(
  join(here, "..", "src", "data", "lst-runs.json"),
  JSON.stringify({
    target: TARGET,
    note: "Verified 20-TSD watch-book lines per seed (tools/gen-lst-runs.ts); every move replays goal-legally from a fresh Game(seed).",
    runs,
  }),
);
console.log(`\nwrote ${Object.keys(runs).length} verified runs to src/data/lst-runs.json`);
