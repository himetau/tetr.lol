// Versus (1v1-style) garbage machinery, shared by the 1v1 mode and the
// drill-mode opponents. Pure logic - no DOM, no workers - so it stays
// unit-testable. tetr.io semantics throughout:
//
//  - attacks TELEGRAPH first (delayMs), then become ACTIVE; both states are
//    cancelable by your own clears until the rows actually rise
//  - garbage rises only on a non-clearing lock, up to a per-lock cap
//  - every NEW attack re-rolls the hole column uniformly (tetr.io TL:
//    "change on attack" = 100%; the re-roll may land on the same column,
//    ~10%, so back-to-back same-column chunks happen); within one attack
//    the hole only moves with the messiness chance (TL: 0% - each attack
//    is one clean chunk of cheese)
//
// All knobs live in GarbageConfig so the settings screen / launch overlay
// can tune them.

import { activeLines, cancelLines, totalLines, type QueuedAttack } from "./attack-queue";

export interface GarbageConfig {
  delayMs: number; // telegraph before an attack can rise
  messiness: number; // 0..1 chance each row WITHIN an attack re-rolls the hole (tetr.io TL: 0)
  cap: number; // max rows that rise on one non-clearing lock
  /** allowed hole columns (4-wide restricts holes to the well) */
  holeMin: number;
  holeMax: number; // inclusive
}

export const DEFAULT_GARBAGE: GarbageConfig = {
  delayMs: 2000,
  messiness: 0,
  cap: 8,
  holeMin: 0,
  holeMax: 9,
};

/** Every dial of the versus damage table - all user-tunable. */
export interface AttackRules {
  spinMult: number; // full-spin attack = floor(lines × this)
  quadAttack: number; // lines a quad sends
  b2bBonus: number; // extra lines while the B2B chain is alive
  comboDiv: number; // attack += floor(combo / this); 0 disables combo damage
  allClear: number; // lines a perfect clear adds
}

/** guideline/tetr.io-flavored defaults */
export const DEFAULT_RULES: AttackRules = {
  spinMult: 2,
  quadAttack: 4,
  b2bBonus: 1,
  comboDiv: 2,
  allClear: 10,
};

/**
 * Lines sent by a clear under `rules` (defaults: spins send double, quads
 * send 4, B2B adds 1 while the chain is alive, combo adds floor(combo/2),
 * a perfect clear adds 10). `combo` counts consecutive clearing locks with
 * 0 = the first clear of a run.
 */
export function versusAttack(
  lines: number,
  spin: "none" | "mini" | "full",
  combo: number,
  b2b: number,
  allClear: boolean,
  rules: AttackRules = DEFAULT_RULES,
): number {
  if (lines <= 0) {
    return 0;
  }
  let atk = 0;
  if (spin === "full") {
    atk = Math.floor(lines * rules.spinMult);
  } else if (spin === "mini") {
    atk = Math.max(0, lines - 1);
  } else {
    atk = lines === 4 ? rules.quadAttack : lines - 1;
  }
  if (b2b > 0 && (spin !== "none" || lines === 4)) {
    atk += rules.b2bBonus;
  }
  if (rules.comboDiv > 0) {
    atk += Math.floor(Math.max(0, combo) / rules.comboDiv);
  }
  if (allClear) {
    atk += rules.allClear;
  }
  return atk;
}

/** Apply a percentage handicap to an attack (rounded, never negative). */
export function scaleAttack(atk: number, percent: number): number {
  return Math.max(0, Math.round((atk * percent) / 100));
}

/** One player's incoming garbage queue. Time is fed in by the caller. */
export class GarbageQueue {
  private incoming: QueuedAttack[] = [];
  private holeCol: number;

  constructor(
    private cfg: GarbageConfig,
    private rng: () => number = Math.random,
  ) {
    this.holeCol = this.randomHole();
  }

  /** Uniform re-roll over the allowed columns - may land on the same one,
   * exactly like tetr.io (no `messiness_nosame` in standard rules). */
  private randomHole(): number {
    const span = this.cfg.holeMax - this.cfg.holeMin + 1;
    return this.cfg.holeMin + Math.floor(this.rng() * span);
  }

  /** An opponent attack lands in the queue; it telegraphs before activating. */
  queue(lines: number, nowMs: number): void {
    if (lines <= 0) {
      return;
    }
    this.incoming.push({ lines, entersAtMs: nowMs + this.cfg.delayMs });
  }

  /** all queued lines (cancelable until they actually rise) */
  pending(): number {
    return totalLines(this.incoming);
  }

  /** lines whose telegraph elapsed - they rise on the next non-clearing lock */
  active(nowMs: number): number {
    return activeLines(this.incoming, nowMs);
  }

  /** Cancel up to `lines` queued garbage (oldest first); returns lines used. */
  cancel(lines: number): number {
    return cancelLines(this.incoming, lines);
  }

  /**
   * Rows to insert on a non-clearing lock: hole columns bottom-up, at most
   * `cap`. Only attacks whose telegraph elapsed rise.
   */
  rise(nowMs: number): number[] {
    const holes: number[] = [];
    const m = this.cfg.messiness;
    while (
      holes.length < this.cfg.cap &&
      this.incoming.length > 0 &&
      this.incoming[0].entersAtMs <= nowMs
    ) {
      const atk = this.incoming[0];
      // every fresh attack re-rolls the hole (tetr.io TL "change on attack"
      // = 100%); within the attack it only moves with the messiness chance
      if (!atk.rising) {
        atk.rising = true;
        this.holeCol = this.randomHole();
      }
      while (atk.lines > 0 && holes.length < this.cfg.cap) {
        holes.push(this.holeCol);
        atk.lines--;
        if (atk.lines > 0 && this.rng() < m) {
          this.holeCol = this.randomHole();
        }
      }
      if (atk.lines === 0) {
        this.incoming.shift();
      }
    }
    return holes;
  }

  clear(): void {
    this.incoming.length = 0;
  }
}

// ---- simulated opponent (no bot) -------------------------------------------

export type Pressure = "calm" | "normal" | "brutal";

/** mean gap between attacks / max attack size, per pressure level */
const PRESSURE_TABLE: Record<Pressure, { gapMs: number; max: number }> = {
  calm: { gapMs: 9000, max: 3 },
  normal: { gapMs: 5500, max: 4 },
  brutal: { gapMs: 3200, max: 6 },
};

/**
 * Quickplay-style scheduled pressure: attacks arrive on a randomized clock,
 * skewed toward small pokes with occasional dumps - the same shape the
 * Zenith simulator uses, minus the altitude scaling. Cancels reduce nothing
 * here (there is no opponent to hurt); the queue handles canceling.
 */
export class ScheduledAttacker {
  private timeMs = 0;
  private nextAtMs: number;

  constructor(
    private pressure: Pressure,
    private rng: () => number = Math.random,
  ) {
    this.nextAtMs = this.gap() * (0.6 + 0.8 * this.rng());
  }

  private gap(): number {
    return PRESSURE_TABLE[this.pressure].gapMs;
  }

  /** Advance the clock; returns attack sizes that fired during this tick. */
  tick(dtMs: number): number[] {
    this.timeMs += dtMs;
    const out: number[] = [];
    while (this.timeMs >= this.nextAtMs) {
      out.push(1 + Math.floor(this.rng() ** 2 * PRESSURE_TABLE[this.pressure].max));
      this.nextAtMs += this.gap() * (0.6 + 0.8 * this.rng());
    }
    return out;
  }
}
