import { describe, it, expect } from 'vitest';
import { Board } from '../src/core/board';
import { gradePlacement } from '../src/engine/grade';
import { breaksB2b } from '../src/engine/search';

// Loop-alive board where a plain burn is actually possible without touching
// the spin column: base row complete, slot row complete outside cols 1-3,
// and a third row needing only column 9.
//   row2  XXXXXXXXX_
//   row1  X___XXXXXX
//   row0  XX_XXXXXXX
const LOOP_WITH_BURNABLE_ROW = [
  'XXXXXXXXX_',
  'X___XXXXXX',
  'XX_XXXXXXX',
];

describe('back-to-back preservation', () => {
  it('breaksB2b: plain 1-3 line clears break, spins and quads do not', () => {
    expect(breaksB2b(1, 'none')).toBe(true);
    expect(breaksB2b(3, 'none')).toBe(true);
    expect(breaksB2b(4, 'none')).toBe(false); // quad keeps B2B
    expect(breaksB2b(2, 'full')).toBe(false); // TSD keeps B2B
    expect(breaksB2b(1, 'mini')).toBe(false); // mini spin keeps B2B
    expect(breaksB2b(0, 'none')).toBe(false); // no clear, no break
  });

  it('grades an avoidable burn as a mistake with a B2B reason', () => {
    const rows = Array.from(Board.fromStrings(LOOP_WITH_BURNABLE_ROW).rows);
    // I piece dropped vertically into column 10 clears row 2 without a spin
    const res = gradePlacement({
      rows,
      queue: ['I', 'L', 'S', 'J', 'Z', 'O'],
      hold: null,
      userCells: [[9, 2], [9, 3], [9, 4], [9, 5]],
      userPiece: 'I',
      userRot: 1,
      userX: 9,
      userY: 3,
      userSpin: 'none',
      userLines: 1,
      usedHold: false,
      pieceIndex: 7,
      lstBias: true,
    }, { depth: 2, beamWidth: 6 });
    expect(['mistake', 'killer']).toContain(res.grade);
    expect(res.reasons.join(' ')).toMatch(/back-to-back/i);
  });

  it('never recommends a B2B-breaking move while the loop is alive', () => {
    const rows = Array.from(Board.fromStrings(LOOP_WITH_BURNABLE_ROW).rows);
    const res = gradePlacement({
      rows,
      queue: ['I', 'L', 'S', 'J', 'Z', 'O'],
      hold: null,
      userCells: [[9, 2], [9, 3], [9, 4], [9, 5]],
      userPiece: 'I',
      userRot: 1,
      userX: 9,
      userY: 3,
      userSpin: 'none',
      userLines: 1,
      usedHold: false,
      pieceIndex: 7,
      lstBias: true,
    }, { depth: 2, beamWidth: 6 });
    const top = res.alts[0];
    expect(breaksB2b(top.linesCleared, top.spin)).toBe(false);
  });

  it('a clean verdict carries no scolding reasons', () => {
    // the ready-TSD board from engine.test.ts: taking the TSD is best
    const rows = Array.from(Board.fromStrings([
      'XX________',
      'X___XXXXXX',
      'XX_XXXXXXX',
    ]).rows);
    const res = gradePlacement({
      rows,
      queue: ['T', 'L', 'S', 'J', 'Z', 'O'],
      hold: null,
      userCells: [[1, 1], [2, 1], [3, 1], [2, 0]],
      userPiece: 'T',
      userRot: 2,
      userX: 2,
      userY: 1,
      userSpin: 'full',
      userLines: 2,
      usedHold: false,
      pieceIndex: 0,
    }, { depth: 2, beamWidth: 6 });
    expect(res.grade).toBe('best');
    for (const r of res.reasons) expect(r).toMatch(/^Book/);
  });
});
