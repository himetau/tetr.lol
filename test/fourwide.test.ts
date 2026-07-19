import { describe, it, expect } from 'vitest';
import { Board } from '../src/core/board';
import { PIECE_TYPES, type PieceType, type Rot } from '../src/core/pieces';
import type { SpinKind } from '../src/core/spin';
import { WELL_X, WELL_W, WALL_H, refillWalls, residualKey } from '../src/engine/fourwide-core';
import { stateToBoard, wallMask } from '../src/engine/fourwide-core';
import { buildFourwideStart, fourwideAdvice, gradeFourwide, bagRemainder, guaranteedDepth } from '../src/engine/fourwide';
import { enumeratePlacements } from '../src/engine/enumerate';
import type { GradeRequest } from '../src/engine/grade';
import bookData from '../src/data/fourwide.json';

type BookStates = { key: number; pattern: string[]; placements: Record<string, { piece: PieceType; cells: [number, number][]; next: number }[]> }[];
const STATES = bookData.states as unknown as BookStates;

const MIRROR: Record<string, string> = { I: 'I', O: 'O', T: 'T', S: 'Z', Z: 'S', J: 'L', L: 'J' };

function mirrorKey(key: number): number {
  let out = 0;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < WELL_W; col++) {
      if (key >>> (row * WELL_W + col) & 1) out |= 1 << (row * WELL_W + (WELL_W - 1 - col));
    }
  }
  return out;
}

function stateIndexOf(key: number): number {
  return STATES.findIndex((s) => s.key === key);
}

describe('fourwide book data', () => {
  it('has the 28 canonical states, each with continuations', () => {
    expect(STATES).toHaveLength(28);
    for (const s of STATES) {
      expect(Object.keys(s.placements).length).toBeGreaterThan(0);
      for (const arr of Object.values(s.placements)) {
        for (const p of arr) {
          expect(p.next).toBeGreaterThanOrEqual(0);
          expect(p.next).toBeLessThan(28);
        }
      }
    }
  });

  it('is mirror-symmetric (well is centered): piece counts swap J/L and S/Z', () => {
    for (const s of STATES) {
      const mi = stateIndexOf(mirrorKey(s.key));
      expect(mi).toBeGreaterThanOrEqual(0);
      const m = STATES[mi];
      for (const piece of PIECE_TYPES) {
        const a = s.placements[piece]?.length ?? 0;
        const b = m.placements[MIRROR[piece]]?.length ?? 0;
        expect(b, `state ${s.pattern.join('|')} ${piece}`).toBe(a);
      }
    }
  });

  it('every book placement clears exactly one line and lands on its next state', () => {
    for (const [i, s] of STATES.entries()) {
      const board = stateToBoard(s.key);
      for (const arr of Object.values(s.placements)) {
        for (const p of arr) {
          const after = board.clone();
          after.place(p.cells);
          expect(after.clearLines(), `state ${i}`).toHaveLength(1);
          expect(residualKey(after)).toBe(STATES[p.next].key);
        }
      }
    }
  });

  it('flat "111_" state: I continues, O cannot', () => {
    const flat = STATES.findIndex((s) => s.pattern.join('|').endsWith('|111 '));
    expect(flat).toBeGreaterThanOrEqual(0);
    expect(STATES[flat].placements['I']?.length).toBeGreaterThan(0);
    expect(STATES[flat].placements['O']).toBeUndefined();
  });
});

describe('fourwide board geometry', () => {
  it('start boards have infinite-side walls and a canonical 3-residual', () => {
    const { board } = buildFourwideStart(2);
    for (let y = 0; y < WALL_H; y++) {
      expect(board.rows[y] & wallMask()).toBe(wallMask());
    }
    expect(residualKey(board)).not.toBeNull();
    expect(board.cellCount()).toBe(WALL_H * 6 + 3);
  });

  it('refillWalls tops the side columns back up after a clear', () => {
    const { board } = buildFourwideStart(2);
    // fill the whole bottom row so it clears
    board.rows[0] = (1 << 10) - 1;
    board.clearLines();
    expect(board.rows[WALL_H - 1] & wallMask()).not.toBe(wallMask());
    refillWalls(board);
    for (let y = 0; y < WALL_H; y++) {
      expect(board.rows[y] & wallMask()).toBe(wallMask());
    }
  });

  it('pieces can never escape the well over the top of the walls', () => {
    // walls span the full board: every reachable placement stays on cols 3-6
    for (const idx of [0, 6, 18, 27]) {
      const board = stateToBoard(STATES[idx].key);
      for (const piece of PIECE_TYPES) {
        for (const p of enumeratePlacements(board, piece)) {
          for (const [x] of p.cells) {
            expect(x, `state ${idx} ${piece} at ${JSON.stringify(p.cells)}`).toBeGreaterThanOrEqual(WELL_X);
            expect(x).toBeLessThan(WELL_X + WELL_W);
          }
        }
      }
    }
  });

  it('residualKey rejects a messy well', () => {
    const { board } = buildFourwideStart(2);
    board.rows[4] |= 1 << WELL_X; // junk above row 3
    expect(residualKey(board)).toBeNull();
  });
});

