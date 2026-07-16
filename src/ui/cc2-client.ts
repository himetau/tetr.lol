// Main-thread client for the Cold Clear 2 analysis worker.

import type { PieceType } from '../core/pieces';
import type { CC2Move } from '../engine/cc2-worker';

export type { CC2Move };

/** Drop moves that place the exact same cells (CC can list a move more than once). */
function dedupe(moves: CC2Move[]): CC2Move[] {
  const seen = new Set<string>();
  const out: CC2Move[] = [];
  for (const m of moves) {
    const key = [...m.cells].sort((a, b) => a - b).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

/** Board rows (bit x = filled at column x) → 10 column bitboards (bit y). */
function rowsToCols(rows: number[]): number[] {
  const cols = new Array<number>(10).fill(0);
  for (let y = 0; y < rows.length; y++) {
    const r = rows[y];
    for (let x = 0; x < 10; x++) if ((r >>> x) & 1) cols[x] |= 1 << y;
  }
  return cols;
}

export class ColdClearClient {
  private worker: Worker;
  private pending = new Map<number, (m: CC2Move[]) => void>();
  private nextId = 1;

  constructor() {
    this.worker = new Worker(new URL('../engine/cc2-worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<{ id: number; moves: CC2Move[] }>) => {
      const resolve = this.pending.get(e.data.id);
      if (resolve) { this.pending.delete(e.data.id); resolve(dedupe(e.data.moves)); }
    };
  }

  /** Ask the bot for its ranked candidate moves on this position (best first). */
  analyze(
    rows: number[],
    queue: PieceType[],
    hold: PieceType | null,
    b2b: boolean,
    combo: number,
    nodes = 30000,
  ): Promise<CC2Move[]> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage({
        id,
        cols: rowsToCols(rows),
        queue: queue.join(''),
        hold: hold ?? '',
        b2b,
        combo,
        nodes,
      });
    });
  }

  destroy(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}
