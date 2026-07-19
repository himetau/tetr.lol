// Bottom-of-board altimeter for QUICK PLAY — tetr.io Zenith style: the big
// meter count with the floor readout, a thin progress bar to the next floor,
// and the climb-speed meter, drawn on one canvas so the number can heat up
// and throw sparks while the run climbs fast (and erupt on a surge payout).

import { FLOORS, floorIndexAt, nextFloorFrom, type ZenithRun } from '../core/zenith';
import { settings } from './settings';

interface Spark {
  x: number; y: number;   // css px
  vx: number; vy: number; // px/s
  age: number; ttl: number;
  size: number;
  hue: number;
}

const HUD_H = 78;      // css px
const SPARK_MAX = 220;

/** Per-floor accent, hot toward the top (matches the launch cards). */
function floorColor(i: number): string {
  return `hsl(${205 - i * 22}, 72%, 58%)`;
}

/** Hue for the meter count: shifts smoothly with altitude, cool blue at the
 * bottom (~205°) burning to red (~0°) by the top floor (~1700m). */
function altHue(altitude: number): number {
  return Math.max(0, Math.min(205, 205 - altitude * 0.12));
}

export class ZenithAltimeter {
  readonly el: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private w = 300;
  private dpr = 1;

  private shown = 0;              // tweened altitude readout
  private lastAlt: number | null = null;
  private speed = 0;              // smoothed climb rate, m/s
  private surgeGlow = 0;          // 0..1, decays after a surge
  private sparks: Spark[] = [];
  private spawnAcc = 0;

  // theme snapshot (canvas needs concrete values, not CSS vars)
  private cText = '#dde';
  private cDim = '#889';
  private cAccent = '#04a5e5';
  private font = 'sans-serif';

  constructor(width: number) {
    this.el = document.createElement('canvas');
    this.el.className = 'zenith-altimeter';
    this.ctx = this.el.getContext('2d')!;
    this.setWidth(width);
  }