describe('fourwide advice + grading', () => {
  const flatIdx = STATES.findIndex((s) => s.pattern.join('|').endsWith('|111 '));
  const flatBoard = () => stateToBoard(STATES[flatIdx].key);

  it('an all-I queue on 111_ is sustainable', () => {
    const adv = fourwideAdvice(flatBoard(), ['I', 'I', 'I', 'I', 'I'] as PieceType[], null);
    expect(adv.onBook).toBe(true);
    expect(adv.sustainable).toBe(true);
    expect(adv.moves.length).toBeGreaterThan(0);
    // full horizon (5) plus whatever the worst-case bag guarantees beyond it
    expect(adv.moves[0].score).toBeGreaterThanOrEqual(5);
    expect(adv.moves[0].score - 5).toBe(adv.guaranteedBeyond);
  });

  it('derives the 7-bag remainder from pieceIndex + queue', () => {
    const queue = ['I', 'O', 'T', 'S', 'Z', 'J'] as PieceType[];
    // 6 dealt of bag 1 -> only L left in the bag
    expect(bagRemainder(queue, 0)).toBe(64);
    // 7 dealt -> bag boundary exactly at the horizon (fresh bag next)
    expect(bagRemainder(queue, 1)).toBe(0);
    // 9 dealt -> last two previews (Z, J) opened bag 2; I,O,T,S,L remain
    expect(bagRemainder(queue, 3)).toBe(127 - 16 - 32);
  });

  it('guaranteed worst-case depth is finite and non-trivial', () => {
    // (note: an empty hold is NOT always better than a held piece - a held
    // piece can enable a rescue swap that parking cannot replicate)
    let max = 0;
    for (let s = 0; s < STATES.length; s++) {
      for (const h of [null, ...PIECE_TYPES]) {
        for (let r = 0; r < 128; r++) max = Math.max(max, guaranteedDepth(s, h, r));
      }
    }
    expect(max).toBeGreaterThanOrEqual(3); // real signal, not all zeros
    expect(max).toBeLessThan(63);          // and no adversarially immortal node
  });

  it('ranks equal-horizon continuations by their beyond-horizon prospects', () => {
    // queue of a lone I on 111_: horizontal I keeps the flat state, vertical I
    // builds the col-3 tower; the flat landing must rank first
    const adv = fourwideAdvice(flatBoard(), ['I'] as PieceType[], null, 0);
    const iMoves = adv.moves.filter((m) => m.piece === 'I' && !m.usesHold);
    expect(iMoves.length).toBe(2);
    expect(iMoves[0].next).toBe(flatIdx);
    expect(iMoves[0].score).toBeGreaterThanOrEqual(iMoves[1].score);
  });

  it('hold rescues an O with no continuation of its own', () => {
    // O cannot continue from 111_ but holding it hands over the I
    const adv = fourwideAdvice(flatBoard(), ['O', 'I', 'I'] as PieceType[], null);
    expect(adv.moves.length).toBeGreaterThan(0);
    expect(adv.moves.every((m) => m.usesHold && m.piece === 'I')).toBe(true);
    expect(adv.sustainable).toBe(true); // park O, then I I
  });

  const gradeReq = (board: Board, queue: PieceType[], place: { piece: PieceType; rot: Rot; x: number; y: number; cells: [number, number][]; spin?: SpinKind; lines: number }, hold: PieceType | null = null): GradeRequest => ({
    fourwide: true,
    rows: Array.from(board.rows),
    queue,
    hold,
    userCells: place.cells,
    userPiece: place.piece,
    userRot: place.rot,
    userX: place.x,
    userY: place.y,
    userSpin: place.spin ?? 'none',
    userLines: place.lines,
    usedHold: false,
    pieceIndex: 0,
  });

  it('grades a book continuation as best', () => {
    const board = flatBoard();
    const p = STATES[flatIdx].placements['I']!.find((m) => m.next === flatIdx)!; // horizontal I
    const r = gradeFourwide(gradeReq(board, ['I', 'I', 'I'] as PieceType[], {
      piece: 'I', rot: 0, x: 0, y: 0, cells: p.cells, lines: 1,
    }));
    expect(r.grade).toBe('best');
    expect(r.book?.onBook).toBe(true);
    expect(r.book?.userMatched).toBe(true);
  });

  it('grades a clearing move that dooms the combo within the preview as a mistake', () => {
    // flat 111_ with queue I,I,O,S: the horizontal I keeps the combo alive
    // for the whole preview, but the vertical I builds a tower the O+S can no
    // longer continue - it clears now yet loses the combo in 3 pieces
    const board = flatBoard();
    const queue = ['I', 'I', 'O', 'S'] as PieceType[];
    const adv = fourwideAdvice(board, queue, null, 0);
    const nonHoldI = adv.moves.filter((m) => m.piece === 'I' && !m.usesHold);
    const doom = nonHoldI.find((m) => m.score < queue.length)!;
    const survive = nonHoldI.find((m) => m.score >= queue.length)!;
    expect(doom).toBeDefined();
    expect(survive).toBeDefined();
    const r = gradeFourwide(gradeReq(board, queue, {
      piece: 'I', rot: doom.rot, x: doom.x, y: doom.y, cells: doom.cells, lines: 1,
    }));
    expect(r.grade).toBe('mistake');
    expect(r.reasons[0]).toMatch(/Combo will be lost/);
  });

  it('does NOT flag a doomed queue as a mistake - everything dies, so best is best', () => {
    // if even the best line dies within the preview, losing the combo is not
    // the player's fault: playing the longest-surviving move is still best
    const board = flatBoard();
    // O has no continuation; a queue of O,O,O dooms the combo whatever you do
    const queue = ['I', 'O', 'O', 'O'] as PieceType[];
    const adv = fourwideAdvice(board, queue, null, 0);
    expect(adv.moves[0].score).toBeLessThan(queue.length); // nothing survives
    const best = adv.moves[0];
    const r = gradeFourwide(gradeReq(board, queue, {
      piece: 'I', rot: best.rot, x: best.x, y: best.y, cells: best.cells, lines: 1,
    }));
    expect(r.grade).toBe('best');
  });

  it('grades a combo-breaking stack as killer when a continuation existed', () => {
    const board = flatBoard();
    // vertical I on top of the filled column: locks without clearing
    const cells: [number, number][] = [[3, 1], [3, 2], [3, 3], [3, 4]];
    const after = board.clone(); after.place(cells);
    expect(after.clearLines()).toHaveLength(0);
    const r = gradeFourwide(gradeReq(board, ['I', 'I', 'I'] as PieceType[], {
      piece: 'I', rot: 1, x: 2, y: 2, cells, lines: 0,
    }));
    expect(r.grade).toBe('killer');
    expect(r.reasons[0]).toMatch(/Broke the combo/);
  });

  it('flags a wasted O lock as killer when the hold rescue existed', () => {
    const board = flatBoard();
    // O has no continuation from 111_, but holding it hands over the I
    const cells: [number, number][] = [[4, 1], [5, 1], [4, 2], [5, 2]];
    const after = board.clone(); after.place(cells);
    expect(after.clearLines()).toHaveLength(0);
    const r = gradeFourwide(gradeReq(board, ['O', 'I', 'I'] as PieceType[], {
      piece: 'O', rot: 0, x: 4, y: 1, cells, lines: 0,
    }));
    expect(r.grade).toBe('killer');
    expect(r.reasons[0]).toMatch(/\(hold\) kept it going/);
  });

  it('recovery: grades a double-line clear back into a canonical residual as best', () => {
    // 7-cell mess (a broken combo): rows 0-1 filled on cols 3-5 + a cell at
    // (3,2); a vertical I in column 6 clears both rows -> 3-cell residual
    const board = new Board();
    refillWalls(board);
    for (const [x, y] of [[3, 0], [4, 0], [5, 0], [3, 1], [4, 1], [5, 1], [3, 2]]) {
      board.rows[y] |= 1 << x;
    }
    expect(residualKey(board)).toBeNull();
    const adv = fourwideAdvice(board, ['I', 'I'] as PieceType[], null);
    expect(adv.onBook).toBe(false);
    const rescue = adv.moves.find((m) => m.piece === 'I' && m.next !== null);
    expect(rescue).toBeDefined();
    const after = board.clone(); after.place(rescue!.cells);
    const lines = after.clearLines().length;
    expect(lines).toBe(2);
    const r = gradeFourwide(gradeReq(board, ['I', 'I'] as PieceType[], {
      piece: 'I', rot: rescue!.rot, x: rescue!.x, y: rescue!.y, cells: rescue!.cells, lines,
    }));
    expect(r.grade).toBe('best');
  });

  it('grading is fast enough for the worker budget', () => {
    const board = flatBoard();
    const p = STATES[flatIdx].placements['I']![0];
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) {
      gradeFourwide(gradeReq(board, ['I', 'T', 'J', 'L', 'S', 'Z'] as PieceType[], {
        piece: 'I', rot: 0, x: 0, y: 0, cells: p.cells, lines: 1,
      }));
    }
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('every advised move is reachable with the real move generator', () => {
    // spot-check a few states: advice only ever proposes placements that
    // enumeratePlacements (the game's own reachability) also produces
    for (const idx of [0, 5, 16, 27]) {
      const board = stateToBoard(STATES[idx].key);
      for (const piece of Object.keys(STATES[idx].placements) as PieceType[]) {
        const reach = new Set(
          enumeratePlacements(board, piece).map((p) => JSON.stringify([...p.cells].sort())),
        );
        for (const m of STATES[idx].placements[piece]!) {
          expect(reach.has(JSON.stringify([...m.cells].sort())), `state ${idx} ${piece}`).toBe(true);
        }
      }
    }
  });
});
