// TETR.IO QUICK PLAY (Zenith Tower) mechanics for the simulator mode.
//
// Ported to match the io_qp2_rule engine as closely as a solo sim can
// (github.com/had0j/io_qp2_rule_eng, MrZ_26's rule doc + the leaked
// "Extra technological information.js" loop). Where the reference is a
// per-frame @60fps loop, the same formulas are re-expressed against dt(ms).
//
// Faithful to the reference:
//  - Gravity: base mode g = 0.02 + 0.0005·seconds (cells/frame, "classic"
//    preset); Gravity mod ramps 0.5G (F1) → 3.2G (F10), lock 30f→16f.
//  - Climb Speed: ×0.25·rank multiplier, XP to promote = 4·rank, XP leak
//    (rank²+rank)/20 per second, 5s→1s promotion-fatigue protection window,
//    demotion returns to the top of the lower rank. Passive climb is scaled
//    by the near-floor "speed cap" (you get stuck 6m→1m below a boundary and
//    need an action to push through: crossing a floor with a clear/send/
//    cancel grants +3m).
//  - Attack: spins 2·lines, quads 4, all-clear +3 attack & +2 B2B, surge on
//    B2B break = B2B−3, windup split for attacks ≥8 lines.
//  - Garbage: favor 33−3·floorNo weighting a dig-difficulty ranking of the
//    columns (one semi-consistent well low, cheese high), center-gathering
//    on floors 1–5, messiness X=0.03·floorNo within an attack / Y=2.5X
//    between attacks - both scaled down at spawn by Targeting Grace (a
//    point per received line, cap 18, draining 4.8s→0.2s per point:
//    X ×(1−1.5%·g), Y ×(1−3.75%·g)) - wait time 5.0s (F1) → 0.5s (F10).
//
// Not modeled (solo sim, no mods/multiplayer): the 9 mods + reversed mods,
// targeting factor/grace vs. other players, cancel-streak bag injection.
// attackEveryMs is a calibrated stand-in for server targeting (see below).
//
// Calibrated (2026-07-15, tools/calibrate-zenith.mjs): attackEveryMs comes
// from a monotone least-squares fit of garbage received vs time-per-floor
// over 1000 real QUICK PLAY records from the TETRA CHANNEL API (top-1000
// leaderboard, alt 1736–6085m, R²≈0.59): ≈5 lines/min on F1 rising to
// ≈70 lines/min on F10 at 'normal' pressure. Elite-lobby data - 'calm'
// approximates casual lobbies.

import { BOARD_W } from './board';

// base-mode gravity (reference "classic" preset): g starts at 0.02 cells/frame
// and rises 0.0005 cells/frame every second, from the start of the game
const BASE_G0 = 0.02;
const BASE_G_PER_SEC = 0.0005;

export interface FloorDef {
  name: string;
  from: number;          // altitude (m) where the floor starts
  modGravity: number;    // G, with the Gravity mod (0.5 + 0.3·idx)
  lockMs: number;        // Gravity mod only - base mode is a flat 500ms
  /** within-attack hole re-roll chance X (0.03·floorNo); between attacks it is
   * Y = 2.5·X - the reference keeps one well for long stretches on low floors
   * and only sprays proper cheese near the top. */
  messiness: number;
  attackEveryMs: number; // mean gap between incoming attacks at normal pressure
  attackMax: number;     // attack size is 1..attackMax lines
}

