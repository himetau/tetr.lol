import { describe, it, expect } from 'vitest';
import { Board } from '../src/core/board';
import { enumeratePlacements } from '../src/engine/enumerate';
import { evaluateBoard, findTSlots, findLstSite } from '../src/engine/eval';
import { gradePlacement } from '../src/engine/grade';
import type { PieceType } from '../src/core/pieces';

describe('enumeratePlacements', () => {
  it('finds all placements on an empty board', () => {
    const b = new Board();
    // Known counts for an empty 10-wide board (distinct resulting cell sets):
    // O: 9 columns; I: 7 horizontal + 10 vertical = 17;
    // S/Z: 8 horizontal + 9 vertical = 17; T/J/L: 4 rots = 9+8+9+8 = 34.
    const counts: Record<PieceType, number> = { O: 9, I: 17, S: 17, Z: 17, T: 34, J: 34, L: 34 };
    for (const [type, expected] of Object.entries(counts)) {
      const res = enumeratePlacements(b, type as PieceType);
      expect(res.length, `piece ${type}`).toBe(expected);
    }
  });

  it('finds the TSD spin placement under an overhang', () => {
    const b = Board.fromStrings([
      'XX________',
      'X___XXXXXX',
      'XX_XXXXXXX',
    ]);
    const res = enumeratePlacements(b, 'T');
    const tsd = res.find((p) => p.spin === 'full' && p.linesCleared === 2);
    expect(tsd).toBeDefined();
    expect(tsd!.rot).toBe(2);
  });

  it('placements report cleared lines', () => {
    const b = Board.fromStrings(['XXXXXX____']);
    const res = enumeratePlacements(b, 'I');
    const clearing = res.find((p) => p.linesCleared === 1);
    expect(clearing).toBeDefined();
  });
});

describe('eval', () => {
  it('finds a structural T-slot', () => {
    const b = Board.fromStrings([
      'XX________',
      'X___XXXXXX',
      'XX_XXXXXXX',
    ]);
    const slots = findTSlots(b);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.some((s) => s.clears2)).toBe(true);
  });

  it('penalizes holes', () => {
    const clean = Board.fromStrings(['XXXX______']);
    const holey = Board.fromStrings(['XXXX______', 'XX_X______']);
    expect(evaluateBoard(holey).score).toBeLessThan(evaluateBoard(clean).score);
  });

  it('in LST mode a roofed notch away from the spin column is damage, not a slot', () => {
    // same notch shape at col 2 (canon) vs col 6 (junk)
    const canon = Board.fromStrings([
      'XX________',
      'X___XXXXXX',
      'XX_XXXXXXX',
    ]);
    const junk = Board.fromStrings([
      '______XX__',
      'XXXXX___XX',
      'XXXXXX_XXX',
    ]);
    expect(evaluateBoard(canon, true).b.tslots).toBeGreaterThan(0);
    expect(evaluateBoard(junk, true).b.tslots).toBe(0);
    // junk notch cells count as holes in LST mode
    expect(evaluateBoard(junk, true).b.holes).toBeGreaterThan(0);
  });

  it('detects the T-slot only when it has a roof', () => {
    const slotBoard = Board.fromStrings([
      'XX________',
      'X___XXXXXX',
      'XX_XXXXXXX',
    ]);
    const openNotch = Board.fromStrings([
      'XXX_XXXXXX',
      'XXX_XXXXXX',
    ]);
    expect(evaluateBoard(slotBoard).b.tslots).toBeGreaterThan(0);
    expect(evaluateBoard(openNotch).b.tslots).toBe(0);
  });
});

describe('findLstSite (loop viability)', () => {
  it('post-TKI start board has a viable site at the bottom', () => {
    const b = Board.fromStrings(['_______X__', 'X__XX_XXXX']);
    const site = findLstSite(b);
    expect(site).not.toBeNull();
    expect(site!.y).toBe(0);
  });

  it('canonical mid-build state stays alive with roof ready', () => {
    // base row complete, ZZ overhang up (four.lol 2nd-TSD shape): the roof
    // over col 3 is in place and only the slot row needs completion
    const b = Board.fromStrings([
      '___XX_____',
      '____XX_X__',
      'XX_XXXXXXX',
    ]);
    const site = findLstSite(b);
    expect(site).not.toBeNull();
    expect(site!.y).toBe(0);
    expect(site!.roofReady).toBe(true); // (3, y+2) filled by the overhang
  });

  it('covering an unfilled base cell prematurely blocks the site', () => {
    // Z overhang dropped while (5,0) is still empty: the covered completion
    // cell can never be filled, so the bottom site is not viable
    const b = Board.fromStrings([
      '___XX_____',
      '____XX_X__',
      'X__XX_XXXX',
    ]);
    const site = findLstSite(b);
    // site may move up, but never sit at the broken bottom rows
    expect(site?.y ?? 99).toBeGreaterThan(0);
  });

  it('any filled cell in the spin column kills the loop', () => {
    const b = Board.fromStrings(['_______X__', 'X_XXX_XXXX']);
    expect(findLstSite(b)).toBeNull();
  });
});

