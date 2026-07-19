import { describe, it, expect } from 'vitest';
import { FLOORS, floorIndexAt, attackFor, ZenithRun, garbageFavor, columnWeights, pickHoleColumn, speedCap, windupSplit } from '../src/core/zenith';
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

describe('gravity (io_qp2_rule)', () => {
  it('base mode ramps with time: g = 0.02 + 0.0005·s (cells/frame)', () => {
    const run = new ZenithRun(0, 'normal', false, () => 0.5);
    expect(run.gravityCps()).toBeCloseTo(0.02 * 60, 5); // 1.2 cps at t=0
    run.tick(60000); // +60s → g = 0.02 + 0.03 = 0.05 cells/frame
    expect(run.gravityCps()).toBeCloseTo(0.05 * 60, 3); // 3.0 cps
  });

  it('gravity mod ramps 0.5G (F1) → 3.2G (F10)', () => {
    expect(FLOORS[0].modGravity).toBeCloseTo(0.5, 5);
    expect(FLOORS[9].modGravity).toBeCloseTo(3.2, 5);
    expect(new ZenithRun(0, 'normal', true, () => 0.5).gravityCps()).toBeCloseTo(0.5 * 60, 5);
  });
});

describe('climb speed cap + crossing floors', () => {
  it('is full far from a floor and 0 just below the boundary', () => {
    expect(speedCap(25)).toBe(1);      // mid-floor: full speed
    expect(speedCap(49)).toBe(0);      // 1m below F2 (50m): stuck
    expect(speedCap(48)).toBeCloseTo(0.2, 5); // 2m below: throttled
    expect(speedCap(44)).toBe(1);      // 6m below: back to full
  });

  it('passive climb is throttled to a crawl right under a floor', () => {
    const near = new ZenithRun(49, 'normal', false, () => 0.5);
    near.tick(1000);
    expect(near.altitude).toBeCloseTo(49, 5); // stuck: essentially no gain
    const open = new ZenithRun(25, 'normal', false, () => 0.5);
    open.tick(1000);
    expect(open.altitude).toBeGreaterThan(25.2); // full-speed passive climb
  });

  it('a clear within 2m of the next floor punches through with +3m', () => {
    const run = new ZenithRun(49, 'normal', false, () => 0.5);
    run.onClear(1, 'none', false); // a plain single sends nothing, but crosses
    expect(run.altitude).toBeGreaterThanOrEqual(52); // 49 + 3 → past 50m
    expect(floorIndexAt(run.altitude)).toBe(1);
  });
});

describe('windup split (big attacks)', () => {
  it('splits attacks into up to four staggered segments below 4000m', () => {
    expect(windupSplit(8, 0)).toEqual([4, 4]);
    expect(windupSplit(10, 0)).toEqual([4, 4, 2]);
    expect(windupSplit(16, 0)).toEqual([4, 4, 4, 4]);
  });

  it('imagined size grows past 4000m (+1 per 500m)', () => {
    // at 4000m imagined = 17 → sections [4,4,4,5]; fill 17 → [4,4,4,5]
    expect(windupSplit(17, 4000)).toEqual([4, 4, 4, 5]);
  });

  it('conserves the total lines (remainder into the last segment)', () => {
    for (const [lines, alt] of [[8, 0], [13, 0], [20, 0], [17, 4000]] as const) {
      expect(windupSplit(lines, alt).reduce((a, b) => a + b, 0)).toBe(lines);
    }
  });
});

describe('B2B / all-clear / surge', () => {
  it('an all clear adds +2 B2B and never breaks the chain', () => {
    const run = new ZenithRun(0, 'calm', false, () => 0.5);
    run.onClear(2, 'full', false);   // TSD: special → b2b 1
    run.onClear(1, 'none', true);    // plain single + all clear: +2, no break
    expect(run.b2b).toBe(3);
  });

  it('surge on break = B2B − 3', () => {
    const run = new ZenithRun(0, 'calm', false, () => 0.5);
    for (let i = 0; i < 7; i++) run.onClear(2, 'full', false); // b2b → 7
    const out = run.onClear(1, 'none', false);                 // break
    expect(out.surged).toBe(4); // 7 − 3
    expect(run.b2b).toBe(0);
  });
});

