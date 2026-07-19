// Shared full-scene backdrop for every play mode: a shaft of falling particles
// behind the whole layout that reacts to play. The fall speed scales with the
// current "energy" (climb rate in quick play, placement cadence elsewhere) so
// the shaft rushes past when things heat up; line clears / surges fire a
// downward whoosh; notable boundaries (a floor, an all-clear) drop a bright
// sweep line; and the hue is mode-tinted (quick play retints it with altitude).
// Purely decorative, gated on settings.effects, painted under the opaque panels
// so it shows through the gaps, the top margin, and the vanish zone.

import { settings } from "./settings";

interface Dust {
  x: number; // css px
  y: number;
  z: number; // depth 0..1 (near = faster, bigger, brighter - parallax)
  zBucket: number; // depth bucket for batched drawing
  drift: number; // horizontal sway amplitude
  phase: number; // sway phase
  freq: number; // sway speed
  size: number;
}

// Dust is drawn in depth buckets - one path and one fill per bucket instead of
// a fillStyle change and fill call per particle, which is what kills canvas
// performance (especially on Firefox) with a few hundred particles.
const Z_BUCKETS = 8;
const Z_MIN = 0.3;
const Z_SPAN = 0.7;

function zBucketOf(z: number): number {
  return Math.min(Z_BUCKETS - 1, Math.floor(((z - Z_MIN) / Z_SPAN) * Z_BUCKETS));
}

function zOfBucket(bucket: number): number {
  return Z_MIN + ((bucket + 0.5) / Z_BUCKETS) * Z_SPAN;
}

// a boundary line sweeping down the shaft (floor crossed, all-clear, KO)
interface Sweep {
  y: number;
  vy: number;
  hue: number;
  age: number;
  ttl: number;
}

// deliberately gentle: the shaft should read as calm drift, speeding up only a
// little with play and giving a brief nudge (not a lurch) on clears/surges
const BASE_FALL = 13; // px/s ambient drift with no energy
const ENERGY_FALL = 70; // px/s added at full energy
const BOOST_FALL = 130; // px/s added at full whoosh boost
const STREAK_FALL = 240; // only streak once the shaft is really moving (rare)

export class SceneBackground {
  readonly el: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;

  private dust: Dust[] = [];
  private maxDust = 0; // hard cap so pulse() gusts can't grow unbounded
  private sweeps: Sweep[] = [];
  private energy = 0; // eased 0..1 (drives ambient fall speed)
  private energyTarget = 0;
  private hue: number; // eased current hue
  private hueTarget: number;
  private push = 0; // extra px/s (climb rank / streak), eased
  private pushTarget = 0;
  private boost = 0; // surge/clear whoosh, decays
  private flash = 0; // full-canvas hot tint, decays
  private ro: ResizeObserver;

  constructor(host: HTMLElement, baseHue: number) {
    this.hue = baseHue;
    this.hueTarget = baseHue;
    this.el = document.createElement("canvas");
    this.el.className = "scene-bg";
    this.ctx = this.el.getContext("2d")!;
    this.ro = new ResizeObserver(() => this.resize(host.clientWidth, host.clientHeight));
    this.ro.observe(host);
    this.resize(host.clientWidth, host.clientHeight);
  }

  destroy(): void {
    this.ro.disconnect();
  }

