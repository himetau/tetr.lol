// TETR.IO QUICK PLAY (Zenith Tower) mechanics for the simulator mode.
//
// Documented (tetrio.wiki.gg/wiki/QUICK_PLAY): floor names + altitude bands,
// the Gravity-mod speed curve (0.48G→3.18G, lock 30f→16f), passive climb of
// +0.25 m/s per Climb Speed rank, "each line sent boosts you by one second
// of your Climb Speed", targeting factor rising over a run, fatigue from
// 8:00, all clears sending 3.
//
// Approximated: base-mode gravity curve, attack size distribution,
// messiness, climb-rank thresholds and decay. Tunable in the tables below.
//
// Calibrated (2026-07-15, tools/calibrate-zenith.mjs): attackEveryMs comes
// from a monotone least-squares fit of garbage received vs time-per-floor
// over 1000 real QUICK PLAY records from the TETRA CHANNEL API (top-1000
// leaderboard, alt 1736–6085m, R²≈0.59): ≈5 lines/min on F1 rising to
// ≈70 lines/min on F10 at 'normal' pressure. Elite-lobby data — 'calm'
// approximates casual lobbies.

export interface FloorDef {
  name: string;
  from: number;          // altitude (m) where the floor starts
  baseGravity: number;   // G, base mode (approximation)
  modGravity: number;    // G, with the Gravity mod (documented)
  lockMs: number;        // Gravity mod only — base mode is a flat 500ms
  messiness: number;     // chance each extra row in one attack re-rolls its hole
  attackEveryMs: number; // mean gap between incoming attacks at normal pressure
  attackMax: number;     // attack size is 1..attackMax lines
}

export const FLOORS: FloorDef[] = [
  { name: 'Hall of Beginnings',   from: 0,    baseGravity: 0.02, modGravity: 0.48, lockMs: 500, messiness: 0.05, attackEveryMs: 16900, attackMax: 2 },
  { name: 'The Hotel',            from: 50,   baseGravity: 0.03, modGravity: 0.78, lockMs: 483, messiness: 0.05, attackEveryMs: 7400,  attackMax: 2 },
  { name: 'The Casino',           from: 150,  baseGravity: 0.05, modGravity: 1.08, lockMs: 467, messiness: 0.30, attackEveryMs: 5200,  attackMax: 3 },
  { name: 'The Arena',            from: 300,  baseGravity: 0.08, modGravity: 1.38, lockMs: 450, messiness: 0.30, attackEveryMs: 4700,  attackMax: 4 },
  { name: 'The Museum',           from: 450,  baseGravity: 0.12, modGravity: 1.68, lockMs: 433, messiness: 0.35, attackEveryMs: 4500,  attackMax: 5 },
  { name: 'Abandoned Offices',    from: 650,  baseGravity: 0.17, modGravity: 1.98, lockMs: 400, messiness: 0.35, attackEveryMs: 3600,  attackMax: 5 },
  { name: 'The Laboratory',       from: 850,  baseGravity: 0.24, modGravity: 2.28, lockMs: 367, messiness: 0.40, attackEveryMs: 3400,  attackMax: 6 },
  { name: 'The Core',             from: 1100, baseGravity: 0.33, modGravity: 2.58, lockMs: 333, messiness: 0.40, attackEveryMs: 3400,  attackMax: 6 },
  { name: 'Corruption',           from: 1350, baseGravity: 0.45, modGravity: 2.88, lockMs: 300, messiness: 0.45, attackEveryMs: 3300,  attackMax: 7 },
  { name: 'Platform of the Gods', from: 1650, baseGravity: 0.60, modGravity: 3.18, lockMs: 267, messiness: 0.50, attackEveryMs: 2800,  attackMax: 8 },
];

export function floorIndexAt(altitude: number): number {
  for (let i = FLOORS.length - 1; i >= 0; i--) if (altitude >= FLOORS[i].from) return i;
  return 0;
}

export function floorAt(altitude: number): FloorDef {
  return FLOORS[floorIndexAt(altitude)];
}

/** Lines sent by a clear (guideline attack table; surge handled by the run). */
export function attackFor(lines: number, spin: 'none' | 'mini' | 'full', combo: number, allClear: boolean): number {
  let atk = 0;
  if (spin === 'full') atk = lines * 2;
  else if (spin === 'mini') atk = Math.max(0, lines - 1);
  else atk = lines === 4 ? 4 : lines - 1;
  atk += Math.floor(Math.max(0, combo) / 2);
  if (allClear) atk += 3; // Zenith: all clears send 3
  return atk;
}

export type Pressure = 'calm' | 'normal' | 'brutal';
const PRESSURE_GAP: Record<Pressure, number> = { calm: 1.7, normal: 1, brutal: 0.55 };

interface QueuedAttack {
  lines: number;
  entersAtMs: number; // when the garbage becomes active (enters on next lock)
}

export interface ClearOutcome {
  sent: number;      // lines that boosted altitude
  canceled: number;  // lines that canceled incoming garbage
  surged: number;    // extra lines released by B2B surge
}

/**
 * One simulated run. The view calls `tick(dt)` every frame and inserts the
 * returned hole columns as garbage on the next piece lock; `onClear` /
 * `onLockNoClear` feed player actions back in.
 */
export class ZenithRun {
  altitude: number;
  timeMs = 0;
  climbRank = 1;
  climbProgress = 0;   // lines toward the next rank
  b2b = 0;             // B2B charge (Zenith-style: builds, surges on break)
  combo = -1;
  incoming: QueuedAttack[] = [];
  gravityMod: boolean;
  linesSent = 0;
  garbageTaken = 0;

  private decayPauseMs = 5000;
  private nextAttackAtMs: number;
  private fatigueStep = 0;
  private rateMult = 1;
  private rng: () => number;

