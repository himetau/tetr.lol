import { describe, it, expect } from 'vitest';
import { FLOORS, floorIndexAt, attackFor, ZenithRun } from '../src/core/zenith';
import { Board, BOARD_H } from '../src/core/board';
import { Game } from '../src/core/game';
import { mulberry32 } from '../src/core/rng';

describe('zenith mechanics', () => {
  it('maps altitude to the right floor', () => {
    expect(floorIndexAt(0)).toBe(0);
    expect(floorIndexAt(49)).toBe(0);
    expect(floorIndexAt(50)).toBe(1);
    expect(floorIndexAt(300)).toBe(3);
    expect(floorIndexAt(2000)).toBe(9);
  });

  it('floor table is sorted and speeds up monotonically', () => {
    for (let i = 1; i < FLOORS.length; i++) {
      expect(FLOORS[i].from).toBeGreaterThan(FLOORS[i - 1].from);
      expect(FLOORS[i].modGravity).toBeGreaterThan(FLOORS[i - 1].modGravity);
      expect(FLOORS[i].lockMs).toBeLessThanOrEqual(FLOORS[i - 1].lockMs);
    }
  });

  it('base mode locks at the standard 500ms; per-floor lock delay is Gravity-mod only', () => {
    expect(new ZenithRun(850, 'normal', false).lockMs()).toBe(500);
    expect(new ZenithRun(1700, 'normal', false).lockMs()).toBe(500);
    expect(new ZenithRun(850, 'normal', true).lockMs()).toBe(FLOORS[6].lockMs);
  });

  it('attack table: spins out-attack plain clears', () => {
    expect(attackFor(2, 'full', 0, false)).toBe(4);   // TSD
    expect(attackFor(2, 'none', 0, false)).toBe(1);   // double
    expect(attackFor(4, 'none', 0, false)).toBe(4);   // quad
    expect(attackFor(1, 'none', 0, false)).toBe(0);   // single
    expect(attackFor(1, 'none', 0, true)).toBe(3);    // all clear
  });

  it('climbs passively and faster after sending', () => {
    const run = new ZenithRun(0, 'normal', false, () => 0.5);
    run.tick(1000);
    const a1 = run.altitude;
    expect(a1).toBeCloseTo(0.25, 1);
    // a TSD chain ranks climb speed up and boosts altitude
    for (let i = 0; i < 6; i++) run.onClear(2, 'full', false);
    run.tick(1000);
    expect(run.climbRank).toBeGreaterThan(1);
    expect(run.altitude).toBeGreaterThan(a1 + 0.25);
  });

  it('clears cancel incoming garbage before it lands', () => {
    const run = new ZenithRun(300, 'brutal', false, () => 0.5);
    // run until an attack is queued (but before it activates)
    let guard = 0;
    while (run.incomingLines() === 0 && guard++ < 300) run.tick(100);
    expect(run.incomingLines()).toBeGreaterThan(0);
    const before = run.incomingLines();
    const out = run.onClear(2, 'full', false);
    expect(out.canceled).toBeGreaterThan(0);
    expect(run.incomingLines()).toBeLessThan(before);
  });

  it('B2B charge surges when the chain breaks', () => {
    const run = new ZenithRun(0, 'calm', false, () => 0.5);
    for (let i = 0; i < 5; i++) run.onClear(2, 'full', false); // charge to 5
    run.onLockNoClear();
    const out = run.onClear(1, 'none', false);                // break -> surge
    expect(out.surged).toBeGreaterThan(0);
  });

  it('the well column is persistent: clean on low floors, messy on high', () => {
    const changesPerRow = (altitude: number) => {
      const run = new ZenithRun(altitude, 'brutal', false, mulberry32(7));
      const holes: number[] = [];
      for (let i = 0; i < 4000 && holes.length < 400; i++) {
        run.tick(100);
        holes.push(...run.riseGarbage(8));
      }
      let changes = 0;
      for (let i = 1; i < holes.length; i++) if (holes[i] !== holes[i - 1]) changes++;
      return changes / (holes.length - 1);
    };
    const low = changesPerRow(0);     // F1: one well for long stretches
    const high = changesPerRow(1700); // F10: proper cheese
    expect(low).toBeLessThan(0.1);
    expect(high).toBeGreaterThan(0.2);
    expect(high).toBeGreaterThan(low * 3);
  });

  it('garbage eventually activates and rises with valid hole columns', () => {
    const run = new ZenithRun(850, 'brutal', false, () => 0.5);
    const holes: number[] = [];
    for (let i = 0; i < 600 && holes.length === 0; i++) {
      run.tick(100);
      if (run.activeLines() > 0) holes.push(...run.riseGarbage(8));
    }
    expect(holes.length).toBeGreaterThan(0);
    for (const h of holes) {
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(10);
    }
  });

  it('active garbage stays cancelable until it actually rises (tetr.io)', () => {
    const run = new ZenithRun(850, 'brutal', false, () => 0.5);
    let guard = 0;
    while (run.activeLines() === 0 && guard++ < 600) run.tick(100);
    expect(run.activeLines()).toBeGreaterThan(0);
    // a TSD cancels the ACTIVE garbage, not just the telegraphed queue
    const before = run.activeLines();
    const out = run.onClear(2, 'full', false);
    expect(out.canceled).toBeGreaterThan(0);
    expect(run.activeLines()).toBeLessThan(before);
  });
});

