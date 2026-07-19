// Main-thread client for the analysis worker.

import type { LockEvent } from "../core/game";
import type { GradeRequest, GradeResult } from "../engine/grade";

export class EngineClient {
  private worker: Worker;
  private nextId = 1;
  private latestWanted = 0;
  onResult: ((r: GradeResult) => void) | null = null;

  constructor() {
    this.worker = new Worker(new URL("../engine/worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (
      e: MessageEvent<{ kind: string; id: number; result: GradeResult }>,
    ) => {
      if (e.data.kind !== "grade") {
        return;
      }
      // superseded (e.g. after undo)
      if (e.data.id !== this.latestWanted) {
        return;
      }
      this.onResult?.(e.data.result);
    };
  }

  gradeLock(
    ev: LockEvent,
    opts: {
      lstBias?: boolean;
      neural?: boolean;
      fourwide?: boolean;
      depth?: number;
      beamWidth?: number;
    } = {},
  ): void {
    const { lstBias = false, neural = true, fourwide = false, depth = 4, beamWidth = 14 } = opts;
    const req: GradeRequest = {
      lstBias,
      neural,
      fourwide,
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