  constructor(startAltitude: number, private pressure: Pressure, gravityMod = false, rng: () => number = Math.random) {
    this.altitude = startAltitude;
    this.gravityMod = gravityMod;
    this.rng = rng;
    this.nextAttackAtMs = this.gapMs() * (0.6 + 0.8 * this.rng());
  }

  floor(): FloorDef {
    return floorAt(this.altitude);
  }

  /** cells per second the active piece falls */
  gravityCps(): number {
    const f = this.floor();
    return (this.gravityMod ? f.modGravity : f.baseGravity) * 60;
  }

  lockMs(): number {
    // the shortened per-floor lock delays belong to the Gravity mod, like
    // its gravity column; base tetr.io locks at the standard 500ms
    return this.gravityMod ? this.floor().lockMs : 500;
  }

  /** queued lines not yet active (shown as "incoming") */
  incomingLines(): number {
    return this.incoming.reduce((n, a) => n + a.lines, 0);
  }

  private gapMs(): number {
    return this.floor().attackEveryMs * PRESSURE_GAP[this.pressure] / this.rateMult;
  }

  private queueAttack(lines: number): void {
    // garbage telegraphs before it activates; higher floors activate faster
    const delay = Math.max(1200, 3200 - 250 * floorIndexAt(this.altitude));
    this.incoming.push({ lines, entersAtMs: this.timeMs + delay });
  }

  /**
   * Advance the clock. Returns hole columns for garbage rows that became
   * active this tick (insert them on the next lock).
   */
  tick(dtMs: number): number[] {
    this.timeMs += dtMs;

    // passive climb: +0.25 m/s per rank
    this.altitude += 0.25 * this.climbRank * (dtMs / 1000);

    // climb-speed decay (faster at higher ranks; paused after rank-up)
    if (this.decayPauseMs > 0) {
      this.decayPauseMs -= dtMs;
    } else if (this.climbRank > 1 || this.climbProgress > 0) {
      this.climbProgress -= 0.12 * this.climbRank * (dtMs / 1000);
      if (this.climbProgress < 0) {
        if (this.climbRank > 1) {
          this.climbRank--;
          this.climbProgress = this.rankThreshold() * 0.5;
          this.decayPauseMs = 1000;
        } else {
          this.climbProgress = 0;
        }
      }
    }

    // targeting factor rises at 3/5/7 minutes; fatigue from 8:00 on
    const min = this.timeMs / 60000;
    this.rateMult = 1 + 0.25 * [3, 5, 7].filter((m) => min >= m).length;
    if (min >= 9) this.rateMult *= 1.25;
    if (min >= 11) this.rateMult *= 1.25;
    const bursts = [[8, 2], [10, 3], [12, 5]] as const;
    while (this.fatigueStep < bursts.length && min >= bursts[this.fatigueStep][0]) {
      this.queueAttack(bursts[this.fatigueStep][1]);
      this.fatigueStep++;
    }

    // schedule incoming attacks
    if (this.timeMs >= this.nextAttackAtMs) {
      const f = this.floor();
      // skewed small: mostly 1-2 line pokes, occasional big dumps
      const lines = 1 + Math.floor(this.rng() ** 2 * f.attackMax);
      this.queueAttack(lines);
      this.nextAttackAtMs = this.timeMs + this.gapMs() * (0.6 + 0.8 * this.rng());
    }

    // activate garbage whose telegraph elapsed
    const holes: number[] = [];
    while (this.incoming.length > 0 && this.incoming[0].entersAtMs <= this.timeMs) {
      const atk = this.incoming.shift()!;
      // each separate attack picks a fresh hole; within an attack rows
      // re-roll with the floor's messiness
      let hole = Math.floor(this.rng() * 10);
      for (let i = 0; i < atk.lines; i++) {
        if (i > 0 && this.rng() < this.floor().messiness) hole = Math.floor(this.rng() * 10);
        holes.push(hole);
      }
      this.garbageTaken += atk.lines;
    }
    return holes;
  }

  /** Player cleared lines: cancel incoming garbage first, rest is altitude. */
  onClear(lines: number, spin: 'none' | 'mini' | 'full', allClear: boolean): ClearOutcome {
    this.combo++;
    const keepsB2b = spin !== 'none' || lines === 4;
    let atk = attackFor(lines, spin, this.combo, allClear);
    let surged = 0;
    if (keepsB2b) {
      if (this.b2b > 0) atk += 1; // B2B bonus while charging
      this.b2b += allClear ? 3 : 1;
    } else if (this.b2b >= 4) {
      // B2B charging: breaking the chain releases the surge
      surged = this.b2b - 3;
      atk += surged;
      this.b2b = 0;
    } else {
      this.b2b = 0;
    }

    // cancel queued garbage first
    let canceled = 0;
    while (atk - canceled > 0 && this.incoming.length > 0) {
      const head = this.incoming[0];
      const used = Math.min(head.lines, atk - canceled);
      head.lines -= used;
      canceled += used;
      if (head.lines === 0) this.incoming.shift();
    }
    const sent = atk - canceled;

    // sent lines boost: one second of climb speed per line
    this.altitude += sent * 0.25 * this.climbRank;
    // both sending and canceling advance climb speed
    this.bumpClimb(atk);
    this.linesSent += sent;
    return { sent, canceled, surged };
  }

  onLockNoClear(): void {
    this.combo = -1;
  }

  private rankThreshold(): number {
    return 8 + 5 * (this.climbRank - 1);
  }

  private bumpClimb(lines: number): void {
    this.climbProgress += lines;
    while (this.climbProgress >= this.rankThreshold()) {
      this.climbProgress -= this.rankThreshold();
      this.climbRank++;
      this.decayPauseMs = 5000;
    }
  }
}