  setWidth(px: number): void {
    this.w = px;
    this.dpr = window.devicePixelRatio || 1;
    this.el.width = px * this.dpr;
    this.el.height = HUD_H * this.dpr;
    this.el.style.width = `${px}px`;
    this.el.style.height = `${HUD_H}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const cs = getComputedStyle(document.documentElement);
    this.cText = cs.getPropertyValue('--text').trim() || this.cText;
    this.cDim = cs.getPropertyValue('--text-dim').trim() || this.cDim;
    this.cAccent = cs.getPropertyValue('--accent2').trim() || this.cAccent;
    this.font = cs.getPropertyValue('--font-display').trim() || this.font;
  }

  /** New run: snap the readout so it doesn't count up from the old value. */
  reset(altitude: number): void {
    this.shown = altitude;
    this.lastAlt = null;
    this.speed = 0;
    this.surgeGlow = 0;
    this.sparks = [];
    this.spawnAcc = 0;
  }

  /** Surge payout: ignite the counter and erupt sparks that scale with it. */
  surge(lines: number): void {
    this.surgeGlow = 1;
    if (!settings.effects) return;
    const n = Math.min(120, 24 + lines * 8);
    for (let i = 0; i < n; i++) {
      this.spawnSpark(
        8 + Math.random() * Math.min(180, this.w * 0.55),
        HUD_H * (0.35 + Math.random() * 0.5),
        (Math.random() - 0.5) * 160,
        -(60 + Math.random() * 220),
        700 + Math.random() * 900,
        1.2 + Math.random() * 2.2,
      );
    }
  }

  private spawnSpark(x: number, y: number, vx: number, vy: number, ttl: number, size: number): void {
    if (this.sparks.length >= SPARK_MAX) this.sparks.shift();
    this.sparks.push({ x, y, vx, vy, age: 0, ttl, size, hue: 28 + Math.random() * 20 });
  }

  /** Draw one frame. Pass the live run (or null on the launch screen). */
  frame(run: ZenithRun | null, dtMs: number): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, HUD_H);
    if (!run) {
      this.lastAlt = null;
      return;
    }
    const dt = Math.min(dtMs, 100) / 1000;

    // climb rate (m/s), exponentially smoothed; the instant rate is clamped
    // so a surge reads as a hot streak instead of one absurd number
    if (this.lastAlt !== null && dt > 0) {
      const inst = Math.min(30, Math.max(0, (run.altitude - this.lastAlt) / dt));
      this.speed += (inst - this.speed) * Math.min(1, dt * 4);
    }
    this.lastAlt = run.altitude;
    this.shown += (run.altitude - this.shown) * Math.min(1, dt * 10);
    if (Math.abs(run.altitude - this.shown) < 0.05) this.shown = run.altitude;
    this.surgeGlow = Math.max(0, this.surgeGlow - dt / 1.4);

    // how much the counter "burns": fast climb, a surge, or a near-hyperspeed
    // climb rank all light it up
    const heat = Math.max(
      Math.min(1, (this.speed - 0.8) / 2.2),
      this.surgeGlow,
      run.climbRank >= 8 ? 0.35 : 0,
    );

    const fi = floorIndexAt(run.altitude);
    this.drawFloorProgress(run.altitude, fi);
    const altRight = this.drawAltitude(heat);
    this.drawSubline(fi, run.altitude);
    this.drawClimbMeter(run);
    this.emitAndDrawSparks(dt, heat, altRight);
  }

  /** Thin bar along the top edge: progress through the current floor. */
  private drawFloorProgress(altitude: number, fi: number): void {
    const ctx = this.ctx;
    const next = nextFloorFrom(altitude);
    const from = FLOORS[fi].from;
    const frac = Number.isFinite(next) ? Math.min(1, (altitude - from) / (next - from)) : 1;
    ctx.fillStyle = this.cDim;
    ctx.globalAlpha = 0.22;
    ctx.fillRect(0, 0, this.w, 3);
    ctx.globalAlpha = 1;
    ctx.fillStyle = floorColor(fi);
    ctx.fillRect(0, 0, this.w * frac, 3);
  }

  /** The big meter count. Its hue tracks the altitude (cool→hot as you
   * climb) and whitens toward fire while climbing fast. Returns the right
   * edge of the text (spark zone). */
  private drawAltitude(heat: number): number {
    const ctx = this.ctx;
    const hue = altHue(this.shown);
    ctx.save();
    ctx.font = `800 34px ${this.font}`;
    ctx.textBaseline = 'alphabetic';
    if (heat > 0.02) {
      ctx.shadowColor = `hsla(${30 - heat * 14}, 100%, 55%, ${0.35 + heat * 0.6})`;
      ctx.shadowBlur = 4 + heat * 18;
    }
    // altitude-tinted, brightening to white-hot as heat rises
    const sat = Math.round(70 + heat * 25);
    const light = Math.round(62 + heat * 22);
    ctx.fillStyle = `hsl(${hue}, ${sat}%, ${light}%)`;
    const num = this.shown.toFixed(1);
    ctx.fillText(num, 6, 44);
    const numW = ctx.measureText(num).width;
    ctx.shadowBlur = 0;
    ctx.font = `700 16px ${this.font}`;
    ctx.fillStyle = this.cDim;
    ctx.fillText('m', 6 + numW + 4, 44);
    ctx.restore();
    return 6 + numW + 18;
  }

  private drawSubline(fi: number, altitude: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `800 11px ${this.font}`;
    // floor label carries the same altitude tint as the count
    ctx.fillStyle = `hsl(${altHue(altitude)}, 68%, 60%)`;
    const floorTxt = `F${fi + 1} · ${FLOORS[fi].name.toUpperCase()}`;
    ctx.fillText(floorTxt, 6, 66);
    if (this.speed > 0.05) {
      ctx.fillStyle = this.cDim;
      ctx.font = `700 11px ${this.font}`;
      ctx.fillText(`+${this.speed.toFixed(1)} m/s`, 6 + ctx.measureText(floorTxt).width + 30, 66);
    }
    ctx.restore();
  }

  /** Right block: climb-speed multiplier and the XP bar toward the next rank. */
  private drawClimbMeter(run: ZenithRun): void {
    const ctx = this.ctx;
    const mw = Math.max(96, Math.min(150, this.w * 0.3));
    const x = this.w - mw - 6;
    const rank = run.climbRank;
    // cool blue at low ranks burning toward red near hyperspeed
    const col = `hsl(${Math.max(8, 205 - rank * 22)}, 80%, 58%)`;
    ctx.save();
    ctx.font = `800 10px ${this.font}`;
    ctx.fillStyle = this.cDim;
    ctx.fillText('CLIMB SPEED', x, 26);
    ctx.font = `800 20px ${this.font}`;
    ctx.fillStyle = col;
    if (rank >= 8) {
      ctx.shadowColor = col;
      ctx.shadowBlur = 10;
    }
    ctx.fillText(`×${run.climbMultiplier().toFixed(2)}`, x, 48);
    ctx.shadowBlur = 0;
    // XP toward the next rank (promotion at 4·rank)
    const frac = Math.min(1, Math.max(0, run.climbProgress / (4 * rank)));
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = this.cDim;
    ctx.fillRect(x, 56, mw, 7);
    ctx.globalAlpha = 1;
    ctx.fillStyle = col;
    ctx.fillRect(x, 56, mw * frac, 7);
    ctx.restore();
  }

  private emitAndDrawSparks(dt: number, heat: number, altRight: number): void {
    const ctx = this.ctx;
    // steady embers rise off the counter while it burns
    if (settings.effects && heat > 0.15) {
      this.spawnAcc += heat * 55 * dt;
      while (this.spawnAcc >= 1) {
        this.spawnAcc--;
        this.spawnSpark(
          4 + Math.random() * Math.max(40, altRight - 4),
          HUD_H * 0.35 + Math.random() * (HUD_H * 0.5),
          (Math.random() - 0.5) * 26,
          -(24 + Math.random() * 80) * (0.7 + heat),
          500 + Math.random() * 700,
          1 + Math.random() * 1.8,
        );
      }
    }
    if (this.sparks.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    let n = 0;
    for (const p of this.sparks) {
      p.age += dt * 1000;
      if (p.age >= p.ttl) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy -= 30 * dt; // embers accelerate upward a little
      const life = 1 - p.age / p.ttl;
      ctx.globalAlpha = life * 0.9;
      ctx.fillStyle = `hsl(${p.hue}, 100%, ${55 + life * 25}%)`;
      ctx.fillRect(p.x, p.y, p.size, p.size);
      this.sparks[n++] = p;
    }
    this.sparks.length = n;
    ctx.restore();
  }
}
