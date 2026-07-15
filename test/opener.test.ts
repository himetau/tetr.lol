import { describe, it, expect } from 'vitest';
import { matchOpener, TKI_TARGETS, lstStartBoard, type OpenerPlacement } from '../src/engine/opener';

// TKI flat-top "Basic Shape" placements (four.lol):
//   L__ZZ_S___
//   L___ZZSSOO
//   LL_IIIISOO
const L: OpenerPlacement = { piece: 'L', cells: [[0, 2], [0, 1], [0, 0], [1, 0]] };
const I: OpenerPlacement = { piece: 'I', cells: [[3, 0], [4, 0], [5, 0], [6, 0]] };
const Z: OpenerPlacement = { piece: 'Z', cells: [[3, 2], [4, 2], [4, 1], [5, 1]] };
const S: OpenerPlacement = { piece: 'S', cells: [[6, 2], [6, 1], [7, 1], [7, 0]] };
const O: OpenerPlacement = { piece: 'O', cells: [[8, 1], [9, 1], [8, 0], [9, 0]] };
const T: OpenerPlacement = { piece: 'T', cells: [[1, 1], [2, 1], [3, 1], [2, 0]] };

describe('TKI opener book', () => {
  it('loads exact-decomposition targets', () => {
    expect(TKI_TARGETS.length).toBeGreaterThanOrEqual(5);
  });

  it('accepts the flat-top build piece by piece, in any order', () => {
    const seqs = [
      [L, I, Z, S, O, T],
      [I, L, O, S, Z, T],
    ];
    for (const seq of seqs) {
      for (let n = 1; n <= seq.length; n++) {
        const res = matchOpener(seq.slice(0, n));
        expect(res.ok, `${seq.slice(0, n).map((p) => p.piece).join(',')}`).toBe(true);
      }
    }
  });

  it('rejects a piece inside the footprint but off the decomposition', () => {
    // S flat at spawn covers I/Z cells of the target — footprint-subset but wrong
    const badS: OpenerPlacement = { piece: 'S', cells: [[3, 0], [4, 0], [4, 1], [5, 1]] };
    expect(matchOpener([badS]).ok).toBe(false);
  });

  it('rejects a misplaced O', () => {
    const badO: OpenerPlacement = { piece: 'O', cells: [[4, 0], [5, 0], [4, 1], [5, 1]] };
    expect(matchOpener([badO]).ok).toBe(false);
  });

  it('provides the LST start board', () => {
    const b = lstStartBoard();
    expect(b.filled(0, 0)).toBe(true);
    expect(b.filled(1, 0)).toBe(false);
    expect(b.filled(2, 0)).toBe(false);
    expect(b.filled(5, 0)).toBe(false);
    expect(b.filled(7, 1)).toBe(true);
  });
});
