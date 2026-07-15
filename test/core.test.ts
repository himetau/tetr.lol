import { describe, it, expect } from 'vitest';
import { Board } from '../src/core/board';
import { cellsAt, PIECE_CELLS } from '../src/core/pieces';
import { tryRotate } from '../src/core/srs';
import { detectSpin } from '../src/core/spin';
import { SevenBag } from '../src/core/rng';
import { Game } from '../src/core/game';

describe('pieces', () => {
  it('every state has 4 cells', () => {
    for (const states of Object.values(PIECE_CELLS)) {
      for (const cells of states) expect(cells.length).toBe(4);
    }
  });

  it('T spawn points up, east points right', () => {
    expect(PIECE_CELLS.T[0]).toContainEqual([0, 1]);
    expect(PIECE_CELLS.T[1]).toContainEqual([1, 0]);
    expect(PIECE_CELLS.T[1]).toContainEqual([0, -1]);
  });

  it('I east state is the vertical column at x=+1', () => {
    expect(PIECE_CELLS.I[1]).toEqual([[1, 1], [1, 0], [1, -1], [1, -2]]);
  });
});

describe('board', () => {
  it('clears full lines and shifts down', () => {
    const b = Board.fromStrings([
      'X_________',
      'XXXXXXXXXX',
      'XXXXXXXXXX',
      'X_XXXXXXXX',
    ]);
    const cleared = b.clearLines();
    expect(cleared.length).toBe(2);
    expect(b.toStrings(2)).toEqual(['X_________', 'X_XXXXXXXX']);
  });

  it('fromStrings/toStrings round trip', () => {
    const rows = ['__XX______', 'XXXX___XXX'];
    expect(Board.fromStrings(rows).toStrings(2)).toEqual(rows);
  });
});

describe('SRS kicks', () => {
  it('T rotates CW freely in open field', () => {
    const b = new Board();
    const r = tryRotate(b, 'T', 0, 4, 5, 1);
    expect(r).toEqual({ x: 4, y: 5, rot: 1, kickIndex: 0 });
  });

  it('TST kick: T CCW drops two rows via kick index 4', () => {
    // Blockers at (2,2) and (3,4) rule out kick indices 0-3 for a CCW
    // rotation from center (2,3); only the (1,-2) TST kick fits.
    const b = Board.fromStrings([
      '___X______',
      '__________',
      '__X_______',
      '__________',
      '__________',
    ]);
    // T spawn-state centered at (2,3). CCW 0->3 kicks:
    // (0,0),(1,0),(1,1),(0,-2),(1,-2)
    const r = tryRotate(b, 'T', 0, 2, 3, -1);
    expect(r).not.toBeNull();
    expect(r!.rot).toBe(3);
    expect(r!.kickIndex).toBe(4); // the TST kick
    expect(r!.x).toBe(3);
    expect(r!.y).toBe(1);
  });

  it('I piece wall kick from left wall', () => {
    const b = new Board();
    // vertical I hugging the left wall at x=-1 would collide; ensure rotation
    // into horizontal kicks it inward.
    const r = tryRotate(b, 'I', 1, 0, 5, 1); // east -> south
    expect(r).not.toBeNull();
    expect(b.collides(cellsAt('I', r!.rot, r!.x, r!.y))).toBe(false);
  });

  it('180 rotation works with SRS+ kicks', () => {
    const b = new Board();
    const r = tryRotate(b, 'T', 0, 4, 5, 2);
    expect(r).not.toBeNull();
    expect(r!.rot).toBe(2);
  });
});

describe('T-spin detection', () => {
  it('detects a full TSD in a standard slot', () => {
    // T pointing down (rot 2) centered at (2,1): cells (1,1),(2,1),(3,1),(2,0).
    // All four corners around the center are filled -> full T-spin.
    const b = Board.fromStrings([
      'XX_XXXXXXX',
      'X___XXXXXX',
      'XX_XXXXXXX',
    ]);
    const spin = detectSpin(b, 'T', 2, 2, 1, true, 0);
    expect(spin).toBe('full');
  });

  it('no spin without rotation as last move', () => {
    const b = Board.fromStrings([
      'XX_XXXXXXX',
      'X___XXXXXX',
      'XX_XXXXXXX',
    ]);
    expect(detectSpin(b, 'T', 2, 2, 1, false, 0)).toBe('none');
  });
});

describe('seven bag', () => {
  it('deals each piece exactly once per bag', () => {
    const bag = new SevenBag(42);
    const first = new Set(Array.from({ length: 7 }, () => bag.next()));
    expect(first.size).toBe(7);
  });

  it('is deterministic per seed', () => {
    const a = new SevenBag(7).peek(14);
    const b = new SevenBag(7).peek(14);
    expect(a).toEqual(b);
  });

  it('setState rewinds draws exactly', () => {
    const bag = new SevenBag(5);
    for (let i = 0; i < 3; i++) bag.next();
    const state = bag.getState();
    const first = Array.from({ length: 14 }, () => bag.next());
    bag.setState(state);
    const replay = Array.from({ length: 14 }, () => bag.next());
    expect(replay).toEqual(first);
  });
});

describe('game', () => {
  it('hard drop locks the piece and spawns the next', () => {
    const g = new Game(1);
    const before = g.active!.type;
    const ev = g.hardDrop()!;
    expect(ev.piece).toBe(before);
    expect(g.board.cellCount()).toBe(4);
    expect(g.active).not.toBeNull();
    expect(g.pieceIndex).toBe(1);
  });

  it('hold swaps and undo rewinds through hold', () => {
    const g = new Game(1);
    const first = g.active!.type;
    g.holdPiece();
    expect(g.hold).toBe(first);
    g.hardDrop();
    expect(g.undo()).toBe(true);
    expect(g.hold).toBe(null);
    expect(g.active!.type).toBe(first);
    expect(g.board.isEmpty()).toBe(true);
  });

  it('undo restores exact queue', () => {
    const g = new Game(9);
    const q0 = [g.active!.type, ...g.preview()];
    g.hardDrop();
    g.hardDrop();
    g.undo();
    g.undo();
    expect([g.active!.type, ...g.preview()]).toEqual(q0);
  });

  it('undo does not skip bag pieces', () => {
    // undoing used to discard the piece drawn at lock while the bag kept
    // advancing, silently dropping one piece from the 7-bag per undo
    const straight = new Game(42);
    const expected: string[] = [];
    for (let i = 0; i < 8; i++) {
      expected.push(straight.active!.type);
      straight.hardDrop();
    }
    const g = new Game(42);
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) {
      g.hardDrop();
      g.undo();
      seen.push(g.active!.type);
      g.hardDrop();
    }
    expect(seen).toEqual(expected);
  });

  it('ghost lands on stack', () => {
    const g = new Game(3);
    g.hardDrop();
    // new piece's ghost must not overlap board
    const y = g.ghostY();
    const a = g.active!;
    expect(g.board.collides(cellsAt(a.type, a.rot, a.x, y))).toBe(false);
    expect(g.board.collides(cellsAt(a.type, a.rot, a.x, y - 1))).toBe(true);
  });
});