// modGravity = 0.02 + 0.48 (F1 bump) + 0.30·(idx) = 0.5 + 0.3·idx (cells/frame)
// lockMs = GravLockDelay[30,29,28,27,26,24,22,20,18,16] frames → ms @60fps
// messiness = 0.03·floorNo (floorNo = idx+1)
export const FLOORS: FloorDef[] = [
  { name: 'Hall of Beginnings',   from: 0,    modGravity: 0.5, lockMs: 500, messiness: 0.03, attackEveryMs: 16900, attackMax: 2 },
  { name: 'The Hotel',            from: 50,   modGravity: 0.8, lockMs: 483, messiness: 0.06, attackEveryMs: 7400,  attackMax: 2 },
  { name: 'The Casino',           from: 150,  modGravity: 1.1, lockMs: 467, messiness: 0.09, attackEveryMs: 5200,  attackMax: 3 },
  { name: 'The Arena',            from: 300,  modGravity: 1.4, lockMs: 450, messiness: 0.12, attackEveryMs: 4700,  attackMax: 4 },
  { name: 'The Museum',           from: 450,  modGravity: 1.7, lockMs: 433, messiness: 0.15, attackEveryMs: 4500,  attackMax: 5 },
  { name: 'Abandoned Offices',    from: 650,  modGravity: 2.0, lockMs: 400, messiness: 0.18, attackEveryMs: 3600,  attackMax: 5 },
  { name: 'The Laboratory',       from: 850,  modGravity: 2.3, lockMs: 367, messiness: 0.21, attackEveryMs: 3400,  attackMax: 6 },
  { name: 'The Core',             from: 1100, modGravity: 2.6, lockMs: 333, messiness: 0.24, attackEveryMs: 3400,  attackMax: 6 },
  { name: 'Corruption',           from: 1350, modGravity: 2.9, lockMs: 300, messiness: 0.27, attackEveryMs: 3300,  attackMax: 7 },
  { name: 'Platform of the Gods', from: 1650, modGravity: 3.2, lockMs: 267, messiness: 0.30, attackEveryMs: 2800,  attackMax: 8 },
];

export function floorIndexAt(altitude: number): number {
  for (let i = FLOORS.length - 1; i >= 0; i--) if (altitude >= FLOORS[i].from) return i;
  return 0;
}

export function floorAt(altitude: number): FloorDef {
  return FLOORS[floorIndexAt(altitude)];
}

/** Altitude where the next floor begins (Infinity on the top floor). */
export function nextFloorFrom(altitude: number): number {
  const i = floorIndexAt(altitude);
  return i + 1 < FLOORS.length ? FLOORS[i + 1].from : Infinity;
}

/**
 * Near-floor "speed cap" (reference GetSpeedCap): passive climb is throttled
 * as you approach a floor boundary, reaching 0 just below it - you get stuck
 * 6m→1m out and need an action (a clear/send/cancel that crosses the floor,
 * worth +3m) to break through. Full speed (1) once >6m away.
 */
export function speedCap(altitude: number): number {
  const t = nextFloorFrom(altitude) - altitude;
  return Math.max(0, Math.min(1, t / 5 - 0.2));
}

// Targeting Grace release interval per floor (reference TargetingGrace
// table, seconds → ms): 1 banked point drains every this often after the
// last received attack, so grace lingers on low floors and evaporates high.
const GRACE_RELEASE_MS = [4800, 3900, 2100, 1400, 1300, 900, 600, 400, 300, 200];

// --- garbage column placement (io_qp2_rule engine) -------------------------
// tetr.io does NOT draw the hole from a fixed distribution over columns: it
// scores every column by "dig difficulty" - stack height, +5 per column of
// distance from the SHALLOWEST (topmost) garbage row's hole (the one being
// dug into), with totally empty columns scoring ~0 - sorts columns easiest-
// first, and then weights those RANKS by the garbage favor (33 − 3·floorNo,
// 1-based). High favor (low floors) piles the weight on the easiest ranks,
// and since the open well is by construction the easiest column, fresh holes
// keep landing in or right next to it: one semi-consistent column. Because
// the anchor lags (new rows enter BELOW the pile), a break relocating the
// well degrades into genuinely messy cheese - old pile pulling one way, new
// rows the other - until the old pile is dug out. As favor melts toward the
// top the rank weights flatten and the picks turn into proper cheese.
// A re-pick may land on the same column (messiness_nosame is off in QP).

export function garbageFavor(floorIdx: number): number {
  return 33 - 3 * (floorIdx + 1);
}

/** Weight for the i-th easiest-to-dig column: w[i] = max(0, 10 + favor +
 * i·((20 − 2·(10+favor))/9)). Front-loaded onto the easy ranks at high
 * favor, flat at favor 0 - the reference engine's rank distribution. */
export function columnWeights(favor: number): number[] {
  const slope = (20 - 2 * (10 + favor)) / 9;
  const w = new Array<number>(BOARD_W);
  for (let i = 0; i < BOARD_W; i++) w[i] = Math.max(0, 10 + favor + i * slope);
  return w;
}

