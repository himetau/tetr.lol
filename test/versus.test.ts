import { describe, it, expect } from "vitest";
import {
  versusAttack,
  scaleAttack,
  GarbageQueue,
  ScheduledAttacker,
  DEFAULT_GARBAGE,
  DEFAULT_RULES,
  type GarbageConfig,
} from "../src/core/versus";
import { mulberry32 } from "../src/core/rng";

const cfg = (over: Partial<GarbageConfig> = {}): GarbageConfig => ({ ...DEFAULT_GARBAGE, ...over });

describe("versus attack table", () => {
  it("follows the guideline shape", () => {
    expect(versusAttack(1, "none", 0, 0, false)).toBe(0); // single
    expect(versusAttack(2, "none", 0, 0, false)).toBe(1); // double
    expect(versusAttack(3, "none", 0, 0, false)).toBe(2); // triple
    expect(versusAttack(4, "none", 0, 0, false)).toBe(4); // quad
    expect(versusAttack(2, "full", 0, 0, false)).toBe(4); // TSD
    expect(versusAttack(3, "full", 0, 0, false)).toBe(6); // TST
    expect(versusAttack(1, "mini", 0, 0, false)).toBe(0); // mini single
  });

  it("B2B adds one only while the chain is alive and the clear keeps it", () => {
    expect(versusAttack(4, "none", 0, 1, false)).toBe(5);
    expect(versusAttack(2, "full", 0, 3, false)).toBe(5);
    expect(versusAttack(2, "none", 0, 3, false)).toBe(1); // plain double never gets the bonus
  });

  it("combo adds floor(combo/2); perfect clear adds 10", () => {
    expect(versusAttack(2, "none", 4, 0, false)).toBe(3);
    expect(versusAttack(1, "none", 7, 0, false)).toBe(3);
    expect(versusAttack(1, "none", 0, 0, true)).toBe(10);
  });

  it("no clear sends nothing", () => {
    expect(versusAttack(0, "full", 5, 5, false)).toBe(0);
  });

  it("every rule dial changes the damage table", () => {
    const r = { ...DEFAULT_RULES };
    expect(versusAttack(2, "full", 0, 0, false, { ...r, spinMult: 3 })).toBe(6);
    expect(versusAttack(2, "full", 0, 0, false, { ...r, spinMult: 0 })).toBe(0);
    expect(versusAttack(4, "none", 0, 0, false, { ...r, quadAttack: 8 })).toBe(8);
    expect(versusAttack(4, "none", 0, 3, false, { ...r, b2bBonus: 4 })).toBe(8);
    expect(versusAttack(2, "none", 6, 0, false, { ...r, comboDiv: 1 })).toBe(7);
    expect(versusAttack(2, "none", 6, 0, false, { ...r, comboDiv: 0 })).toBe(1); // combo damage off
    expect(versusAttack(1, "none", 0, 0, true, { ...r, allClear: 3 })).toBe(3);
  });

  it("attack handicap scales and never goes negative", () => {
    expect(scaleAttack(4, 50)).toBe(2);
    expect(scaleAttack(4, 300)).toBe(12);
    expect(scaleAttack(3, 50)).toBe(2); // rounds
    expect(scaleAttack(0, 300)).toBe(0);
  });
});

describe("garbage queue", () => {
  it("telegraphs before activating, then rises on demand", () => {
    const q = new GarbageQueue(cfg({ delayMs: 1000 }), mulberry32(1));
    q.queue(3, 0);
    expect(q.pending()).toBe(3);
    expect(q.active(500)).toBe(0); // still telegraphed
    expect(q.rise(500)).toEqual([]); // cannot rise yet
    expect(q.active(1000)).toBe(3);
    const rows = q.rise(1000);
    expect(rows).toHaveLength(3);
    expect(q.pending()).toBe(0);
  });

  it("cancel eats the oldest attacks first and reports lines used", () => {
    const q = new GarbageQueue(cfg(), mulberry32(2));
    q.queue(2, 0);
    q.queue(4, 0);
    expect(q.cancel(3)).toBe(3);
    expect(q.pending()).toBe(3);
    expect(q.cancel(10)).toBe(3); // only what exists
    expect(q.pending()).toBe(0);
  });

  it("caps how much rises on one lock and keeps the rest queued", () => {
    const q = new GarbageQueue(cfg({ delayMs: 0, cap: 4 }), mulberry32(3));
    q.queue(10, 0);
    expect(q.rise(1)).toHaveLength(4);
    expect(q.pending()).toBe(6);
    expect(q.rise(1)).toHaveLength(4);
    expect(q.rise(1)).toHaveLength(2);
  });

  it("holes stay inside the configured column range (4-wide well)", () => {
    const q = new GarbageQueue(
      cfg({ delayMs: 0, messiness: 1, holeMin: 3, holeMax: 6 }),
      mulberry32(4),
    );
    q.queue(30, 0);
    for (const col of [...q.rise(1), ...q.rise(1), ...q.rise(1), ...q.rise(1)]) {
      expect(col).toBeGreaterThanOrEqual(3);
      expect(col).toBeLessThanOrEqual(6);
    }
  });

  it("zero messiness keeps one hole column within each attack (tetr.io TL)", () => {
    const q = new GarbageQueue(cfg({ delayMs: 0, messiness: 0, cap: 12 }), mulberry32(5));
    q.queue(6, 0);
    q.queue(6, 0);
    const rows = q.rise(0);
    expect(rows).toHaveLength(12);
    expect(new Set(rows.slice(0, 6)).size).toBe(1); // one clean chunk
    expect(new Set(rows.slice(6)).size).toBe(1); // second chunk, own column
  });

  it("each new attack re-rolls the hole column", () => {
    const q = new GarbageQueue(cfg({ delayMs: 0, messiness: 0, cap: 40 }), mulberry32(9));
    for (let i = 0; i < 12; i++) {
      q.queue(1, 0);
    }
    const rows = q.rise(0);
    // uniform re-roll per attack: many different columns across 12 chunks
    expect(new Set(rows).size).toBeGreaterThan(3);
  });

  it("full messiness moves the hole between rows", () => {
    const q = new GarbageQueue(cfg({ delayMs: 0, messiness: 1, cap: 12 }), mulberry32(6));
    q.queue(12, 0);
    const rows = q.rise(0);
    expect(new Set(rows).size).toBeGreaterThan(1);
  });
});

describe("scheduled attacker", () => {
  it("fires attacks over time, sized within the pressure cap", () => {
    const s = new ScheduledAttacker("brutal", mulberry32(7));
    const fired: number[] = [];
    for (let t = 0; t < 120000; t += 100) {
      fired.push(...s.tick(100));
    }
    expect(fired.length).toBeGreaterThan(15);
    for (const n of fired) {
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(6);
    }
  });

  it("calm pressure fires far less often than brutal", () => {
    const count = (p: "calm" | "brutal") => {
      const s = new ScheduledAttacker(p, mulberry32(8));
      let n = 0;
      for (let t = 0; t < 300000; t += 100) {
        n += s.tick(100).length;
      }
      return n;
    };
    expect(count("calm")).toBeLessThan(count("brutal") / 1.8);
  });
});