describe('gradePlacement', () => {
  it('grades the TSD as best and a slot-burying move as worse', () => {
    const rows = Array.from(
      Board.fromStrings([
        'XX________',
        'X___XXXXXX',
        'XX_XXXXXXX',
      ]).rows,
    );
    // user performs the TSD (T rot2 at x=2,y=1)
    const tsdCells: [number, number][] = [[1, 1], [2, 1], [3, 1], [2, 0]];
    const good = gradePlacement({
      rows,
      queue: ['T', 'L', 'S', 'J', 'Z', 'O'],
      hold: null,
      userCells: tsdCells,
      userPiece: 'T',
      userRot: 2,
      userX: 2,
      userY: 1,
      userSpin: 'full',
      userLines: 2,
      usedHold: false,
      pieceIndex: 0,
    }, { depth: 2, beamWidth: 6 });
    expect(good.grade).toBe('best');
    expect(good.userRank).toBe(0);

    // user instead slams the T flat on top of the slot area (rot 0 on the surface)
    const bad = gradePlacement({
      rows,
      queue: ['T', 'L', 'S', 'J', 'Z', 'O'],
      hold: null,
      userCells: [[5, 2], [6, 2], [7, 2], [6, 3]],
      userPiece: 'T',
      userRot: 0,
      userX: 6,
      userY: 2,
      userSpin: 'none',
      userLines: 0,
      usedHold: false,
      pieceIndex: 0,
    }, { depth: 2, beamWidth: 6 });
    expect(['inaccuracy', 'mistake', 'killer']).toContain(bad.grade);
    expect(bad.gap).toBeGreaterThan(100);
  });

  it('flags hole creation with a reason', () => {
    const rows = Array.from(Board.fromStrings(['___XXXXXXX']).rows);
    // S piece laid flat creating a hole on purpose... use O placed to bridge a gap
    // Simpler: L piece placed so it covers an empty cell.
    // L rot 2 at x=1,y=1: cells (0,1),(1,1),(2,1),(2,0)? L rot2 rel: (-1,0),(0,0),(1,0),(-1,-1)?
    // Use direct known-bad: O at columns 2-3 on top of X at col 3 only -> hole at (2,0).
    const res = gradePlacement({
      rows,
      queue: ['O', 'I', 'T', 'L', 'J', 'S'],
      hold: null,
      userCells: [[2, 1], [3, 1], [2, 2], [3, 2]],
      userPiece: 'O',
      userRot: 0,
      userX: 2,
      userY: 1,
      userSpin: 'none',
      userLines: 0,
      usedHold: false,
      pieceIndex: 0,
    }, { depth: 2, beamWidth: 6 });
    expect(res.reasons.join(' ')).toMatch(/hole/i);
    // structural floor: creating a hole can never grade better than mistake
    expect(['mistake', 'killer']).toContain(res.grade);
  });

  it('wasting the T while a TSD is ready floors the grade at mistake', () => {
    const rows = Array.from(Board.fromStrings([
      'XX________',
      'X___XXXXXX',
      'XX_XXXXXXX',
    ]).rows);
    // T laid flat on the right surface instead of spinning into the ready slot
    const res = gradePlacement({
      rows,
      queue: ['T', 'L', 'S', 'J', 'Z', 'O'],
      hold: null,
      userCells: [[5, 2], [6, 2], [7, 2], [6, 3]],
      userPiece: 'T',
      userRot: 0,
      userX: 6,
      userY: 2,
      userSpin: 'none',
      userLines: 0,
      usedHold: false,
      pieceIndex: 0,
    }, { depth: 2, beamWidth: 6 });
    expect(['mistake', 'killer']).toContain(res.grade);
    expect(res.reasons.join(' ')).toMatch(/wasted the t/i);
  });

  it('plugging the LST spin column floors the grade at mistake', () => {
    // post-TSD LST board: column 2 open, everything else filled at row 0
    const rows = Array.from(Board.fromStrings([
      '_______X__',
      'X__XX_XXXX',
    ]).rows);
    // O dropped into columns 1-2 plugs the spin column
    const res = gradePlacement({
      rows,
      queue: ['O', 'L', 'S', 'J', 'Z', 'T'],
      hold: null,
      userCells: [[1, 0], [2, 0], [1, 1], [2, 1]],
      userPiece: 'O',
      userRot: 0,
      userX: 1,
      userY: 0,
      userSpin: 'none',
      userLines: 0,
      usedHold: false,
      pieceIndex: 7,
      lstBias: true,
    }, { depth: 2, beamWidth: 6 });
    expect(['mistake', 'killer']).toContain(res.grade);
    expect(res.reasons.join(' ')).toMatch(/spin column/i);
  });

  it('prefers holding the T over spending it flat mid-build', () => {
    // LST start board, T arrives before the next slot exists: canon is to
    // hold it - a flat T placement must not grade well, and the engine's
    // top recommendation should use hold
    const rows = Array.from(Board.fromStrings(['_______X__', 'X__XX_XXXX']).rows);
    const res = gradePlacement({
      rows,
      queue: ['T', 'L', 'S', 'J', 'Z', 'O'],
      hold: null,
      userCells: [[6, 2], [7, 2], [8, 2], [7, 3]],
      userPiece: 'T',
      userRot: 0,
      userX: 7,
      userY: 2,
      userSpin: 'none',
      userLines: 0,
      usedHold: false,
      pieceIndex: 7,
      lstBias: true,
    }, { depth: 3, beamWidth: 8 });
    expect(res.grade).not.toBe('best');
    expect(res.grade).not.toBe('good');
    expect(res.alts[0].usesHold).toBe(true);
  });

  it('runs fast enough for live feedback', () => {
    const rows = Array.from(Board.fromStrings([
      'XX________',
      'X___XXXXXX',
      'XX_XXXXXXX',
    ]).rows);
    const t0 = performance.now();
    gradePlacement({
      rows,
      queue: ['L', 'S', 'J', 'Z', 'T', 'O'],
      hold: 'I',
      userCells: [[4, 3], [5, 3], [6, 3], [7, 3]],
      userPiece: 'I',
      userRot: 0,
      userX: 5,
      userY: 3,
      userSpin: 'none',
      userLines: 0,
      usedHold: true,
      pieceIndex: 3,
    });
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(450); // worker budget incl. verify pass; UI shows result async
  });
});