  private resize(w: number, h: number): void {
    if (w === 0 || h === 0) {
      return;
    }
    this.w = w;
    this.h = h;
    this.dpr = window.devicePixelRatio || 1;
    this.el.width = Math.round(w * this.dpr);
    this.el.height = Math.round(h * this.dpr);
    this.el.style.width = `${w}px`;
    this.el.style.height = `${h}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.seed();
  }

  /** Populate a screen's worth of dust, sized to the area. */
  private seed(): void {
    const target = Math.min(230, Math.round((this.w * this.h) / 5400));
    this.maxDust = target + 120; // headroom for transient pulse gusts
    const next: Dust[] = [];
    for (let i = 0; i < target; i++) {
      next.push(this.spawn(Math.random() * this.h));
    }
    this.dust = next;
  }

  private spawn(y: number): Dust {
    const z = Z_MIN + Math.random() * Z_SPAN;
    return {
      x: Math.random() * this.w,
      y,
      z,
      zBucket: zBucketOf(z),
      drift: 4 + Math.random() * 14,
      phase: Math.random() * Math.PI * 2,
      freq: 0.3 + Math.random() * 0.9,
      size: (0.8 + Math.random() * 1.8) * z,
    };
  }

  /** New run/round: drop transient motion so nothing carries across. */
  reset(): void {
    this.energy = this.energyTarget = 0;
    this.push = this.pushTarget = 0;
    this.boost = 0;
    this.flash = 0;
    this.sweeps = [];
  }

  /** 0..1 energy → how fast the shaft falls (eased toward this each frame). */
  setEnergy(v: number): void {
    this.energyTarget = Math.max(0, Math.min(1.2, v));
  }

  /** Extra fall speed in px/s (climb rank, high combo) - eased. */
  setPush(px: number): void {
    this.pushTarget = Math.max(0, px);
  }

  /** Retint the shaft (quick play tracks altitude; other modes stay fixed). */
  setHue(hue: number): void {
    this.hueTarget = hue;
  }

  /** A clear / surge: a gentle downward nudge, a soft tint, a little dust. */
  pulse(strength: number, hueShift = 0): void {
    this.boost = Math.min(1.3, this.boost + Math.min(0.8, 0.16 + strength * 0.1));
    this.flash = Math.max(this.flash, Math.min(0.6, 0.22 + strength * 0.06));
    if (hueShift) {
      this.hue = this.hueTarget - hueShift;
    }
    if (!settings.effects || this.h === 0) {
      return;
    }
    const n = Math.min(26, Math.round(5 + strength * 3));
    for (let i = 0; i < n; i++) {
      this.dust.push(this.spawn(-Math.random() * this.h * 0.4));
    }
    // trim oldest so repeated clears can't grow the array without bound
    if (this.dust.length > this.maxDust) {
      this.dust.splice(0, this.dust.length - this.maxDust);
    }
  }

  /** A boundary was crossed: drop a bright line that sweeps down the shaft. */
  sweep(hueShift = 0): void {
    if (!settings.effects || this.h === 0) {
      return;
    }
    this.sweeps.push({
      y: -12,
      vy: 360,
      hue: this.hueTarget - hueShift,
      age: 0,
      ttl: 1600,
    });
  }

  /** Advance + draw one frame. */
  frame(dtMs: number): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    if (this.w === 0 || this.h === 0) {
      return;
    }
    if (!settings.effects) {
      return;
    }
    const dt = Math.min(dtMs, 100) / 1000;

    this.energy += (this.energyTarget - this.energy) * Math.min(1, dt * 2);
    this.push += (this.pushTarget - this.push) * Math.min(1, dt * 2);
    this.hue += (this.hueTarget - this.hue) * Math.min(1, dt * 1.5);
    this.boost = Math.max(0, this.boost - dt * 1.9);
    this.flash = Math.max(0, this.flash - dt * 1.9);

    const fall = BASE_FALL + this.energy * ENERGY_FALL + this.boost * BOOST_FALL + this.push;
    const streaky = fall > STREAK_FALL; // draw motion streaks only when really moving

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    const dotPaths: (Path2D | null)[] = new Array(Z_BUCKETS).fill(null);
    for (const p of this.dust) {
      const v = fall * (0.35 + p.z); // near dust falls faster
      p.y += v * dt;
      p.phase += p.freq * dt;
      const x = p.x + Math.sin(p.phase) * p.drift * (1.1 - p.z);
      const len = streaky ? Math.min(this.h * 0.5, v * dt * 2.4) : 0;
      if (p.y - len > this.h + 8) {
        p.y = -8 - Math.random() * 40;
        p.x = Math.random() * this.w;
        continue;
      }
      if (len > 1) {
        // streaks vary in line width per particle, so they draw individually
        // (streaky mode is rare - only when the shaft is really moving)
        const light = 56 + p.z * 20;
        const alpha = (0.14 + p.z * 0.34) * 0.85;
        ctx.strokeStyle = `hsla(${this.hue}, 85%, ${light}%, ${alpha})`;
        ctx.lineWidth = p.size;
        ctx.beginPath();
        ctx.moveTo(x, p.y);
        ctx.lineTo(x, p.y - len);
        ctx.stroke();
      } else {
        const path = (dotPaths[p.zBucket] ??= new Path2D());
        path.moveTo(x + p.size, p.y);
        path.arc(x, p.y, p.size, 0, Math.PI * 2);
      }
    }
    for (let b = 0; b < Z_BUCKETS; b++) {
      const path = dotPaths[b];
      if (!path) {
        continue;
      }
      const z = zOfBucket(b);
      ctx.fillStyle = `hsla(${this.hue}, 85%, ${56 + z * 20}%, ${0.14 + z * 0.34})`;
      ctx.fill(path);
    }

    // boundary sweeps: a bright band racing down the shaft
    let n = 0;
    for (const s of this.sweeps) {
      s.age += dtMs;
      s.y += s.vy * dt;
      if (s.age >= s.ttl || s.y > this.h + 30) {
        continue;
      }
      const life = 1 - s.age / s.ttl;
      const band = 26;
      const g = ctx.createLinearGradient(0, s.y - band, 0, s.y + band);
      g.addColorStop(0, `hsla(${s.hue}, 90%, 62%, 0)`);
      g.addColorStop(0.5, `hsla(${s.hue}, 95%, 66%, ${0.5 * life})`);
      g.addColorStop(1, `hsla(${s.hue}, 90%, 62%, 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, s.y - band, this.w, band * 2);
      ctx.strokeStyle = `hsla(${s.hue}, 100%, 78%, ${0.7 * life})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, s.y);
      ctx.lineTo(this.w, s.y);
      ctx.stroke();
      this.sweeps[n++] = s;
    }
    this.sweeps.length = n;
    ctx.restore();

    // whoosh tint: a soft wash from the top, fading fast
    if (this.flash > 0.01) {
      const g = ctx.createLinearGradient(0, 0, 0, this.h);
      g.addColorStop(0, `hsla(${Math.max(6, this.hue - 20)}, 90%, 60%, ${0.08 * this.flash})`);
      g.addColorStop(1, "hsla(0, 0%, 0%, 0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, this.w, this.h);
    }
  }
}

/** Per-mode base hue for the shaft, matching the stats series colours. */
export const MODE_HUE: Record<string, number> = {
  lst: 26, // --series-lst  #fab387 orange
  fourwide: 116, // --series-fourwide #a6e3a1 green
  free: 217, // --series-free #89b4fa blue
  allspin: 267, // --series-allspin #cba6f7 purple
  quick: 205, // retinted by altitude at runtime
  versus: 170, // --series-versus #94e2d5 teal
};

/** Altitude → hue for quick play (cool blue low, burning red near the top). */
export function altHue(altitude: number): number {
  return Math.max(0, Math.min(205, 205 - altitude * 0.12));
}

/**
 * Heat a base hue toward red as a chain builds. `t` is 0..1 (how hot); the
 * shift takes the shortest way around the wheel so every mode warms up nicely
 * (green→orange, blue/purple→magenta→red). Drives the particle colour off the
 * live B2B / combo count so a long chain visibly reddens the whole shaft.
 */
export function hotHue(base: number, t: number): number {
  const target = 6; // red
  const d = ((target - base + 540) % 360) - 180; // shortest signed delta
  return base + d * Math.max(0, Math.min(1, t));
}