describe('garbage insertion', () => {
  it('board.insertGarbage pushes the stack up and leaves the holes', () => {
    const b = Board.fromStrings(['XXXX______']);
    b.insertGarbage([3, 3]);
    expect(b.toStrings(3)).toEqual([
      'XXXX______',
      'XXX_XXXXXX',
      'XXX_XXXXXX',
    ]);
  });

  it('game.addGarbage lifts the active piece instead of overlapping it', () => {
    const g = new Game(1);
    g.softDropToFloor();
    const yBefore = g.active!.y;
    // piece is resting on the floor; garbage must shove it up
    g.addGarbage([0, 1, 2, 3]);
    expect(g.active).not.toBeNull();
    expect(g.active!.y).toBeGreaterThan(yBefore);
    expect(g.topOut).toBe(false);
  });

  it('a moderate garbage hit near the top does not instant-kill', () => {
    const g = new Game(1);
    // build a stack ~14 high, then take 4 garbage: still inside the field
    const tall = Array.from({ length: 14 }, () => 0b0111111111); // hole at col 9
    g.reset(new Board(Uint32Array.from(tall.concat(Array(BOARD_H - 14).fill(0)))), 1);
    g.addGarbage([9, 9, 9, 9]);
    expect(g.topOut).toBe(false);
    expect(g.active).not.toBeNull();
  });

  it('tops out only when garbage buries the stack past the ceiling', () => {
    const g = new Game(1);
    // stack already 24 high; a big dump overflows the 26-row field → dead
    const rows = Array.from({ length: BOARD_H }, (_, y) => (y < 24 ? 0b0111111111 : 0));
    g.reset(new Board(Uint32Array.from(rows)), 1);
    g.addGarbage([9, 9, 9, 9, 9, 9]);
    expect(g.topOut).toBe(true);
    expect(g.active).toBeNull();
  });

  it('never leaves the active piece floating alive above the field', () => {
    const g = new Game(1);
    // fill every column solid to row 22, single-column hole so garbage packs it
    const rows = Array.from({ length: BOARD_H }, (_, y) => (y < 22 ? 0b0111111111 : 0));
    g.reset(new Board(Uint32Array.from(rows)), 1);
    g.addGarbage([9, 9, 9, 9, 9, 9, 9, 9]); // 8 lines onto a 22-high stack
    // either it tops out, or the piece is still within the field — never a
    // live piece whose cells all sit above the board
    if (!g.topOut) {
      const cells = g.active!;
      expect(cells.y).toBeLessThan(BOARD_H);
    } else {
      expect(g.active).toBeNull();
    }
  });
});
