// Verifies the hypothesis behind the "auto-play gets stuck" bug: does replaying
// each pooled verified line STRICTLY IN ORDER through a real Game (applyMove,
// which swaps hold as needed) reproduce the 20-TSD line with no desync? If yes,
// the live bug is purely the opportunistic/out-of-order playback in game-view
// (lstPlanNextPlayable) drifting the hold state, and strict replay is the fix.
//
//   npx tsx tools/replay-check.ts

import { Game } from "../src/core/game";
import LST_RUNS from "../src/data/lst-runs.json";
import type { PieceType } from "../src/core/pieces";

type Move = { piece: string; cells: [number, number][]; spin: string };
const runs = LST_RUNS.runs as unknown as Record<string, Move[]>;

let allOk = true;
for (const seed of Object.keys(runs)) {
  const line = runs[seed];
  const game = new Game(Number(seed));
  let tsds = 0;
  let failAt = -1;
  let reason = "";
  for (let i = 0; i < line.length; i++) {
    const m = line[i];
    const before = game.board.key();
    const ev = game.applyMove(m.piece as PieceType, m.cells, m.spin as "none" | "mini" | "full");
    if (!ev) {
      failAt = i;
      reason = `applyMove null (piece ${m.piece}, active ${game.active?.type ?? "-"}, hold ${game.hold ?? "-"})`;
      void before;
      break;
    }
    if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) tsds++;
  }
  const ok = failAt < 0 && tsds >= 20;
  allOk &&= ok;
  console.log(
    `seed ${seed}: ${ok ? "OK" : "FAIL"} — ${tsds} TSD over ${line.length} moves` +
      (failAt >= 0 ? ` | DESYNC @ move ${failAt}: ${reason}` : ""),
  );
}
console.log(allOk ? "\nALL POOL SEEDS REPLAY 20/20 STRICTLY ✓ (strict in-order is the fix)" : "\nSOME SEEDS FAIL STRICT REPLAY (pool line itself has a hold incompatibility)");
process.exit(allOk ? 0 : 1);
