// Main-thread client for the analysis worker.

import type { LockEvent } from "../core/game";
import type { PieceType } from "../core/pieces";
import type { SpinKind } from "../core/spin";
import type { GradeRequest, GradeResult } from "../engine/grade";

export interface SolvedLineMove {
  piece: PieceType;
  cells: [number, number][];
  spin: SpinKind;
}

const SOLVE_CACHE_KEY = "lst-solve-cache";

export class EngineClient {
  private worker: Worker;
  private nextId = 1;
  private latestWanted = 0;
  private nextSolveId = 1;
  private latestSolve = 0;
  onResult: ((r: GradeResult) => void) | null = null;
  /** a background LST re-solve finished (the road ahead from a deviation) */
  onSolved: ((moves: SolvedLineMove[], solved: boolean) => void) | null = null;

  constructor() {
    this.worker = new Worker(new URL("../engine/worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (
      e: MessageEvent<{
        kind: string;
        id: number;
        result?: GradeResult;
        moves?: SolvedLineMove[];
        solved?: boolean;
        json?: string;
      }>,
    ) => {
      if (e.data.kind === "grade") {
        if (e.data.id !== this.latestWanted) {
          return; // superseded (e.g. after undo)
        }
        this.onResult?.(e.data.result!);
      } else if (e.data.kind === "solve") {
        if (e.data.id !== this.latestSolve) {
          return; // superseded by a newer re-solve
        }
        this.onSolved?.(e.data.moves ?? [], e.data.solved ?? false);
      } else if (e.data.kind === "cacheDump" && e.data.json) {
        this.persistCache(e.data.json);
      }
    };
    // seed the worker's solve cache from a prior session so repeats stay instant
    try {
      const saved = localStorage.getItem(SOLVE_CACHE_KEY);
      if (saved) {
        this.worker.postMessage({ kind: "loadCache", json: saved });
      }
    } catch {
      /* storage unavailable (private mode / SSR) - fine, in-memory still helps */
    }
  }

  /** Best-effort persist the solve cache; skip silently if it's over quota. */
  private persistCache(json: string): void {
    // localStorage is ~5MB; a big cache just isn't persisted (in-memory still works)
    if (json.length > 4_000_000) {
      return;
    }
    try {
      localStorage.setItem(SOLVE_CACHE_KEY, json);
    } catch {
      /* quota exceeded or unavailable - ignore */
    }
  }

  /** Re-plan the LST road ahead from a deviated position, off-thread. */
  solve(
    rows: number[],
    queue: PieceType[],
    hold: PieceType | null,
    target: number,
    budgetMs: number,
    allowQuad: boolean,
    szReserve = 0,
    partialHealth = false,
  ): void {
    const id = this.nextSolveId++;
    this.latestSolve = id;
    this.worker.postMessage({ kind: "solve", id, rows, queue, hold, target, budgetMs, allowQuad, szReserve, partialHealth });
  }

  /** Drop any in-flight re-solve result. */
  cancelSolve(): void {
    this.latestSolve = 0;
  }

  gradeLock(
    ev: LockEvent,
    opts: {
      lstBias?: boolean;
      neural?: boolean;
      fourwide?: boolean;
      depth?: number;
      beamWidth?: number;
      planActive?: boolean;
      userOnPlan?: boolean;
      planMove?: { piece: PieceType; cells: [number, number][] } | null;
      planPv?: { piece: PieceType; cells: [number, number][]; spin: SpinKind; lines: number }[];
    } = {},
  ): void {
    const {
      lstBias = false,
      neural = true,
      fourwide = false,
      depth = 4,
      beamWidth = 14,
      planActive = false,
      userOnPlan = false,
      planMove = null,
      planPv,
    } = opts;
    const req: GradeRequest = {
      lstBias,
      neural,
      fourwide,
      planActive,
      userOnPlan,
      planMovePiece: planMove?.piece,
      planMoveCells: planMove?.cells,
      planPv,
      rows: Array.from(ev.boardBefore.rows),
      queue: ev.queueBefore,
      hold: ev.holdBefore,
      userCells: ev.cells.map(([a, b]) => [a, b] as [number, number]),
      userPiece: ev.piece,
      userRot: ev.rot,
      userX: ev.x,
      userY: ev.y,
      userSpin: ev.spin,
      userLines: ev.linesCleared,
      usedHold: ev.usedHold,
      pieceIndex: ev.pieceIndex,
    };
    const id = this.nextId++;
    this.latestWanted = id;
    this.worker.postMessage({ kind: "grade", id, req, depth, beamWidth });
  }

  /** Drop any in-flight result (after undo/reset). */
  cancel(): void {
    this.latestWanted = 0;
  }
}