/** What the hole picker needs to know about the receiving board. */
export interface BoardView {
  /** per-column stack heights (0 = column completely empty) */
  heights: number[];
  /** hole column of the shallowest (topmost) garbage row - the one being
   * dug into - or −1 when no garbage is on the board */
  garbageAnchor: number;
}

/** The reference `getHolePosition()`: rank columns by dig difficulty and do a
 * favor-weighted pick over the ranks. `centerOnly` is tetr.io's "garbage
 * gathering" (floors 1–5): the hole never lands on the two outermost columns
 * of either side. Without a view (empty board) the ranking is pure jitter,
 * i.e. a favor-weighted pick over a random column order. */
export function pickHoleColumn(
  favor: number,
  view: BoardView | undefined,
  centerOnly: boolean,
  rng: () => number,
): number {
  if (favor === 0) return Math.floor(rng() * BOARD_W); // flat favor: plain uniform (TL rule)
  const anchor = view?.garbageAnchor ?? -1;
  const order: { x: number; s: number }[] = [];
  for (let x = 0; x < BOARD_W; x++) {
    const h = view?.heights[x] ?? 0;
    // reference: height + 5·|x − anchor| + 0.1·rand; empty columns are free
    const s = h === 0 ? 0.1 * rng() : h + (anchor >= 0 ? 5 * Math.abs(x - anchor) : 0) + 0.1 * rng();
    order.push({ x, s });
  }
  order.sort((a, b) => a.s - b.s);
  const w = columnWeights(favor);
  let sum = 0;
  const cum = new Array<number>(BOARD_W);
  for (let i = 0; i < BOARD_W; i++) {
    const wi = centerOnly && (order[i].x < 2 || order[i].x >= BOARD_W - 2) ? 0 : w[i];
    sum += wi;
    cum[i] = sum;
  }
  if (sum <= 0) return order[0].x; // reference fallback
  const r = rng() * sum;
  for (let i = 0; i < BOARD_W; i++) {
    if (cum[i] > 0 && r <= cum[i]) return order[i].x;
  }
  return order[0].x;
}

/** Lines sent by a clear (guideline attack table; B2B/surge handled by the
 * run, since they need chain state). Spins send 2·lines, quads 4, all-clear
 * adds 3 (the Zenith rule, vs TL's 5). */
export function attackFor(lines: number, spin: 'none' | 'mini' | 'full', combo: number, allClear: boolean): number {
  let atk = 0;
  if (spin === 'full') atk = lines * 2;
  else if (spin === 'mini') atk = Math.max(0, lines - 1);
  else atk = lines === 4 ? 4 : lines - 1;
  atk += Math.floor(Math.max(0, combo) / 2);
  if (allClear) atk += 3; // Zenith: all clears send 3
  return atk;
}

/**
 * Windup split (reference ExplodeAttack): an attack of `lines` ≥ 8 is broken
 * into up to four staggered segments so it can't instantly bury you and can
 * be cancelled between segments. `imagined` = 16 (+1 per 500m above 4000m) is
 * split into four ascending sections (e.g. 18 → [4,4,5,5]); the real attack
 * fills those in order. The remainder past the sections is kept in the last
 * segment (the reference drops it - we conserve it so a trainer never eats
 * lines silently). Returns per-segment line counts.
 */
export function windupSplit(lines: number, altitude: number): number[] {
  const imagined = 16 + Math.max(0, Math.floor((altitude - 3500) / 500));
  const base = Math.floor(imagined / 4);
  const sections = [base, base, base, base];
  for (let i = 0; i < imagined - 4 * base; i++) sections[3 - i]++;
  const segs: number[] = [];
  let atk = lines;
  for (let i = 0; i < sections.length && atk > 0; i++) {
    const cut = i === sections.length - 1 ? atk : Math.min(sections[i], atk);
    atk -= cut;
    segs.push(cut);
  }
  return segs;
}

export type Pressure = 'calm' | 'normal' | 'brutal';
const PRESSURE_GAP: Record<Pressure, number> = { calm: 1.7, normal: 1, brutal: 0.55 };

