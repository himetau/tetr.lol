import { describe, it, expect } from "vitest";
import { b2bCue, thunderCue, ThunderStreak } from "../src/ui/sound";

describe("progressive B2B jingle", () => {
  it("is silent before the first back-to-back", () => {
    expect(b2bCue(0)).toBeNull();
    expect(b2bCue(1)).toBeNull(); // one special clear isn't back-to-back yet
  });

  it("steps through all three samples one per level (btb_3 by B2B ×3)", () => {
    expect(b2bCue(2)!.name).toBe("btb_1"); // B2B ×1
    expect(b2bCue(3)!.name).toBe("btb_2"); // ×2
    expect(b2bCue(4)!.name).toBe("btb_3"); // ×3 - the "high" sound is heard early
    expect(b2bCue(9)!.name).toBe("btb_3"); // stays on the top tier
    expect(b2bCue(25)!.name).toBe("btb_3");
  });

  it("the first three levels play at base pitch, then the top tier climbs", () => {
    expect(b2bCue(2)!.rate).toBeCloseTo(1, 5); // ×1 btb_1
    expect(b2bCue(3)!.rate).toBeCloseTo(1, 5); // ×2 btb_2
    expect(b2bCue(4)!.rate).toBeCloseTo(1, 5); // ×3 btb_3
    expect(b2bCue(5)!.rate).toBeGreaterThan(1); // ×4 btb_3 pitched up
    expect(b2bCue(20)!.rate).toBeGreaterThan(b2bCue(8)!.rate); // keeps rising
    expect(b2bCue(100)!.rate).toBeLessThanOrEqual(2); // capped
  });
});

describe("thunderCue sample mapping", () => {
  it("clamps intensity into thunder1..thunder6", () => {
    expect(thunderCue(0)).toBe("thunder1");
    expect(thunderCue(1)).toBe("thunder1");
    expect(thunderCue(3)).toBe("thunder3");
    expect(thunderCue(6)).toBe("thunder6");
    expect(thunderCue(99)).toBe("thunder6");
  });
});

describe("ThunderStreak - 8 lines cleared in one combo crack the thunder", () => {
  // hit(linesCleared, keepsB2b, allClear?, b2bBefore?)
  // a placement that clears NOTHING (linesCleared 0) breaks the combo.
  const quad = (t: ThunderStreak) => t.hit(4, true); // tetris, +4 lines
  const tsd = (t: ThunderStreak) => t.hit(2, true); // T-spin double, +2 lines
  const build = (t: ThunderStreak) => t.hit(0, false); // no clear - breaks the combo
  const plainClear = (t: ThunderStreak) => t.hit(2, false); // +2 lines, breaks B2B

  it("a single tetris (4 lines) never cracks", () => {
    expect(quad(new ThunderStreak())).toBe(0);
  });

  it("two tetrises in a row (4+4=8) crack on the second", () => {
    const t = new ThunderStreak();
    expect(quad(t)).toBe(0); // 4
    expect(quad(t)).toBeGreaterThan(0); // 8 → thunder
  });

  it("a build piece between two tetrises resets it (the reported bug)", () => {
    const t = new ThunderStreak();
    expect(quad(t)).toBe(0); // tetris, combo = 4
    build(t); // placed a piece, cleared nothing → combo broken
    expect(quad(t)).toBe(0); // lone tetris again, combo = 4, must NOT crack
  });

  it("mixed clears still add up: tetris + T-spin double + T-spin double = 8", () => {
    const t = new ThunderStreak();
    expect(quad(t)).toBe(0); // 4
    expect(tsd(t)).toBe(0); // 6
    expect(tsd(t)).toBeGreaterThan(0); // 8 → thunder
  });

  it("fires ONCE per combo - later clears don't re-crack it", () => {
    const t = new ThunderStreak();
    quad(t); // 4
    expect(quad(t)).toBeGreaterThan(0); // 8 → the one crack
    expect(quad(t)).toBe(0); // 12 → silent (no re-crack)
    expect(quad(t)).toBe(0); // 16 → silent
  });

  it("a fresh combo after a break can crack again", () => {
    const t = new ThunderStreak();
    quad(t);
    expect(quad(t)).toBeGreaterThan(0); // first combo cracks at 8
    build(t); // combo broken
    expect(quad(t)).toBe(0); // fresh combo, 4
    expect(quad(t)).toBeGreaterThan(0); // 8 again → cracks
  });

  it("a plain clear counts toward the combo but resets it if under 8", () => {
    const t = new ThunderStreak();
    expect(plainClear(t)).toBe(0); // 2, and this clear kept the combo alive
    expect(plainClear(t)).toBe(0); // 4
    expect(plainClear(t)).toBe(0); // 6
    expect(plainClear(t)).toBeGreaterThan(0); // 8 → thunder (4 singles in a row)
  });

  it("breaking a back-to-back chain of 4+ cashes out with thunder", () => {
    // hit(lines, keepsB2b, allClear, b2bBefore)
    expect(new ThunderStreak().hit(1, false, false, 4)).toBeGreaterThan(0); // ×4 break
    expect(new ThunderStreak().hit(1, false, false, 3)).toBe(0); // ×3 - not big enough
  });

  it("the longer the broken chain, the bigger the thunder", () => {
    const four = new ThunderStreak().hit(1, false, false, 4);
    const ten = new ThunderStreak().hit(1, false, false, 10);
    expect(ten).toBeGreaterThan(four);
  });

  it("an all clear cracks on its own, even a plain (non-B2B) one", () => {
    // hit(lines, keepsB2b, allClear)
    expect(new ThunderStreak().hit(4, true, true)).toBeGreaterThan(0); // tetris PC
    expect(new ThunderStreak().hit(2, false, true)).toBeGreaterThan(0); // plain double PC
  });

  it("breaking a long chain into an all clear takes the bigger crack", () => {
    // an all clear that also breaks a huge chain uses the louder of the two
    const bigBreakPC = new ThunderStreak().hit(2, false, true, 12);
    const solo = new ThunderStreak().hit(2, false, true, 0);
    expect(bigBreakPC).toBeGreaterThan(solo);
  });

  it("reset clears the run", () => {
    const t = new ThunderStreak();
    quad(t);
    t.reset();
    expect(quad(t)).toBe(0);
  });
});
