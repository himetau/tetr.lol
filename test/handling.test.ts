import { describe, it, expect } from 'vitest';
import { Game } from '../src/core/game';
import { InputHandler, DEFAULT_HANDLING } from '../src/core/handling';

// seed 1 spawns an O first: rotation is a true no-op, so a rotate in the DCD
// test cannot perturb the piece's x. O sits at origin x=4 (cells 4,5); the
// right wall is origin x=8 (cells 8,9), the left wall is origin x=0.
// Timestamps start at T0 (not 0) because update() treats lastTime===0 as
// "uninitialised" - performance.now() is never 0 in the real loop.
const T0 = 1000;

function harness(overrides: Partial<typeof DEFAULT_HANDLING> = {}) {
  const g = new Game(1);
  expect(g.active!.type).toBe('O');
  const h = new InputHandler(g);
  h.settings = { ...DEFAULT_HANDLING, ...overrides };
  return { g, h };
}

describe('handling - DAS bounce', () => {
  it('with DAS carry on, a charged flick slides straight to the opposite wall', () => {
    const { g, h } = harness({ dasMs: 100, arrMs: 0, dasCarry: true });
    h.keyDown('ArrowRight', T0);   // tap: x 4 -> 5
    h.update(T0);
    h.update(T0 + 120);            // DAS elapses -> slide to the right wall
    expect(g.active!.x).toBe(8);
    expect(g.moveRight()).toBe(false); // confirm at the wall (no-op probe)

    h.keyDown('ArrowLeft', T0 + 130);  // flick left while right is still held
    expect(g.active!.x).toBe(0);   // bounced to the left wall in the same frame
  });

  it('by default the flick is a single step: DAS re-charges on direction change', () => {
    const { g, h } = harness({ dasMs: 100, arrMs: 0 });
    h.keyDown('ArrowRight', T0);
    h.update(T0);
    h.update(T0 + 120);
    expect(g.active!.x).toBe(8);   // right wall

    h.keyDown('ArrowLeft', T0 + 130);  // flick: charge is zeroed, only one cell moves
    expect(g.active!.x).toBe(7);
    expect(g.moveLeft()).toBe(true);   // still room - it did not slide
  });

  it('releasing back to a still-held direction also re-charges (no snap back)', () => {
    const { g, h } = harness({ dasMs: 100, arrMs: 0 });
    h.keyDown('ArrowRight', T0);
    h.update(T0);
    h.update(T0 + 120);            // DAS elapses -> right wall (x=8)
    h.keyDown('ArrowLeft', T0 + 130); // flick: single step to 7, charge reset
    h.update(T0 + 130);
    h.update(T0 + 250);            // DAS re-charged -> slides to the left wall
    expect(g.active!.x).toBe(0);

    h.keyUp('ArrowLeft', T0 + 260);   // back to the still-held right key
    expect(g.active!.x).toBe(1);   // one step only - no instant snap to x=8
    h.update(T0 + 270);            // 20ms charged -> no auto-shift yet
    expect(g.active!.x).toBe(1);
  });

  it('releasing the old, non-active key after a flick does not tap again', () => {
    const { g, h } = harness({ dasMs: 100, arrMs: 0 });
    h.keyDown('ArrowLeft', T0);
    h.update(T0);
    h.update(T0 + 120);            // DAS elapses -> left wall (x=0)
    h.keyDown('ArrowRight', T0 + 130); // flick: single step to 1
    expect(g.active!.x).toBe(1);

    h.keyUp('ArrowLeft', T0 + 150);    // let go of the buried left key
    expect(g.active!.x).toBe(1);   // right is still the active dir - no extra tap
    h.update(T0 + 160);            // 40ms charged -> DAS not elapsed, no auto-shift
    expect(g.active!.x).toBe(1);
  });

  it('a full release drops the charge; the next fresh press starts from zero', () => {
    const { g, h } = harness({ dasMs: 100, arrMs: 0 });
    h.keyDown('ArrowRight', T0);
    h.update(T0);
    h.update(T0 + 120);
    expect(g.active!.x).toBe(8);   // right wall, charged

    h.keyUp('ArrowRight', T0 + 130);   // no direction held now
    h.keyDown('ArrowLeft', T0 + 140);  // fresh press: single tap, no bounce
    expect(g.active!.x).toBe(7);
    h.update(T0 + 150);            // only 10ms of DAS charged -> no auto-shift
    expect(g.active!.x).toBe(7);
  });
});

describe('handling - DAS cut delay', () => {
  it('DCD=0: a rotate does not interrupt the DAS charge', () => {
    const { g, h } = harness({ dasMs: 100, arrMs: 0, dcdMs: 0 });
    h.keyDown('ArrowRight', T0);   // x 4 -> 5
    h.update(T0);
    h.update(T0 + 50);             // 50ms charged
    h.keyDown('KeyX', T0 + 50);    // rotate (O: no-op position)
    h.update(T0 + 105);            // 105ms total >= DAS -> slides to wall
    expect(g.active!.x).toBe(8);
  });

  it('DCD>0: a rotate caps the charge so the next auto-shift is delayed', () => {
    const { g, h } = harness({ dasMs: 100, arrMs: 0, dcdMs: 80 });
    h.keyDown('ArrowRight', T0);
    h.update(T0);
    h.update(T0 + 50);             // 50ms charged
    h.keyDown('KeyX', T0 + 50);    // rotate -> charge capped to DAS-DCD = 20ms
    h.update(T0 + 105);            // 20 + 55 = 75ms < DAS -> not yet at wall
    expect(g.active!.x).toBe(5);
    h.update(T0 + 140);            // 75 + 35 = 110ms >= DAS -> now slides
    expect(g.active!.x).toBe(8);
  });
});