interface QueuedAttack {
  lines: number;
  entersAtMs: number; // telegraph ends; rises on a non-clearing lock after this
  rising?: boolean;   // started entering the board (well re-roll happened)
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
  climbProgress = 0;   // experience toward the next rank (0..4·rank)
  b2b = 0;             // B2B charge (Zenith-style: builds, surges on break)
  combo = -1;
  incoming: QueuedAttack[] = [];
  gravityMod: boolean;
  linesSent = 0;
  garbageTaken = 0;

  // promotion protection: no XP leak for `rankLockedMs`, shrinking 5s→1s each
  // promotion (promotionFatigue) until you re-earn it by reaching mid-bar
  private rankLockedMs = 0;
  private promotionFatigue = 0;
  private lastPromote = false;
  private nextAttackAtMs: number;
  private fatigueStep = 0;
  private rateMult = 1;
  private holeCol: number;
  private rng: () => number;
  // Targeting Grace (reference): every received garbage line banks a point
  // (cap 18); each point scales messiness down at spawn time - X ×(1−1.5%·g),
  // Y ×(1−3.75%·g), at most −27%/−67.5% - so eating garbage calms the well
  // without ever fully canceling a high floor's raw messiness.
  private grace = 0;
  private lastAtkMs = 0;

  constructor(startAltitude: number, private pressure: Pressure, gravityMod = false, rng: () => number = Math.random) {
    this.altitude = startAltitude;
    this.gravityMod = gravityMod;
    this.rng = rng;
    this.holeCol = pickHoleColumn(garbageFavor(floorIndexAt(startAltitude)), undefined, this.centerGather(), rng);
    this.nextAttackAtMs = this.gapMs() * (0.6 + 0.8 * this.rng());
  }

  /** tetr.io "garbage gathering": on floors 1–5 (while messiness ≤ 15%) the
   * hole never lands on the two leftmost or rightmost columns. */
  private centerGather(): boolean {
    return this.floor().messiness <= 0.15 && floorIndexAt(this.altitude) <= 4;
  }

  floor(): FloorDef {
    return floorAt(this.altitude);
  }

  /** current Targeting Grace points (0..18) - visible for tests/HUD */
  targetingGrace(): number {
    return this.grace;
  }

  /** cells per second the active piece falls. Base mode ramps with time
   * (0.02 + 0.0005·s per frame); the Gravity mod uses the per-floor column. */
  gravityCps(): number {
    if (this.gravityMod) return this.floor().modGravity * 60;
    return (BASE_G0 + BASE_G_PER_SEC * (this.timeMs / 1000)) * 60;
  }

  lockMs(): number {
    // the shortened per-floor lock delays belong to the Gravity mod, like
    // its gravity column; base tetr.io locks at the standard 500ms
    return this.gravityMod ? this.floor().lockMs : 500;
  }

  /** Climb Speed multiplier applied to every altitude gain (×0.25 per rank). */
  climbMultiplier(): number {
    return 0.25 * this.climbRank;
  }

  /** all queued lines (cancelable until they actually rise) */
  incomingLines(): number {
    return this.incoming.reduce((n, a) => n + a.lines, 0);
  }

  /** lines whose telegraph elapsed - they rise on your next non-clearing lock */
  activeLines(): number {
    return this.incoming.reduce((n, a) => n + (a.entersAtMs <= this.timeMs ? a.lines : 0), 0);
  }

  private gapMs(): number {
    return this.floor().attackEveryMs * PRESSURE_GAP[this.pressure] / this.rateMult;
  }

  /** Garbage telegraph before an attack can rise: 5.0s on F1 down to 0.5s on
   * F10 (reference garbagephase, doubled from the source's half-frame count).
   * Attacks of 8+ lines are wound up into staggered segments instead. */
  private queueAttack(lines: number): void {
    if (lines <= 0) return;
    // being attacked banks Targeting Grace (+= received lines, cap 18) and
    // marks the "last attacked" moment the release timer counts from
    this.grace = Math.min(18, this.grace + lines);
    this.lastAtkMs = this.timeMs;
    const delay = 5000 - 500 * floorIndexAt(this.altitude);
    if (lines >= 8) {
      // windup: a ~1s warning, then segments enter the queue 0.5s apart
      const segs = windupSplit(lines, this.altitude);
      segs.forEach((seg, i) => {
        this.incoming.push({ lines: seg, entersAtMs: this.timeMs + 1000 + delay + i * 500 });
      });
      return;
    }
    this.incoming.push({ lines, entersAtMs: this.timeMs + delay });
  }

