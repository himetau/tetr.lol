// Shared harvest primitive: solve one seed's LST+quad line and replay-verify it
// against a real Game with every goal rule (no wasted T, no partial I clear, no
// B2B break, no hole). Used by pool-parallel (grow) and upgrade-seeds (re-solve
// existing seeds at a higher budget, keep if better). Pure module - no run-on-
// import side effects - so tools can import it safely.

import { Game } from "../src/core/game";
import { planOpener } from "../src/engine/opener";
import { solveLstRun } from "../src/engine/lst-solver";
import { lstHoles } from "../src/engine/eval";
import type { PieceType } from "../src/core/pieces";

export interface RunMove {
  piece: string;
  cells: [number, number][];
  spin: string;
}
export interface Stat {
  clears: number;
  tsds: number;
  quads: number;
}

/** Solve + replay-verify one seed. Returns the kept line or null (skip). */
export function harvestSeed(
  seed: number,
  target: number,
  budgetMs: number,
  minClears: number,
  allowQuad = true,
): { line: RunMove[]; stat: Stat } | null {
  const game = new Game(seed);
  const plan = planOpener([game.active!.type, ...game.peekQueue(9)]);
  if (!plan) return null;
  const line: RunMove[] = [];
  let tsds = 0;
  for (const mv of plan.moves) {
    const ev = game.applyMove(mv.piece, mv.cells, mv.spin);
    if (!ev) return null;
    line.push({ piece: mv.piece, cells: mv.cells, spin: mv.spin });
    if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) tsds++;
  }
  if (tsds === 0) return null;

  const queue = [game.active!.type, ...game.peekQueue(target * 9 + 20)] as PieceType[];
  const res = solveLstRun(game.board, queue, game.hold, target - tsds, {
    budgetMs,
    nodeBudget: 200_000_000,
    tailFree: 3,
    allowQuad,
  });
  if (!res || res.moves.length === 0) return null;

  let quads = 0;
  for (const m of res.moves) {
    if (game.board.key() !== m.beforeKey) return null; // desync
    const ev = game.applyMove(m.piece, m.cells, m.spin);
    if (!ev) return null; // unreachable
    if (ev.piece === "T" && !(ev.spin === "full" && ev.linesCleared >= 2)) return null; // wasted T
    if (ev.piece === "I" && ev.linesCleared > 0 && ev.linesCleared < 4) return null; // I partial
    if (ev.linesCleared > 0 && ev.linesCleared < 4 && ev.spin === "none") return null; // B2B break
    if (lstHoles(game.board) > 0) return null; // hole
    line.push({ piece: m.piece, cells: m.cells.map(([a, b]) => [a, b] as [number, number]), spin: m.spin });
    if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) tsds++;
    else if (ev.piece === "I" && ev.linesCleared === 4) quads++;
  }
  const clears = tsds + quads;
  if (clears < minClears) return null;
  return { line, stat: { clears, tsds, quads } };
}
