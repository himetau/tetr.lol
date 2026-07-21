// Goal: the paths dock must show the ENGINE's line. When a verified 20-TSD run
// drives the drill, the top path at every loop decision has to be exactly the
// move the watch-book plays (so following it reaches 20 TSDs), and its hovered
// continuation has to be the verified line - not a beam guess that diverges.
//
// The beam's own ranking put the verified move first only ~60% of the time;
// these tests pin the corrected ordering and prove the #1 path is the goal
// line. The #2 path is the best alternative and must at least keep the loop
// alive, but is NOT guaranteed to complete 20 TSDs (only the engine line is).

import { describe, it, expect } from "vitest";
import { Game } from "../src/core/game";
import { Board } from "../src/core/board";
import type { PieceType } from "../src/core/pieces";
import type { SpinKind } from "../src/core/spin";
import { gradePlacement, type GradeRequest } from "../src/engine/grade";
import { placementKey } from "../src/engine/enumerate";
import { findLstSite } from "../src/engine/eval";
import { solveLstRun } from "../src/engine/lst-solver";
import LST_RUNS from "../src/data/lst-runs.json";

type Move = { piece: string; cells: [number, number][]; spin: string };
const runs = LST_RUNS.runs as unknown as Record<string, Move[]>;
const seeds = Object.keys(runs);
const GOAL = 20;
const BOARD_W = 10;

const mirror = (b: Board): Board => {
  const o = new Board();
  for (let y = 0; y < b.rows.length; y++) {
    let m = 0;
    for (let x = 0; x < BOARD_W; x++) if ((b.rows[y] >>> x) & 1) m |= 1 << (BOARD_W - 1 - x);
    o.rows[y] = m;
  }
  return o;
};
const loopAlive = (b: Board): boolean => !!(findLstSite(b) || findLstSite(mirror(b)));
const key = (m: { piece: string; cells: [number, number][] }) => placementKey(m.piece, m.cells);

/** The verified continuation from move i+1 up to and including the next TSD -
 * what game-view feeds as the plan card's principal variation. */
function planPv(moves: Move[], i: number) {
  const pv: { piece: PieceType; cells: [number, number][]; spin: SpinKind; lines: number }[] = [];
  for (let j = i + 1; j < moves.length; j++) {
    const m = moves[j];
    const isTsd = m.piece === "T" && m.spin === "full";
    pv.push({ piece: m.piece as PieceType, cells: m.cells, spin: m.spin as SpinKind, lines: isTsd ? 2 : 0 });
    if (isTsd) break;
  }
  return pv;
}

function gradeAt(game: Game, moves: Move[], i: number) {
  const st = game.analysisState();
  const mv = moves[i];
  const req: GradeRequest = {
    lstBias: true,
    neural: false,
    planActive: true,
    userOnPlan: true,
    planMovePiece: mv.piece as PieceType,
    planMoveCells: mv.cells,
    planPv: planPv(moves, i),
    rows: st.rows,
    queue: [st.active!.type, ...st.queue],
    hold: st.hold,
    userCells: mv.cells,
    userPiece: mv.piece as PieceType,
    userRot: 0,
    userX: 0,
    userY: 0,
    userSpin: mv.spin as SpinKind,
    userLines: mv.piece === "T" ? 2 : 0,
    usedHold: st.active!.type !== (mv.piece as PieceType),
    pieceIndex: st.pieceIndex,
  };
  // the plan card is force-inserted and moved to the front independent of
  // search depth, so a cheap search suffices to pin the #1 == engine claim
  return { r: gradePlacement(req, { depth: 2, beamWidth: 6 }), rows: st.rows };
}

describe("paths dock follows the engine's 20-TSD line", () => {
  for (const seed of seeds) {
    it(`seed ${seed}: #1 path is the engine move, its PV is the verified line, #2 stays alive`, () => {
      const moves = runs[seed];
      const firstT = moves.findIndex((m) => m.piece === "T");
      const game = new Game(Number(seed));
      for (let i = 0; i < moves.length; i++) {
        if (i > firstT) {
          const { r, rows } = gradeAt(game, moves, i);
          // the top path is exactly what the watch-book plays here
          expect(r.alts.length, `dec ${i} has paths`).toBeGreaterThan(0);
          expect(key(r.alts[0]), `dec ${i}: #1 == engine move`).toBe(key(moves[i]));
          // hovering it traces the verified continuation, not a beam guess
          expect(r.alts[0].pv.map(key), `dec ${i}: #1 PV == verified line`).toEqual(
            planPv(moves, i).map(key),
          );
          // the second-best path is not an instant dead end
          if (r.alts.length >= 2) {
            const after = new Board(Uint32Array.from(rows));
            after.place(r.alts[1].cells);
            after.clearLines();
            expect(loopAlive(after), `dec ${i}: #2 (${r.alts[1].piece}) keeps a well`).toBe(true);
          }
        }
        const ev = game.applyMove(
          moves[i].piece as PieceType,
          moves[i].cells,
          moves[i].spin as SpinKind,
        );
        expect(ev, `dec ${i} replay`).not.toBeNull();
      }
    }, 30000);
  }

  it("following the #1 path reaches exactly 20 TSDs (goal-legal)", () => {
    for (const seed of seeds) {
      const game = new Game(Number(seed));
      let tsds = 0;
      for (const m of runs[seed]) {
        const ev = game.applyMove(m.piece as PieceType, m.cells, m.spin as SpinKind);
        expect(ev, `${m.piece} unreachable`).not.toBeNull();
        if (ev!.piece === "T") {
          expect(ev!.spin, "every T a full spin").toBe("full");
          expect(ev!.linesCleared, "every T clears two").toBeGreaterThanOrEqual(2);
          tsds++;
        }
        if (ev!.piece === "I") expect(ev!.linesCleared, "no I on a clear").toBe(0);
      }
      expect(tsds, `seed ${seed} reaches the goal`).toBe(GOAL);
    }
  });

  it("in the endgame the solver independently confirms the #1 path completes the goal", () => {
    for (const seed of seeds) {
      const moves = runs[seed];
      const firstT = moves.findIndex((m) => m.piece === "T");
      const banked: number[] = [];
      let n = 0;
      for (let i = 0; i < moves.length; i++) {
        banked[i] = n;
        if (moves[i].piece === "T" && moves[i].spin === "full") n++;
      }
      // last filler decision with only a few TSDs left (solver is fast there)
      let picked = -1;
      for (let i = firstT + 1; i < moves.length; i++) {
        const remaining = GOAL - banked[i];
        if (moves[i].piece !== "T" && remaining >= 2 && remaining <= 4) picked = i;
      }
      expect(picked, `seed ${seed} has an endgame filler`).toBeGreaterThan(0);

      const game = new Game(Number(seed));
      for (let i = 0; i <= picked; i++) {
        game.applyMove(moves[i].piece as PieceType, moves[i].cells, moves[i].spin as SpinKind);
      }
      const remaining = GOAL - banked[picked];
      const st = game.analysisState();
      const board = new Board(Uint32Array.from(st.rows));
      const queue = [st.active!.type, ...game.peekQueue(remaining * 9 + 30)];
      const res = solveLstRun(board, queue, st.hold, remaining, { budgetMs: 8000 });
      expect(res?.solved, `seed ${seed} engine path solves last ${remaining}`).toBe(true);
    }
  });
});