  /** Advance the clock (climb, decay, fatigue, attack scheduling). */
  tick(dtMs: number): void {
    this.timeMs += dtMs;
    const dtSec = dtMs / 1000;

    // --- Climb Speed experience: leak, promote, demote (reference Loop) ---
    // XP leaks (rank²+rank)/20 per second, but not during promotion protection
    if (this.rankLockedMs > 0) {
      this.rankLockedMs -= dtMs;
    } else {
      const r = this.climbRank;
      this.climbProgress -= (r * r + r) / 20 * dtSec;
    }
    if (this.climbProgress < 0) {
      // demotion: fall to the top of the lower rank (reference adds storedXP
      // = 4·(rank−1) then decrements), or clamp at rank 1
      if (this.climbRank <= 1) {
        this.climbProgress = 0;
      } else {
        this.climbProgress += 4 * (this.climbRank - 1);
        this.climbRank--;
        this.lastPromote = false;
      }
    } else {
      while (this.climbProgress >= this.rankThreshold()) {
        this.climbProgress -= this.rankThreshold();
        this.climbRank++;
        this.lastPromote = true;
        // protection window shrinks 5s→1s as you repeatedly promote/demote
        this.rankLockedMs = Math.max(1000, 1000 * (5 - this.promotionFatigue));
        this.promotionFatigue++;
      }
    }
    // re-earn the full 5s window by climbing back to mid-bar after a promotion
    if (this.lastPromote && this.climbProgress >= 2 * (this.climbRank - 1)) {
      this.promotionFatigue = 0;
    }

    // passive climb: +0.25·rank m/s, throttled to 0 as you near a floor
    this.altitude += this.climbMultiplier() * speedCap(this.altitude) * dtSec;

    // targeting factor rises at 3/5/7 minutes; fatigue attacks + received-
    // multiplier bumps from 8:00 on (reference Fatigue table)
    const min = this.timeMs / 60000;
    this.rateMult = 1 + 0.25 * [3, 5, 7].filter((m) => min >= m).length;
    if (min >= 9) this.rateMult *= 1.25;
    if (min >= 11) this.rateMult *= 1.25;
    const bursts = [[8, 2], [10, 3], [12, 5]] as const;
    while (this.fatigueStep < bursts.length && min >= bursts[this.fatigueStep][0]) {
      this.queueAttack(bursts[this.fatigueStep][1]);
      this.fatigueStep++;
    }

    // Targeting Grace releases 1 point every GRACE_RELEASE_MS[floor] after
    // the last attack; each release refreshes the timer (reference Loop)
    if (this.grace > 0 && this.timeMs >= this.lastAtkMs + GRACE_RELEASE_MS[floorIndexAt(this.altitude)]) {
      this.grace--;
      this.lastAtkMs = this.timeMs;
    }

    // schedule incoming attacks
    if (this.timeMs >= this.nextAttackAtMs) {
      const f = this.floor();
      // skewed small: mostly 1-2 line pokes, occasional big dumps
      const lines = 1 + Math.floor(this.rng() ** 2 * f.attackMax);
      this.queueAttack(lines);
      this.nextAttackAtMs = this.timeMs + this.gapMs() * (0.6 + 0.8 * this.rng());
    }
  }

