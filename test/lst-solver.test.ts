// The LST drill's 20-TSD machinery: the opener planner, the perfect-fill
// solver, and the shipped verified-run lines. Everything here replays
// through a real Game so the goal rules (every T a full TSD, no I spent on
// a clear, back-to-back never broken) are checked by the same physics the
// drill runs on.

import { describe, it, expect } from "vitest";
import { Game } from "../src/core/game";
import { Board } from "../src/core/board";
import type { PieceType } from "../src/core/pieces";
import type { SpinKind } from "../src/core/spin";
import { planOpener } from "../src/engine/opener";
import { solveLstRun } from "../src/engine/lst-solver";
import LST_RUNS from "../src/data/lst-runs.json";

/** Replay a move line through a fresh Game, enforcing every goal rule.
 * Returns the TSD count. */
function replayGoalLegal(
  seed: number,
  moves: { piece: string; cells: [number, number][]; spin: string }[],
): number {
  const game = new Game(seed);
  let tsds = 0;
  for (const m of moves) {
    const ev = game.applyMove(m.piece as PieceType, m.cells, m.spin as SpinKind);
    expect(ev, `${m.piece} unreachable at piece ${game.pieceIndex}`).not.toBeNull();
    if (ev!.piece === "T") {
      expect(ev!.spin, "every T must be a full spin").toBe("full");
      expect(ev!.linesCleared, "every T must clear two").toBeGreaterThanOrEqual(2);
      tsds++;
    }
    if (ev!.piece === "I") {
      expect(ev!.linesCleared, "no I spent on a clear").toBe(0);
    }
    if (ev!.linesCleared > 0 && ev!.linesCleared < 4) {
      expect(ev!.spin, "no B2B break").not.toBe("none");
    }
  }
  return tsds;
}

describe("planOpener", () => {
  it("plans a complete TKI opener ending in a TSD for typical seeds", () => {
    for (const seed of [1, 2, 5, 10, 13]) {
      const game = new Game(seed);
      const plan = planOpener([game.active!.type, ...game.peekQueue(9)]);
      expect(plan, `seed ${seed} should have an opener plan`).not.toBeNull();
      const tsds = replayGoalLegal(seed, plan!.moves);
      expect(tsds, `seed ${seed} opener must fire the first TSD`).toBe(1);
    }
  });
});

describe("solveLstRun", () => {
  it("solves a short goal-legal continuation after the opener", () => {
    const game = new Game(10);
    const plan = planOpener([game.active!.type, ...game.peekQueue(9)])!;
    for (const mv of plan.moves) {
      game.applyMove(mv.piece, mv.cells, mv.spin);
    }
    const queue = [game.active!.type, ...game.peekQueue(40)];
    const res = solveLstRun(game.board, queue, game.hold, 3, { budgetMs: 10000 });
    expect(res).not.toBeNull();
    expect(res!.solved).toBe(true);
    expect(res!.moves.filter((m) => m.isTsd).length).toBe(3);
    // the returned line replays exactly (beforeKey matches the live board)
    for (const m of res!.moves) {
      expect(game.board.key()).toBe(m.beforeKey);
      const ev = game.applyMove(m.piece, m.cells, m.spin);
      expect(ev).not.toBeNull();
    }
  }, 20000);

  it("returns null when neither side has an LST well", () => {
    const dead = Board.fromStrings(["XXXXXXXXXX", "XXXXX_XXXX"]);
    // col 5 blocked well-less shape: neither col 2 nor mirrored col 7 works
    dead.rows[0] |= 1 << 2;
    dead.rows[0] |= 1 << 7;
    dead.rows[1] |= 1 << 2;
    dead.rows[1] |= 1 << 7;
    expect(solveLstRun(dead, ["T", "I", "O"], null, 1, { budgetMs: 500 })).toBeNull();
  });
});

describe("lst-runs.json", () => {
  const runs = LST_RUNS.runs as unknown as Record<
    string,
    { piece: string; cells: [number, number][]; spin: string }[]
  >;
  it("every shipped run replays goal-legally to the full TSD target", () => {
    for (const [seedStr, moves] of Object.entries(runs)) {
      const tsds = replayGoalLegal(Number(seedStr), moves);
      expect(tsds, `seed ${seedStr} must reach ${LST_RUNS.target} TSDs`).toBe(LST_RUNS.target);
    }
  });
});
