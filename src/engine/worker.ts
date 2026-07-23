// Analysis worker: keeps the game thread at full frame rate while grading
// runs. One request per locked piece; superseded requests are dropped. Also
// serves off-thread LST re-solves (re-plan the road ahead after the player
// deviates from the verified line - the solver takes seconds, so it can't run
// on the game thread).

import { gradePlacement, type GradeRequest } from "./grade";
import { gradeFourwide } from "./fourwide";
import { setNeuralBlend } from "./neural";
import { solveLstRun, exportSolveCache, importSolveCache } from "./lst-solver";
import initLstWasm, { solve as solveLstWasm } from "./lst-wasm/lst_solver.js";
import { Board } from "../core/board";
import type { PieceType } from "../core/pieces";
import type { SpinKind } from "../core/spin";

// The Rust/wasm port of solveLstRun (~4-6x faster, byte-identical output; see
// rust/lst-solver + tools/rust-parity-verify.ts). Init is async and fetches the
// co-located .wasm; the TS solver stays as a fallback if it can't load.
const lstWasmReady: Promise<boolean> = initLstWasm()
  .then(() => true)
  .catch(() => false);

interface WasmSolveResult {
  moves: { piece: string; cells: [number, number][]; spin: string }[];
  solved: boolean;
}

/** Solve via the wasm port, or null if the wasm isn't available / errored. */
function trySolveWasm(msg: {
  rows: number[];
  queue: PieceType[];
  hold: PieceType | null;
  target: number;
  budgetMs: number;
  allowQuad: boolean;
  szReserve: number;
  partialHealth: boolean;
  leftOCapHorizon: number;
}): { moves: SolvedLineMove[]; solved: boolean } | null {
  try {
    const out = solveLstWasm(
      JSON.stringify({
        rows: msg.rows,
        queue: msg.queue,
        hold: msg.hold,
        target: msg.target,
        opts: {
          budgetMs: msg.budgetMs,
          nodeBudget: 200_000_000,
          tailFree: 3,
          allowQuad: msg.allowQuad,
          szReserve: msg.szReserve,
          partialHealth: msg.partialHealth,
          leftOCapHorizon: msg.leftOCapHorizon,
        },
      }),
    );
    const res = JSON.parse(out) as WasmSolveResult | null;
    if (!res || !res.moves) return null;
    return {
      moves: res.moves.map((m) => ({
        piece: m.piece as PieceType,
        cells: m.cells,
        spin: m.spin as SpinKind,
      })),
      solved: res.solved,
    };
  } catch {
    return null;
  }
}

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
      szReserve: number;
      partialHealth: boolean;
      leftOCapHorizon: number;
      // a "verify" probe (not a plan): same solve, but the result is routed back
      // as kind:"probe" so the main thread can use it only to test aliveness of a
      // solved window's end-state, without disturbing the live plan.
      probe?: boolean;
    }
  // seed the worker's solve cache from persisted storage (workers have no
  // localStorage; the main thread relays it)
  | { kind: "loadCache"; json: string };

export interface SolvedLineMove {
  piece: PieceType;
  cells: [number, number][];
  spin: SpinKind;
}

self.onmessage = async (e: MessageEvent<WorkerMsg>) => {
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
    // Prefer the wasm port; fall back to the TS solver if it isn't loaded.
    let moves: SolvedLineMove[] = [];
    let solved = false;
    const wasm = (await lstWasmReady) ? trySolveWasm(msg) : null;
    if (wasm) {
      moves = wasm.moves;
      solved = wasm.solved;
    } else {
      const board = new Board();
      for (let i = 0; i < msg.rows.length && i < board.rows.length; i++) {
        board.rows[i] = msg.rows[i];
      }
      const res = solveLstRun(board, msg.queue, msg.hold, msg.target, {
        budgetMs: msg.budgetMs,
        nodeBudget: 200_000_000,
        tailFree: 3,
        allowQuad: msg.allowQuad,
        szReserve: msg.szReserve,
        partialHealth: msg.partialHealth,
        leftOCapHorizon: msg.leftOCapHorizon,
      });
      moves = res ? res.moves.map((m) => ({ piece: m.piece, cells: m.cells, spin: m.spin })) : [];
      solved = res?.solved ?? false;
    }
    (self as unknown as Worker).postMessage({ kind: msg.probe ? "probe" : "solve", id: msg.id, moves, solved });
    // hand the updated cache back so the main thread can persist it
    (self as unknown as Worker).postMessage({ kind: "cacheDump", json: exportSolveCache() });
  } else if (msg.kind === "loadCache") {
    importSolveCache(msg.json);
  }
};