  /**
   * Rise garbage into the board (call on a non-clearing lock), up to `cap`
   * rows. Only attacks whose telegraph elapsed rise; everything still in
   * the queue - telegraphed or active - stays cancelable until this moment,
   * exactly like tetr.io.
   */
  riseGarbage(cap: number, view?: BoardView): number[] {
    const holes: number[] = [];
    // messiness "calculated when finally spawns": Targeting Grace scales the
    // floor's raw rates down - X ×(1 − 1.5%·grace), Y ×(1 − 3.75%·grace),
    // i.e. at the 18-point cap "at most −27% and −67.5%" (reference wording)
    const raw = this.floor().messiness;
    const mX = raw * Math.max(0, 1 - 0.015 * this.grace);
    const mY = raw * 2.5 * Math.max(0, 1 - 0.0375 * this.grace);
    // live copies: every inserted row changes the heights the next re-pick
    // sees. The anchor is the SHALLOWEST garbage row's hole, so fresh rows
    // entering underneath an existing pile never move it - it only gets set
    // when the board had no garbage at all (the first row of this batch is
    // then the top of the new pile).
    const heights = view ? view.heights.slice() : new Array<number>(BOARD_W).fill(0);
    let anchor = view?.garbageAnchor ?? -1;
    const insert = () => {
      holes.push(this.holeCol);
      for (let x = 0; x < BOARD_W; x++) {
        if (x !== this.holeCol) heights[x]++;
        else if (heights[x] > 0) heights[x]++;
      }
      if (anchor === -1) anchor = this.holeCol;
    };
    const repick = () => {
      this.holeCol = pickHoleColumn(
        garbageFavor(floorIndexAt(this.altitude)),
        { heights, garbageAnchor: anchor },
        this.centerGather(),
        this.rng,
      );
    };
    while (holes.length < cap && this.incoming.length > 0 && this.incoming[0].entersAtMs <= this.timeMs) {
      const atk = this.incoming[0];
      // the well column is persistent: it only has a CHANCE to re-pick - per
      // row with the floor's messiness X, ×2.5 (Y) between separate attacks -
      // and a re-pick lands back in/near the well most of the time anyway
      // (dig-difficulty ranking), so low floors keep one semi-consistent well
      if (!atk.rising) {
        atk.rising = true;
        if (this.rng() < Math.min(1, mY)) repick();
      }
      while (atk.lines > 0 && holes.length < cap) {
        insert();
        atk.lines--;
        if (atk.lines > 0 && this.rng() < mX) repick();
      }
      if (atk.lines === 0) this.incoming.shift();
    }
    this.garbageTaken += holes.length;
    return holes;
  }

  /** Player cleared lines: cancel incoming garbage first, rest is altitude. */
  onClear(lines: number, spin: 'none' | 'mini' | 'full', allClear: boolean): ClearOutcome {
    this.combo++;
    let atk = attackFor(lines, spin, this.combo, allClear);
    let surged = 0;

    // B2B: consecutive "special clears" (spins + quads) charge the chain and
    // add +1 attack; breaking it with a plain clear releases a surge of
    // (B2B − 3). All Clears add +2 B2B on their own and never break the chain.
    const special = spin !== 'none' || lines === 4;
    if (special) {
      if (this.b2b > 0) atk += 1;
      this.b2b += 1;
    } else if (!allClear) {
      if (this.b2b >= 4) {
        surged = this.b2b - 3;
        atk += surged;
      }
      this.b2b = 0;
    }
    if (allClear) this.b2b += 2;

    // cancel queued garbage first (telegraphed or active - both cancelable)
    let canceled = 0;
    while (atk - canceled > 0 && this.incoming.length > 0) {
      const head = this.incoming[0];
      const used = Math.min(head.lines, atk - canceled);
      head.lines -= used;
      canceled += used;
      if (head.lines === 0) this.incoming.shift();
    }
    const sent = atk - canceled;

    // sent lines boost altitude by the Climb Speed multiplier per line
    this.altitude += sent * this.climbMultiplier();
    // crossing a floor: an action (clear/send/cancel) within 2m of the next
    // floor punches through the near-floor "stuck" zone with a flat +3m
    const toNext = nextFloorFrom(this.altitude) - this.altitude;
    if (toNext >= 0 && toNext <= 2) this.altitude += 3;

    // climb experience (reference AwardLines): clearing lines, sending attack,
    // and canceling garbage each award XP separately toward the next rank
    let xp = Math.min(lines, 2) + 0.05;
    if (sent > 0) xp += sent + 0.05;
    if (canceled > 0) xp += canceled * 0.5 + 0.05;
    this.bumpClimb(xp);
    this.linesSent += sent;
    return { sent, canceled, surged };
  }

  onLockNoClear(): void {
    this.combo = -1;
  }

  private rankThreshold(): number {
    // io_qp2_rule: XP to promote from the current rank is 4·rank
    return 4 * this.climbRank;
  }

  /** Add experience; promotion is resolved on the next tick (reference Loop),
   * so a huge single-frame spike (a surge) can skip several ranks at once. */
  private bumpClimb(xp: number): void {
    this.climbProgress += xp;
  }
}
