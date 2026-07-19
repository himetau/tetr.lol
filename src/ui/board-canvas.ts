import { BOARD_H, BOARD_W, VISIBLE_H, Board } from "../core/board";
import { cellsAt, PIECE_COLORS, PIECE_CELLS, type PieceType } from "../core/pieces";
import type { Game } from "../core/game";
import { settings } from "./settings";
import { cssVar as css } from "./css";

// ---- tetr.io skin sheet (extracted from the user's tetrio-plus .tpse) ----
// public/skin/minos.png is the raw connected texture: one 384×576 region per
// mino, each a grid of 96px tiles where the tile's row/column encodes which
// edges are exposed (row: top/bottom, col: left/right) - derived from the
// pack's ghost sheet. Cells are drawn straight from the sheet so adjacent
// cells of the same piece merge seamlessly, exactly like in tetr.io.

export type SkinKey = PieceType | "G";
const SKIN_TILE = 96;
const SKIN_ORIGIN: Record<SkinKey, [number, number]> = {
  Z: [0, 0],
  L: [384, 0],
  O: [768, 0],
  S: [1152, 0],
  G: [1536, 0],
  I: [0, 576],
  J: [384, 576],
  T: [768, 576],
};

let skinImg: HTMLImageElement | undefined;
let skinReady = false;
const skinWaiters: (() => void)[] = [];

function skin(): HTMLImageElement {
  if (!skinImg) {
    skinImg = new Image();
    skinImg.src = `${import.meta.env.BASE_URL}skin/minos.png`;
    skinImg.onload = () => {
      skinReady = true;
      for (const f of skinWaiters.splice(0)) {
        f();
      }
    };
  }
  return skinImg;
}
skin(); // start loading at module import

/** Run when the skin sheet is available (immediately if already loaded). */
export function whenSkinReady(f: () => void): void {
  if (skinReady) {
    f();
  } else {
    skinWaiters.push(f);
  }
}

export function skinLoaded(): boolean {
  return skinReady;
}

