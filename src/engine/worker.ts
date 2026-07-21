// Analysis worker: keeps the game thread at full frame rate while grading
// runs. One request per locked piece; superseded requests are dropped. Also
// serves off-thread LST re-solves (re-plan the road ahead after the player
// deviates from the verified line - the solver takes seconds, so it can't run
// on the game thread).

import { gradePlacement, type GradeRequest } from "./grade";
import { gradeFourwide } from "./fourwide";
import { setNeuralBlend } from "./neural";
import { solveLstRun, exportSolveCache, importSolveCache } from "./lst-solver";
import { Board } from "../core/board";
import type { PieceType } from "../core/pieces";
import type { SpinKind } from "../core/spin";

export type WorkerMsg =
  | { kind: "grade"; id: number; req: GradeRequest; depth: number; beamWidth: number }
  | {
      kind: "solve";
      id: number;
      rows: number[];
      queue: PieceType[];
      hold: PieceType | null;
      target: number;
      budgetMs: number;
      allowQuad: boolean;
    }
  // seed the worker's solve cache from persisted storage (workers have no
  // localStorage; the main thread relays it)
  | { kind: "loadCache"; json: string };

export interface SolvedLineMove {
  piece: PieceType;
  cells: [number, number][];
  spin: SpinKind;
}

self.onmessage = (e: MessageEvent<WorkerMsg>) => {
  const msg = e.data;
  if (msg.kind === "grade") {
    let result;
    if (msg.req.fourwide) {
      result = gradeFourwide(msg.req);
    } else {
      setNeuralBlend(msg.req.neural === false ? 0 : 1);
      result = gradePlacement(msg.req, { depth: msg.depth, beamWidth: msg.beamWidth });
    }
    (self as unknown as Worker).postMessage({ kind: "grade", id: msg.id, result });
  } else if (msg.kind === "solve") {
    const board = new Board();
    for (let i = 0; i < msg.rows.length && i < board.rows.length; i++) {
      board.rows[i] = msg.rows[i];
    }
    const res = solveLstRun(board, msg.queue, msg.hold, msg.target, {
      budgetMs: msg.budgetMs,
      nodeBudget: 200_000_000,
      tailFree: 3,
      allowQuad: msg.allowQuad,
    });
    const moves: SolvedLineMove[] = res
      ? res.moves.map((m) => ({ piece: m.piece, cells: m.cells, spin: m.spin }))
      : [];
    (self as unknown as Worker).postMessage({
      kind: "solve",
      id: msg.id,
      moves,
      solved: res?.solved ?? false,
    });
    // hand the updated cache back so the main thread can persist it
    (self as unknown as Worker).postMessage({ kind: "cacheDump", json: exportSolveCache() });
  } else if (msg.kind === "loadCache") {
    importSolveCache(msg.json);
  }
};
