// End-to-end benchmark for the LST drill's 20-TSD goal: play the TKI opener
// from the book exactly like the app's watch-book does, then hand the
// position to the perfect-fill solver for the remaining TSDs, then REPLAY
// the solved line through a real Game and check every goal rule (every T a
// full TSD, no B2B break, no I spent on a clear).
//
// Run: npx tsx tools/lst-solve-bench.ts [firstSeed] [lastSeed] [target]

import { Game } from "../src/core/game";
import { planOpener } from "../src/engine/opener";
import { solveLstRun } from "../src/engine/lst-solver";

const first = Number(process.argv[2] ?? 1);
const last = Number(process.argv[3] ?? 20);
const target = Number(process.argv[4] ?? 20);

let solvedCount = 0;
for (let seed = first; seed <= last; seed++) {
  const game = new Game(seed);
  let tsds = 0;
  let openerFail = "";

  // opener phase: the planned TKI build, finishing on the first TSD
  const plan = planOpener([game.active!.type, ...game.peekQueue(9)]);
  if (!plan) {
    console.log(`seed ${seed}: OPENER FAILED (no plan)`);
    continue;
  }
  for (const mv of plan.moves) {
    const ev = game.applyMove(mv.piece, mv.cells, mv.spin);
    if (!ev) {
      openerFail = `opener move unreachable: ${mv.piece}`;
      break;
    }
    if (ev.piece === "T" && ev.linesCleared >= 2) {
      tsds++;
    }
  }
  if (openerFail || tsds === 0) {
    console.log(`seed ${seed}: OPENER FAILED (${openerFail || "no TSD"})`);
    continue;
  }

  // solver phase
  const queue = [game.active!.type, ...game.peekQueue(target * 8 + 14)];
  const t0 = Date.now();
  const res = solveLstRun(game.board, queue, game.hold, target - tsds, { budgetMs: 75000, tailFree: 3 });
  const ms = Date.now() - t0;
  if (!res) {
    console.log(`seed ${seed}: post-opener position has no LST site`);
    continue;
  }

  // replay the line through the real game, enforcing every goal rule
  let violation = "";
  for (const m of res.moves) {
    if (game.board.key() !== m.beforeKey) {
      violation = "desync: board differs from plan expectation";
      break;
    }
    const ev = game.applyMove(m.piece, m.cells, m.spin);
    if (!ev) {
      violation = `move unreachable: ${m.piece}`;
      break;
    }
    if (ev.piece === "T" && !(ev.spin === "full" && ev.linesCleared >= 2)) {
      violation = "wasted T";
      break;
    }
    if (ev.piece === "I" && ev.linesCleared > 0) {
      violation = "I spent on a clear";
      break;
    }
    if (ev.linesCleared > 0 && ev.linesCleared < 4 && ev.spin === "none") {
      violation = "B2B break";
      break;
    }
    if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) {
      tsds++;
    }
  }

  const ok = !violation && tsds >= target;
  if (ok) {
    solvedCount++;
  }
  console.log(
    `seed ${seed}: ${ok ? "SOLVED" : "partial"} ${tsds}/${target} TSDs ` +
      `(opener 1 + solver ${res.tsds}), ${res.moves.length} moves, ${res.nodes} nodes, ${ms}ms` +
      `${res.mirrored ? ", mirrored" : ""}${violation ? `, VIOLATION: ${violation}` : ""}`,
  );
}
console.log(`\n${solvedCount}/${last - first + 1} seeds reached ${target} TSDs cleanly`);