export interface Neighbors {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

/** Top-left of the connected tile for a cell merging with these neighbors. */
function skinTile(key: SkinKey, n: Neighbors): [number, number] {
  const [ox, oy] = SKIN_ORIGIN[key];
  const row = !n.up ? (!n.down ? 3 : 0) : !n.down ? 2 : 1;
  const col = !n.left ? (!n.right ? 0 : 1) : !n.right ? 3 : 2;
  return [ox + col * SKIN_TILE, oy + row * SKIN_TILE];
}

/** Draw one connected-skin cell into any 2d context (pixel coords). The dest
 * rect is snapped to whole device pixels: cells are drawn one drawImage each,
 * and a boundary on a fractional pixel antialiases against the background on
 * both sides, reading as a seam through the piece. */
export function blitSkinCell(
  ctx: CanvasRenderingContext2D,
  key: SkinKey,
  n: Neighbors,
  px: number,
  py: number,
  size: number,
  dpr = window.devicePixelRatio || 1,
): void {
  const [sx, sy] = skinTile(key, n);
  const x0 = Math.round(px * dpr) / dpr;
  const y0 = Math.round(py * dpr) / dpr;
  const x1 = Math.round((px + size) * dpr) / dpr;
  const y1 = Math.round((py + size) * dpr) / dpr;
  ctx.drawImage(skin(), sx, sy, SKIN_TILE, SKIN_TILE, x0, y0, x1 - x0, y1 - y0);
}

/** Neighbor lookup for a free-standing set of cells (a piece). */
function pieceNeighbors(
  cells: readonly (readonly [number, number])[],
): (x: number, y: number) => Neighbors {
  const set = new Set(cells.map(([x, y]) => x * 64 + y));
  const has = (x: number, y: number) => set.has(x * 64 + y);
  return (x, y) => ({
    up: has(x, y + 1),
    down: has(x, y - 1),
    left: has(x - 1, y),
    right: has(x + 1, y),
  });
}

// ---- canvas fx primitives ----

interface Particle {
  x: number;
  y: number; // px, canvas space
  vx: number;
  vy: number; // px/s
  age: number;
  ttl: number; // ms
  size: number;
  color: string;
  grav: number; // px/s²
}

interface RowFlash {
  y: number; // board row, pre-clear
  age: number;
}
interface CellFlash {
  cells: readonly (readonly [number, number])[];
  age: number;
}
interface Trail {
  x0: number;
  x1: number;
  yTop: number;
  age: number;
  color: string;
}

const P_MAX = 500;

// incoming garbage rises into the board one row every this many ms (~3 frames
// at 60fps): the stack is snapped up instantly on the board, but drawn settling
// down one row per step so the garbage visibly pushes up from the floor
const GARBAGE_RISE_MS_PER_ROW = 50;

export class FieldRenderer {
  readonly canvas: HTMLCanvasElement;
  /** wrapper sized to the VISIBLE field only; the canvas is anchored to its
   * bottom so the buffer rows overflow above it, floating over the page
   * background instead of expanding the field panel (tetr.io vanish zone) */
  readonly el: HTMLDivElement;
  private ctx: CanvasRenderingContext2D;
  private cell = 26;
  private dpr = 1;
  /** transparent headroom rows above the visible field - the vanish zone where
   * pieces spawn and float, tetr.io style (also the room for a clutch save).
   * The field background/grid never extend into it, so the board still reads
   * as 20 rows and the active piece appears to hover above the well. A
   * clutched spawn climbs one row further into the buffer, so a couple of
   * rows past the resting spawn are drawn - enough that the last-chance piece
   * sits at the canvas's top edge instead of being clipped. */
  private bufferRows = 4;
  /** transient highlight cells - with a piece type they render from the skin
   * sheet plus a colored outline; without one they fall back to flat color */
  highlight: { cells: [number, number][]; color: string; piece?: PieceType } | null = null;
  /** 0..1 lock-delay progress of the grounded piece - dims it, tetr.io style */
  lockProgress = 0;
  /** 0..1 stack-danger level - red vignette pulses in from the top */
  danger = 0;

  /** column bitmask of "infinite" wall columns (4-wide drill) whose locked
   * cells are clipped to the visible field instead of spilling into the
   * buffer rows above it */
  wallCols = 0;
  /** freshly-inserted garbage rising into the board (tetr.io style): the bottom
   * `rows` are real on the board already, but the stack is drawn `rows` lower
   * and settles up one row at a time so the garbage pushes up from the floor */
  private garbageReveal: { rows: number; age: number } | null = null;

  private particles: Particle[] = [];
  private rowFlashes: RowFlash[] = [];
  private cellFlashes: CellFlash[] = [];
  private trails: Trail[] = [];
  private shakeMag = 0;
  private shakeX = 0;
  private shakeY = 0;
  private fxT = 0;
  /** cached danger vignette (gradients are expensive to rebuild per frame) */
  private dangerGrad: CanvasGradient | null = null;

  constructor(cellSize = 26, bufferRows = 4) {
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d")!;
    this.bufferRows = bufferRows;
    this.el = document.createElement("div");
    this.el.className = "field-well";
    this.el.appendChild(this.canvas);
    this.setCellSize(cellSize);
  }

  /** rows the canvas actually draws: the visible field plus the buffer above */
  private get rows(): number {
    return VISIBLE_H + this.bufferRows;
  }

  /** Resize the field (live zoom changes). Resets the canvas state. */
  setCellSize(cellSize: number): void {
    this.cell = cellSize;
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.canvas.width = BOARD_W * this.cell * dpr;
    this.canvas.height = this.rows * this.cell * dpr;
    this.canvas.style.width = `${BOARD_W * this.cell}px`;
    this.canvas.style.height = `${this.rows * this.cell}px`;
    // the well is only the visible field tall; the canvas (which also draws the
    // buffer rows) is pinned to the well's floor, so the buffer spills upward
    this.el.style.width = `${BOARD_W * this.cell}px`;
    this.el.style.height = `${VISIBLE_H * this.cell}px`;
    this.ctx.scale(dpr, dpr);
    this.dangerGrad = null;
  }

