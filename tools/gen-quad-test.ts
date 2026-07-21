// Tests the quad-aware solver: for each seed, plan the opener, then solve with
// allowQuad for a target ABOVE the TSD-only ceiling, replay the line through a
// real Game allowing quads, and report clears / TSDs / quads and cleanliness.
//   npx tsx tools/gen-quad-test.ts [target] [seeds...]

import { Game } from "../src/core/game";
import { planOpener } from "../src/engine/opener";
import { solveLstRun } from "../src/engine/lst-solver";
import { lstHoles } from "../src/engine/eval";

const target = Number(process.argv[2] ?? 40);
const budgetMs = Number(process.argv[3] ?? 30000);
const seeds = process.argv.slice(4).map(Number);
if (seeds.length === 0) seeds.push(10, 13, 2, 5, 7);

for (const seed of seeds) {
  const game = new Game(seed);
  const plan = planOpener([game.active!.type, ...game.peekQueue(9)]);
  if (!plan) {
    console.log(`seed ${seed}: no opener plan`);
    continue;
  }
  let tsds = 0;
  let ok = true;
  for (const mv of plan.moves) {
    const ev = game.applyMove(mv.piece, mv.cells, mv.spin);
    if (!ev) {
      ok = false;
      break;
    }
    if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) tsds++;
  }
  if (!ok || tsds === 0) {
    console.log(`seed ${seed}: opener failed`);
    continue;
  }

  const queue = [game.active!.type, ...game.peekQueue(target * 9 + 20)];
  const t0 = Date.now();
  const res = solveLstRun(game.board, queue, game.hold, target - tsds, {
    budgetMs,
    nodeBudget: 200_000_000,
    tailFree: 3,
    allowQuad: true,
  });
  const ms = Date.now() - t0;
  if (!res || res.moves.length === 0) {
    console.log(`seed ${seed}: no line (${ms}ms)`);
    continue;
  }

  // replay through a real Game, allowing quads, counting TSDs vs quads
  let quads = 0;
  let maxHoles = 0;
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
    if (ev.piece === "I" && ev.linesCleared > 0 && ev.linesCleared < 4) {
      violation = "I partial clear";
      break;
    }
    if (ev.linesCleared > 0 && ev.linesCleared < 4 && ev.spin === "none") {
      violation = "B2B break";
      break;
    }
    if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) tsds++;
    else if (ev.piece === "I" && ev.linesCleared === 4) quads++;
    maxHoles = Math.max(maxHoles, lstHoles(game.board));
  }
  console.log(
    `seed ${seed}: solved=${res.solved} clears=${tsds + quads} (TSD=${tsds} quad=${quads}) ` +
      `maxHoles=${maxHoles} ${violation ? "VIOLATION:" + violation : "clean"} ${ms}ms`,
  );
}
