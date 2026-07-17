// Versus (1v1-style) garbage machinery, shared by the 1v1 mode and the
// drill-mode opponents. Pure logic — no DOM, no workers — so it stays
// unit-testable. tetr.io semantics throughout:
//
//  - attacks TELEGRAPH first (delayMs), then become ACTIVE; both states are
//    cancelable by your own clears until the rows actually rise
//  - garbage rises only on a non-clearing lock, up to a per-lock cap
//  - the hole column is persistent, with a messiness chance to move per row
//    (higher between separate attacks), like the Zenith simulator
//
// All knobs live in GarbageConfig so the settings screen / launch overlay
// can tune them.

export interface GarbageConfig {
  delayMs: number;     // telegraph before an attack can rise
  messiness: number;   // 0..1 chance a garbage row moves the hole column
  cap: number;         // max rows that rise on one non-clearing lock
  /** allowed hole columns (4-wide restricts holes to the well) */
  holeMin: number;
  holeMax: number;     // inclusive
}

export const DEFAULT_GARBAGE: GarbageConfig = {
  delayMs: 2000,
  messiness: 0.15,
  cap: 8,
  holeMin: 0,
  holeMax: 9,
};

/**
 * Lines sent by a clear (guideline/tetr.io-flavored versus table): spins send
 * double, quads send 4, B2B adds 1 while the chain is alive, combo adds
 * floor(combo/2), a perfect clear sends 10. `combo` counts consecutive
 * clearing locks with 0 = the first clear of a run.
 */
export function versusAttack(
  lines: number,
  spin: 'none' | 'mini' | 'full',
  combo: number,
  b2b: number,
  allClear: boolean,
): number {
  if (lines <= 0) return 0;
  let atk = 0;
  if (spin === 'full') atk = lines * 2;
  else if (spin === 'mini') atk = Math.max(0, lines - 1);
  else atk = lines === 4 ? 4 : lines - 1;
  if (b2b > 0 && (spin !== 'none' || lines === 4)) atk += 1;
  atk += Math.floor(Math.max(0, combo) / 2);
  if (allClear) atk += 10;
  return atk;
}

interface QueuedAttack {
  lines: number;
  entersAtMs: number; // telegraph ends here
  rising?: boolean;   // already started entering the board
}

/** One player's incoming garbage queue. Time is fed in by the caller. */
export class GarbageQueue {
  private incoming: QueuedAttack[] = [];
  private holeCol: number;

  constructor(private cfg: GarbageConfig, private rng: () => number = Math.random) {
    this.holeCol = this.randomHole();
  }

  private randomHole(): number {
    const span = this.cfg.holeMax - this.cfg.holeMin + 1;
    return this.cfg.holeMin + Math.floor(this.rng() * span);
  }

  /** Move the hole to a different allowed column (a re-roll never stays put). */
  private moveHole(): void {
    const span = this.cfg.holeMax - this.cfg.holeMin + 1;
    if (span <= 1) return;
    const step = 1 + Math.floor(this.rng() * (span - 1));
    this.holeCol = this.cfg.holeMin + ((this.holeCol - this.cfg.holeMin + step) % span);
  }

  /** An opponent attack lands in the queue; it telegraphs before activating. */
  queue(lines: number, nowMs: number): void {
    if (lines <= 0) return;
    this.incoming.push({ lines, entersAtMs: nowMs + this.cfg.delayMs });
  }

  /** all queued lines (cancelable until they actually rise) */
  pending(): number {
    return this.incoming.reduce((n, a) => n + a.lines, 0);
  }

  /** lines whose telegraph elapsed — they rise on the next non-clearing lock */
  active(nowMs: number): number {
    return this.incoming.reduce((n, a) => n + (a.entersAtMs <= nowMs ? a.lines : 0), 0);
  }

  /** Cancel up to `lines` queued garbage (oldest first); returns lines used. */
  cancel(lines: number): number {
    let canceled = 0;
    while (lines - canceled > 0 && this.incoming.length > 0) {
      const head = this.incoming[0];
      const used = Math.min(head.lines, lines - canceled);
      head.lines -= used;
      canceled += used;
      if (head.lines === 0) this.incoming.shift();
    }
    return canceled;
  }

  /**
   * Rows to insert on a non-clearing lock: hole columns bottom-up, at most
   * `cap`. Only attacks whose telegraph elapsed rise.
   */
  rise(nowMs: number): number[] {
    const holes: number[] = [];
    const m = this.cfg.messiness;
    while (holes.length < this.cfg.cap && this.incoming.length > 0 && this.incoming[0].entersAtMs <= nowMs) {
      const atk = this.incoming[0];
      if (!atk.rising) {
        atk.rising = true;
        if (this.rng() < Math.min(1, m * 2.5)) this.moveHole();
      } else if (this.rng() < m) {
        this.moveHole();
      }
      while (atk.lines > 0 && holes.length < this.cfg.cap) {
        holes.push(this.holeCol);
        atk.lines--;
        if (atk.lines > 0 && this.rng() < m) this.moveHole();
      }
      if (atk.lines === 0) this.incoming.shift();
    }
    return holes;
  }

  clear(): void {
    this.incoming.length = 0;
  }
}

// ---- simulated opponent (no bot) -------------------------------------------

export type Pressure = 'calm' | 'normal' | 'brutal';

/** mean gap between attacks / max attack size, per pressure level */
const PRESSURE_TABLE: Record<Pressure, { gapMs: number; max: number }> = {
  calm: { gapMs: 9000, max: 3 },
  normal: { gapMs: 5500, max: 4 },
  brutal: { gapMs: 3200, max: 6 },
};

/**
 * Quickplay-style scheduled pressure: attacks arrive on a randomized clock,
 * skewed toward small pokes with occasional dumps — the same shape the
 * Zenith simulator uses, minus the altitude scaling. Cancels reduce nothing
 * here (there is no opponent to hurt); the queue handles canceling.
 */
export class ScheduledAttacker {
  private timeMs = 0;
  private nextAtMs: number;

  constructor(private pressure: Pressure, private rng: () => number = Math.random) {
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