  // y=0 board row is drawn at the bottom; buffer rows sit above the field, and
  // anything above the buffer is clipped.
  private py(y: number): number {
    return (this.rows - 1 - y) * this.cell;
  }

  // ---- fx API (all no-ops when reduced effects is on) ----

  private get fxOn(): boolean {
    return settings.effects;
  }

  /** Nudge the whole field; decays as a spring. */
  kick(mag: number): void {
    if (!this.fxOn) {
      return;
    }
    this.shakeMag = Math.min(12, this.shakeMag + mag);
  }

  /** Brief white flash on freshly locked cells. */
  fxLock(cells: readonly (readonly [number, number])[]): void {
    if (!this.fxOn) {
      return;
    }
    this.cellFlashes.push({ cells, age: 0 });
  }

  /** Hard-drop beam over the piece's columns + impact dust at its cells. */
  fxDrop(cells: readonly (readonly [number, number])[], color: string): void {
    if (!this.fxOn) {
      return;
    }
    let x0 = Infinity,
      x1 = -Infinity,
      yTop = -Infinity;
    for (const [x, y] of cells) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x + 1);
      yTop = Math.max(yTop, y + 1);
    }
    this.trails.push({
      x0: x0 * this.cell,
      x1: x1 * this.cell,
      yTop: this.py(yTop - 1),
      age: 0,
      color,
    });
    for (const [x, y] of cells) {
      this.dust(2, (x + 0.5) * this.cell, this.py(y) + this.cell * 0.5, color, 60);
    }
    this.kick(2);
  }

  /** Line-clear burst: flash the rows, spray particles sideways out of them. */
  fxClear(rows: number[], colors: string[]): void {
    if (!this.fxOn) {
      return;
    }
    const w = BOARD_W * this.cell;
    for (const y of rows) {
      this.rowFlashes.push({ y, age: 0 });
      const py = this.py(y) + this.cell * 0.5;
      for (let i = 0; i < 16; i++) {
        const color = colors[(Math.random() * colors.length) | 0];
        const px = Math.random() * w;
        this.spawn({
          x: px,
          y: py,
          vx: (px < w / 2 ? -1 : 1) * (40 + Math.random() * 220),
          vy: (Math.random() - 0.65) * 200,
          age: 0,
          ttl: 350 + Math.random() * 350,
          size: 1.5 + Math.random() * (this.cell * 0.14),
          color,
          grav: 500,
        });
      }
    }
    this.kick(1.5 + rows.length * 1.5);
  }

  /** All-clear: confetti fountain from the floor. */
  fxAllClear(): void {
    if (!this.fxOn) {
      return;
    }
    const w = BOARD_W * this.cell;
    const h = this.rows * this.cell;
    const palette = Object.values(PIECE_COLORS);
    for (let i = 0; i < 90; i++) {
      this.spawn({
        x: Math.random() * w,
        y: h,
        vx: (Math.random() - 0.5) * 260,
        vy: -(220 + Math.random() * 480),
        age: 0,
        ttl: 700 + Math.random() * 700,
        size: 2 + Math.random() * (this.cell * 0.18),
        color: palette[(Math.random() * palette.length) | 0],
        grav: 640,
      });
    }
    this.kick(6);
  }

  /** Garbage slammed into the floor: red dust + a thud proportional to rows. */
  fxGarbage(rows: number): void {
    if (!this.fxOn) {
      return;
    }
    const w = BOARD_W * this.cell;
    const h = this.rows * this.cell;
    const bad = css("--bad") || "#ff5c5c";
    for (let i = 0; i < rows * 10; i++) {
      this.spawn({
        x: Math.random() * w,
        y: h - Math.random() * rows * this.cell,
        vx: (Math.random() - 0.5) * 160,
        vy: -(60 + Math.random() * 200),
        age: 0,
        ttl: 300 + Math.random() * 300,
        size: 1.5 + Math.random() * (this.cell * 0.1),
        color: bad,
        grav: 700,
      });
    }
    this.kick(2 + rows * 1.2);
  }

  /** Start the rise for `rows` freshly-inserted garbage rows (they already sit
   * at the board's bottom; this only paces the settle-up draw). */
  fxGarbageIn(rows: number): void {
    if (!this.fxOn || rows <= 0) {
      this.garbageReveal = null;
      return;
    }
    this.garbageReveal = { rows, age: 0 };
  }

  /** rows the stack is still drawn below its settled position (0 = settled) */
  private garbageRiseRows(): number {
    const g = this.garbageReveal;
    if (!g) {
      return 0;
    }
    return Math.max(0, g.rows - Math.floor(g.age / GARBAGE_RISE_MS_PER_ROW));
  }

  /** Top out: the field takes a hit and the stack blows apart. */
  fxTopout(board: Board, colors: (PieceType | null)[][] | null): void {
    if (!this.fxOn) {
      return;
    }
    const dim = css("--text-dim") || "#8b93ab";
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < BOARD_W; x++) {
        if (!board.filled(x, y) || Math.random() > 0.3) {
          continue;
        }
        const t = colors?.[y]?.[x];
        this.spawn({
          x: (x + 0.5) * this.cell,
          y: this.py(y) + this.cell * 0.5,
          vx: (Math.random() - 0.5) * 340,
          vy: -(40 + Math.random() * 320),
          age: 0,
          ttl: 500 + Math.random() * 600,
          size: 2 + Math.random() * (this.cell * 0.2),
          color: t ? PIECE_COLORS[t] : dim,
          grav: 620,
        });
      }
    }
    this.kick(10);
  }

  private dust(n: number, x: number, y: number, color: string, speed: number): void {
    for (let i = 0; i < n; i++) {
      this.spawn({
        x: x + (Math.random() - 0.5) * this.cell,
        y: y + (Math.random() - 0.5) * this.cell * 0.5,
        vx: (Math.random() - 0.5) * speed * 2,
        vy: -Math.random() * speed * 1.6,
        age: 0,
        ttl: 250 + Math.random() * 250,
        size: 1 + Math.random() * (this.cell * 0.1),
        color,
        grav: 420,
      });
    }
  }

  private spawn(p: Particle): void {
    if (this.particles.length >= P_MAX) {
      this.particles.shift();
    }
    this.particles.push(p);
  }

  private stepFx(dt: number): void {
    // shake: random jitter scaled by an exponentially decaying magnitude
    this.shakeMag *= Math.exp(-dt / 90);
    if (this.shakeMag < 0.05) {
      this.shakeMag = 0;
    }
    this.shakeX = (Math.random() * 2 - 1) * this.shakeMag;
    this.shakeY = (Math.random() * 2 - 1) * this.shakeMag * 0.6;

    const s = dt / 1000;
    let n = 0;
    for (const p of this.particles) {
      p.age += dt;
      if (p.age >= p.ttl) {
        continue;
      }
      p.vy += p.grav * s;
      p.x += p.vx * s;
      p.y += p.vy * s;
      this.particles[n++] = p;
    }
    this.particles.length = n;
    this.rowFlashes = this.rowFlashes.filter((f) => (f.age += dt) < 260);
    this.cellFlashes = this.cellFlashes.filter((f) => (f.age += dt) < 140);
    this.trails = this.trails.filter((t) => (t.age += dt) < 160);
    if (
      this.garbageReveal &&
      (this.garbageReveal.age += dt) >= this.garbageReveal.rows * GARBAGE_RISE_MS_PER_ROW
    ) {
      this.garbageReveal = null;
    }
  }

  private drawFx(): void {
    const ctx = this.ctx;
    const w = BOARD_W * this.cell;
    // hard-drop beams: vertical gradient fading toward the top
    for (const t of this.trails) {
      const a = 0.28 * (1 - t.age / 160);
      const grad = ctx.createLinearGradient(0, 0, 0, t.yTop + this.cell);
      grad.addColorStop(0, "rgba(255,255,255,0)");
      grad.addColorStop(1, t.color);
      ctx.globalAlpha = a;
      ctx.fillStyle = grad;
      ctx.fillRect(t.x0 + 1, 0, t.x1 - t.x0 - 2, t.yTop + this.cell);
    }
    // cleared-row flashes
    for (const f of this.rowFlashes) {
      const k = f.age / 260;
      ctx.globalAlpha = 0.85 * (1 - k);
      ctx.fillStyle = "#ffffff";
      const shrink = k * this.cell * 0.5;
      ctx.fillRect(0, this.py(f.y) + shrink, w, this.cell - shrink * 2);
    }
    // lock flashes
    for (const f of this.cellFlashes) {
      const a = 0.5 * (1 - f.age / 140);
      ctx.globalAlpha = a;
      ctx.fillStyle = "#ffffff";
      for (const [x, y] of f.cells) {
        if (y >= this.rows) {
          continue;
        }
        ctx.beginPath();
        ctx.roundRect(x * this.cell + 1, this.py(y) + 1, this.cell - 2, this.cell - 2, 4);
        ctx.fill();
      }
    }
    // particles
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, 1 - p.age / p.ttl);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  // ---- cells ----

  /** Draw a cell from the connected skin sheet. Nothing is drawn until the sheet
   * has loaded: every static renderer repaints via whenSkinReady and the live
   * board repaints each frame, so the merged texture simply appears once ready
   * (rather than briefly flashing a separate-tile fallback). */
  private drawSkinCell(x: number, y: number, key: SkinKey, n: Neighbors, alpha = 1): void {
    if (!skinReady) {
      return;
    }
    this.ctx.globalAlpha = alpha;
    blitSkinCell(this.ctx, key, n, x * this.cell, this.py(y), this.cell, this.dpr);
    this.ctx.globalAlpha = 1;
  }

  /** Render a bare board (used for alternative-placement previews). Pass the
   * stack's piece colors so the preview keeps the real skins. */
  renderStatic(board: Board, colors: (PieceType | null)[][] | null = null): void {
    const fake = { board, colors, active: null, ghostY: () => 0 } as unknown as Game;
    this.render(fake);
  }

  render(game: Game): void {
    const now = performance.now();
    const dt = this.fxT ? Math.min(now - this.fxT, 50) : 0;
    this.fxT = now;
    this.stepFx(dt);

    const ctx = this.ctx;
    const w = BOARD_W * this.cell;
    const h = this.rows * this.cell;
    const bufH = this.bufferRows * this.cell; // transparent headroom above field
    const fieldH = VISIBLE_H * this.cell;
    ctx.save();
    // the headroom stays transparent so the active piece reads as floating
    // ABOVE the board; the field background covers only the visible 20 rows
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = css("--field-bg");
    ctx.fillRect(0, bufH, w, fieldH);
    // whole-device-pixel shake only - fractional offsets antialias every
    // cell edge and draw seams through the pieces
    ctx.translate(
      Math.round(this.shakeX * this.dpr) / this.dpr,
      Math.round(this.shakeY * this.dpr) / this.dpr,
    );
    // cover the sliver the shake exposes at the field edges (headroom stays clear)
    if (this.shakeMag > 0) {
      ctx.fillStyle = css("--field-bg");
      ctx.fillRect(-14, bufH, w + 28, fieldH + 14);
    }

    if (settings.grid) {
      ctx.strokeStyle = css("--field-grid");
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 1; x < BOARD_W; x++) {
        ctx.moveTo(x * this.cell + 0.5, bufH);
        ctx.lineTo(x * this.cell + 0.5, h);
      }
      for (let y = 0; y < VISIBLE_H - 1; y++) {
        ctx.moveTo(0, this.py(y) + 0.5);
        ctx.lineTo(w, this.py(y) + 0.5);
      }
      ctx.stroke();
    }

    // stack: locked pieces render from the skin sheet, merging with adjacent
    // cells of the same piece type; unknown cells (garbage rows, pattern
    // boards, previews) use the pack's garbage mino
    const keyAt = (x: number, y: number): SkinKey | null => {
      if (x < 0 || x >= BOARD_W || y < 0 || y >= BOARD_H) {
        return null;
      }
      if (y >= VISIBLE_H && (this.wallCols >>> x) & 1) {
        return null;
      }
      if (!game.board.filled(x, y)) {
        return null;
      }
      return game.colors?.[y]?.[x] ?? "G";
    };
    // freshly-inserted garbage rise: the whole stack is snapped up on the board,
    // but drawn `rise` rows lower and settled up one row at a time, so the
    // garbage pushes up from the floor (cells below the floor clip off-canvas)
    const rise = this.garbageRiseRows();
    if (rise > 0) {
      ctx.save();
      ctx.translate(0, Math.round(rise * this.cell * this.dpr) / this.dpr);
    }
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < BOARD_W; x++) {
        const k = keyAt(x, y);
        if (!k) {
          continue;
        }
        this.drawSkinCell(
          x,
          y,
          k,
          {
            up: keyAt(x, y + 1) === k,
            down: keyAt(x, y - 1) === k,
            left: keyAt(x - 1, y) === k,
            right: keyAt(x + 1, y) === k,
          },
          0.95,
        );
      }
    }
    if (rise > 0) {
      ctx.restore();
    }

    // highlight (last placement / alternative preview): the real piece skin
    // with a colored outline so it still reads as "the suggested move"
    if (this.highlight) {
      const hl = this.highlight;
      if (skinReady) {
        const key: SkinKey = hl.piece ?? "G";
        const n = pieceNeighbors(hl.cells);
        for (const [x, y] of hl.cells) {
          if (y < this.rows) {
            this.drawSkinCell(x, y, key, n(x, y), 0.95);
          }
        }
        ctx.strokeStyle = hl.color;
        ctx.lineWidth = Math.max(1.5, this.cell * 0.08);
        ctx.beginPath();
        // stroke only the piece's outer edges, not the seams between its cells
        const has = (x: number, y: number) => hl.cells.some(([cx, cy]) => cx === x && cy === y);
        for (const [x, y] of hl.cells) {
          if (y >= this.rows) {
            continue;
          }
          const px = x * this.cell;
          const py = this.py(y);
          if (!has(x, y + 1)) {
            ctx.moveTo(px, py);
            ctx.lineTo(px + this.cell, py);
          }
          if (!has(x, y - 1)) {
            ctx.moveTo(px, py + this.cell);
            ctx.lineTo(px + this.cell, py + this.cell);
          }
          if (!has(x - 1, y)) {
            ctx.moveTo(px, py);
            ctx.lineTo(px, py + this.cell);
          }
          if (!has(x + 1, y)) {
            ctx.moveTo(px + this.cell, py);
            ctx.lineTo(px + this.cell, py + this.cell);
          }
        }
        ctx.stroke();
      }
    }

    // ghost + active piece
    const a = game.active;
    if (a) {
      if (settings.ghost) {
        const gy = game.ghostY();
        if (gy !== a.y) {
          const gcells = cellsAt(a.type, a.rot, a.x, gy);
          const gn = pieceNeighbors(gcells);
          for (const [x, y] of gcells) {
            if (y < this.rows) {
              this.drawSkinCell(x, y, a.type, gn(x, y), 0.3);
            }
          }
        }
      }
      const alpha = 1 - 0.45 * Math.min(1, Math.max(0, this.lockProgress));
      const cells = cellsAt(a.type, a.rot, a.x, a.y);
      const n = pieceNeighbors(cells);
      for (const [x, y] of cells) {
        if (y < this.rows) {
          this.drawSkinCell(x, y, a.type, n(x, y), alpha);
        }
      }
    }

    this.drawFx();

    // danger vignette: red bleed from the field's top edge as the stack climbs
    if (this.danger > 0) {
      if (!this.dangerGrad) {
        const grad = ctx.createLinearGradient(0, bufH, 0, bufH + fieldH * 0.55);
        grad.addColorStop(0, "rgba(255, 60, 60, 0.28)");
        grad.addColorStop(1, "rgba(255, 60, 60, 0)");
        this.dangerGrad = grad;
      }
      ctx.globalAlpha = this.danger;
      ctx.fillStyle = this.dangerGrad;
      ctx.fillRect(-14, bufH, w + 28, fieldH * 0.55);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
}

