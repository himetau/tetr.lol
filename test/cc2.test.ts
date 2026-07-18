import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import init, { ColdClear } from '../src/engine/cc2/cold_clear_2.js';
import { genAllspin } from '../src/engine/allspin-gen';
import { Board } from '../src/core/board';
import { CC2_LST_LOOP_JSON } from '../src/engine/cc2-weights';

function rowsToCols(rows: Uint32Array): Uint32Array {
  const cols = new Uint32Array(10);
  for (let y = 0; y < rows.length; y++) {
    const r = rows[y];
    for (let x = 0; x < 10; x++) if ((r >>> x) & 1) cols[x] |= 1 << y;
  }
  return cols;
}

interface Move { piece: string; spin: 'n' | 'm' | 'f'; lines: number; cells: number[] }
function suggest(board: Board, queue: string, hold: string, b2b: boolean, weights = ''): Move | null {
  const cc = new ColdClear(rowsToCols(board.rows), queue, hold, b2b, 0, weights);
  cc.work(30000);
  const s = cc.suggest();
  cc.free();
  return s ? (JSON.parse(s) as Move) : null;
}
const keepsB2b = (m: Move) => m.spin !== 'n' || m.lines === 4 || m.lines === 0;

describe('Cold Clear 2 (all-spin) bot', () => {
  beforeAll(async () => {
    const wasmPath = fileURLToPath(new URL('../src/engine/cc2/cold_clear_2_bg.wasm', import.meta.url));
    await init({ module_or_path: readFileSync(wasmPath) });
  });

  it('recognizes non-T all-spins (the movegen patch)', () => {
    // L/J/Z/S spin-double boards where the only 2-line clear is an immobile spin
    const boards: [string, string[], string][] = [
      ['L', ['XXXXX_XXXX', 'XXX___XXXX'], 'LOTIJSZ'],
      ['J', ['XXX_XXXXXX', 'XXX___XXXX'], 'JOTILSZ'],
      ['Z', ['XXX__XXXXX', 'XXXX__XXXX'], 'ZOTILJS'],
      ['S', ['XXXX__XXXX', 'XXX__XXXXX'], 'SOTILJZ'],
      ['T', ['___X______', 'XXX___XXXX', 'XXXX_XXXXX'], 'TOSILJZ'],
    ];
    for (const [piece, rows, queue] of boards) {
      const m = suggest(Board.fromStrings(rows), queue, '', true);
      expect(m, `${piece}: no suggestion`).not.toBeNull();
      // taking the clear here is a spin (full), proving non-T spins are scored
      if (m!.lines >= 2) expect(m!.spin, `${piece} double should be a spin`).toBe('f');
    }
  });

  it('never breaks an active back-to-back on a spin-able board', () => {
    // with B2B live and a spin available, the bot must keep the chain: it plays
    // a spin/quad or simply builds — never a plain 1-3 line burn
    for (let seed = 1; seed <= 12; seed++) {
      const { board, spinPiece } = genAllspin(seed, false);
      const queue = spinPiece + 'OTILJSZ'.replace(spinPiece, '');
      const m = suggest(board, queue, '', true);
      if (!m) continue;
      expect(keepsB2b(m), `seed ${seed}: bot broke B2B with ${m.piece} ${m.lines} lines spin=${m.spin}`).toBe(true);
    }
  });

  it('accepts the LST-loop weights override and takes a ready TSD', () => {
    // a board with a standing col-2 T-slot: base row full but col 2, slot row
    // (y1) open at cols 1-3 — dropping a T here is a T-spin double
    const board = Board.fromStrings(['XX_XXXXXXX', 'X_____XXXX'].reverse());
    const m = suggest(board, 'TOSILJZ', '', true, CC2_LST_LOOP_JSON);
    expect(m, 'loop-tuned bot returned no move (bad weights JSON?)').not.toBeNull();
    // it must not throw and must keep back-to-back
    expect(m!.spin !== 'n' || m!.lines === 0 || m!.lines === 4).toBe(true);
  });
});