describe('garbage favor (column placement)', () => {
  it('matches the reference 33 − 3·floorNo (1-indexed)', () => {
    expect(garbageFavor(0)).toBe(30); // floor 1
    expect(garbageFavor(9)).toBe(3);  // floor 10
  });

  it('favor drops with the floor', () => {
    for (let i = 1; i < FLOORS.length; i++) {
      expect(garbageFavor(i)).toBeLessThan(garbageFavor(i - 1));
    }
  });

  it('low floors front-load the easiest-to-dig ranks; high floors flatten', () => {
    const low = columnWeights(garbageFavor(0));   // F1: easiest ranks only
    const high = columnWeights(garbageFavor(9));   // F10: cheese everywhere
    expect(low[0]).toBeGreaterThan(low[5]);        // front-loaded onto easy ranks
    expect(low[9]).toBe(0);                        // hardest rank never picked
    expect(Math.min(...high)).toBeGreaterThan(0);  // every rank reachable
    // the low-floor rank distribution is far spikier than the high-floor one
    expect(low[0] / (low[9] + 1)).toBeGreaterThan(high[0] / (high[9] + 1));
  });

  it('targeting grace banks on received attacks and drains between them', () => {
    const run = new ZenithRun(0, 'calm', false, mulberry32(3));
    let guard = 0;
    while (run.targetingGrace() === 0 && guard++ < 2000) run.tick(100);
    expect(run.targetingGrace()).toBeGreaterThan(0);    // attack banked grace
    expect(run.targetingGrace()).toBeLessThanOrEqual(18); // capped
    // F1 releases a point every 4.8s; calm attack gaps are long enough for
    // the bank to hit 0 again somewhere in the next stretch
    let sawZero = false;
    for (let i = 0; i < 2000 && !sawZero; i++) {
      run.tick(100);
      if (run.targetingGrace() === 0) sawZero = true;
    }
    expect(sawZero).toBe(true);
  });

  it('floors 1–5 gather garbage into the center columns (messiness_center)', () => {
    const run = new ZenithRun(0, 'brutal', false, mulberry32(11));
    const holes: number[] = [];
    for (let i = 0; i < 6000 && holes.length < 300; i++) {
      run.tick(100);
      holes.push(...run.riseGarbage(8));
    }
    expect(holes.length).toBeGreaterThan(0);
    for (const h of holes) {
      expect(h).toBeGreaterThanOrEqual(2); // never the two leftmost…
      expect(h).toBeLessThanOrEqual(7);    // …or two rightmost columns
    }
  });

  it('after a break the old pile pulls re-picks back (messy transition)', () => {
    // the well just relocated: new rows opened col 4 at the bottom (low
    // height) while the OLD pile on top still anchors at 4; the current
    // hole col 7 is buried under that pile. Re-picks must not settle on 7 —
    // they scatter toward the old well and its neighbors (cheese).
    const rng = mulberry32(17);
    const view = { heights: [9, 9, 10, 9, 2, 9, 10, 9, 9, 10], garbageAnchor: 4 };
    const counts = new Array<number>(10).fill(0);
    const N = 300;
    for (let i = 0; i < N; i++) counts[pickHoleColumn(garbageFavor(6), view, false, rng)]++; // F7 favor
    expect(counts[4]).toBe(Math.max(...counts));           // old well is the modal pick…
    expect(counts[4] / N).toBeLessThan(0.5);               // …but nothing dominates: cheese
    expect(counts[7] / N).toBeLessThan(0.15);              // the buried column rarely wins
    expect(counts.filter((n) => n > 0).length).toBeGreaterThanOrEqual(5); // wide scatter
  });

  it('a re-pick sticks to the current well (dig-difficulty ranking)', () => {
    // tall stack everywhere except an open well at col 6 (= the anchor):
    // with F1 favor, fresh holes land in or right next to the well
    const rng = mulberry32(13);
    const view = { heights: [8, 8, 8, 8, 8, 8, 0, 8, 8, 8], garbageAnchor: 6 };
    let near = 0;
    const N = 300;
    for (let i = 0; i < N; i++) {
      const c = pickHoleColumn(garbageFavor(0), view, false, rng);
      expect(Math.abs(c - 6)).toBeLessThanOrEqual(3); // never sprays far away
      if (Math.abs(c - 6) <= 1) near++;
    }
    expect(near / N).toBeGreaterThan(0.6); // mostly the well and its neighbors
  });
});

describe('clutch spawn (only on a line clear, tetr.io)', () => {
  // Bottom two rows are full except cols 0,1 (the O completes them → a clear);
  // a `pillar` at cols 4,5 sits in the buffer so that AFTER the clear shifts it
  // down it buries the next O's spawn, forcing the clutch to climb.
  const clutchBoard = (pillar: number) => {
    const rows = new Uint32Array(BOARD_H);
    rows[0] = 0x3fc; // cols 2..9 filled, gap at 0,1
    rows[1] = 0x3fc;
    for (let y = 20; y < 20 + pillar; y++) rows[y] = 0b110000; // cols 4,5
    return new Board(rows);
  };
  // slide the spawned O to cols 0,1 and drop it → clears the two bottom rows
  const clearIntoClutch = (g: Game) => {
    for (let i = 0; i < 4; i++) g.moveLeft();
    g.hardDrop();
  };

  it('a clear that would bury the next spawn clutches it up into the buffer', () => {
    const g = new Game(1, { clutchRows: 2 });
    g.reset(clutchBoard(2), 1, ['O', 'O', 'O']);
    clearIntoClutch(g);
    expect(g.topOut).toBe(false);
    expect(g.clutched).toBe(true);
    expect(g.active).not.toBeNull();
    expect(g.active!.y).toBeGreaterThan(18); // nudged above the normal spawn row
  });

  it('without clutchRows the same clear tops out on the next spawn', () => {
    const g = new Game(1); // clutchRows defaults to 0
    g.reset(clutchBoard(2), 1, ['O', 'O', 'O']);
    clearIntoClutch(g);
    expect(g.topOut).toBe(true);
    expect(g.active).toBeNull();
  });

  it('tops out when even the buffer headroom is buried', () => {
    const g = new Game(1, { clutchRows: 2 });
    g.reset(clutchBoard(4), 1, ['O', 'O', 'O']); // pillar fills the whole buffer
    clearIntoClutch(g);
    expect(g.topOut).toBe(true);
    expect(g.active).toBeNull();
  });

  it('a buried spawn with NO line clear tops out (clutch is clear-gated)', () => {
    const g = new Game(1, { clutchRows: 2 });
    // cols 4,5 walled to row 20: the very first spawn is buried, but nothing
    // was cleared, so the clutch must not engage
    const wall = Uint32Array.from(Array.from({ length: BOARD_H }, (_, y) => (y < 20 ? 0b110000 : 0)));
    g.reset(new Board(wall), 1, ['O', 'O', 'O']);
    expect(g.topOut).toBe(true);
    expect(g.active).toBeNull();
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