/** Shared hold/next pane sizing so the queue pieces and the side columns
 * are the same size in every mode (drills, quick play, 1v1). */
export function holdCellOf(boardCell: number): number {
  return Math.max(10, Math.round(boardCell * 0.68));
}
/** Next-queue piece cell - 1.5× the hold/preview base so the pieces read large. */
export function queueCellOf(boardCell: number): number {
  return Math.round(Math.max(8, Math.round(boardCell * 0.55)) * 1.5);
}
/** Side-column width: hugs the (wider) queue tiles so both columns match. */
export function sideColWidth(boardCell: number): string {
  return `${Math.max(110, 5 * queueCellOf(boardCell) + 24)}px`;
}

/** Small static canvas of a piece, for hold/next panes. */
export function renderPieceTile(
  type: PieceType | null,
  cell = 18,
  widthCells = 5,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const dpr = window.devicePixelRatio || 1;
  const w = widthCells * cell;
  const h = 3 * cell;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  if (!type) {
    return canvas;
  }
  const cells = PIECE_CELLS[type][0];
  const xs = cells.map((c) => c[0]);
  const ys = cells.map((c) => c[1]);
  const cx = (Math.min(...xs) + Math.max(...xs) + 1) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys) + 1) / 2;
  const paint = () => {
    ctx.clearRect(0, 0, w, h);
    const n = pieceNeighbors(cells);
    for (const [x, y] of cells) {
      const px = (x - cx) * cell + w / 2;
      const py = (cy - 1 - y) * cell + h / 2;
      if (skinReady) {
        blitSkinCell(ctx, type, n(x, y), px, py, cell);
      }
    }
  };
  paint();
  if (!skinReady) {
    whenSkinReady(paint);
  }
  return canvas;
}

/** Mini board thumbnail for alternative-placement cards. */
export function renderMiniBoard(
  board: Board,
  pieceCells: [number, number][] | null,
  pieceType: PieceType | null,
  heightRows = 10,
  cell = 13,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const dpr = window.devicePixelRatio || 1;
  const w = BOARD_W * cell;
  const h = heightRows * cell;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  const paint = () => {
    ctx.fillStyle = css("--field-bg");
    ctx.fillRect(0, 0, w, h);
    const px = (x: number) => x * cell;
    const py = (y: number) => (heightRows - 1 - y) * cell;
    const inBoard = (x: number, y: number) => x >= 0 && x < BOARD_W && y >= 0 && board.filled(x, y);
    for (let y = 0; y < heightRows; y++) {
      for (let x = 0; x < BOARD_W; x++) {
        if (!board.filled(x, y)) {
          continue;
        }
        ctx.globalAlpha = 0.8;
        if (skinReady) {
          blitSkinCell(
            ctx,
            "G",
            {
              up: inBoard(x, y + 1),
              down: inBoard(x, y - 1),
              left: inBoard(x - 1, y),
              right: inBoard(x + 1, y),
            },
            px(x),
            py(y),
            cell,
          );
        }
        ctx.globalAlpha = 1;
      }
    }
    if (pieceCells && pieceType) {
      const n = pieceNeighbors(pieceCells);
      for (const [x, y] of pieceCells) {
        if (y >= heightRows) {
          continue;
        }
        if (skinReady) {
          blitSkinCell(ctx, pieceType, n(x, y), px(x), py(y), cell);
        }
      }
    }
  };
  paint();
  if (!skinReady) {
    whenSkinReady(paint);
  }
  return canvas;
}
