import { BOARD_W, VISIBLE_H, Board } from '../core/board';
import { cellsAt, PIECE_COLORS, PIECE_CELLS, type PieceType } from '../core/pieces';
import type { Game } from '../core/game';
import { settings } from './settings';

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export class FieldRenderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cell = 26;
  /** transient highlight cells: [x, y, color] with alpha fade handled by caller */
  highlight: { cells: [number, number][]; color: string } | null = null;
  /** 0..1 lock-delay progress of the grounded piece — dims it, tetr.io style */
  lockProgress = 0;

  constructor(cellSize = 26) {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.setCellSize(cellSize);
  }

  /** Resize the field (live zoom changes). Resets the canvas state. */
  setCellSize(cellSize: number): void {
    this.cell = cellSize;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = BOARD_W * this.cell * dpr;
    this.canvas.height = (VISIBLE_H + 1) * this.cell * dpr;
    this.canvas.style.width = `${BOARD_W * this.cell}px`;
    this.canvas.style.height = `${(VISIBLE_H + 1) * this.cell}px`;
    this.ctx.scale(dpr, dpr);
  }

  // y=0 board row is drawn at the bottom; one hidden row peeks above.
  private py(y: number): number {
    return (VISIBLE_H - y) * this.cell;
  }

  private drawCell(x: number, y: number, color: string, alpha = 1): void {
    const c = this.cell;
    const px = x * c;
    const py = this.py(y);
    const ctx = this.ctx;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(px + 1, py + 1, c - 2, c - 2, 4);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /** Render a bare board (used for alternative-placement previews). */
  renderStatic(board: Board): void {
    const fake = { board, colors: null, active: null, ghostY: () => 0 } as unknown as Game;
    this.render(fake);
  }

  render(game: Game): void {
    const ctx = this.ctx;
    const w = BOARD_W * this.cell;
    const h = (VISIBLE_H + 1) * this.cell;
    ctx.fillStyle = css('--field-bg');
    ctx.fillRect(0, 0, w, h);

    if (settings.grid) {
      ctx.strokeStyle = css('--field-grid');
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 1; x < BOARD_W; x++) {
        ctx.moveTo(x * this.cell + 0.5, this.cell);
        ctx.lineTo(x * this.cell + 0.5, h);
      }
      for (let y = 0; y < VISIBLE_H; y++) {
        ctx.moveTo(0, this.py(y) + 0.5);
        ctx.lineTo(w, this.py(y) + 0.5);
      }
      ctx.stroke();
    }

    // stack: locked pieces keep their color; unknown cells (pattern boards,
    // previews) fall back to gray
    const stackColor = css('--text-dim');
    for (let y = 0; y <= VISIBLE_H; y++) {
      for (let x = 0; x < BOARD_W; x++) {
        if (game.board.filled(x, y) && y < 26) {
          const t = game.colors?.[y]?.[x];
          if (t) this.drawCell(x, y, PIECE_COLORS[t], 0.95);
          else this.drawCell(x, y, stackColor, 0.85);
        }
      }
    }

    // highlight (last placement / alternative preview)
    if (this.highlight) {
      for (const [x, y] of this.highlight.cells) {
        if (y <= VISIBLE_H) this.drawCell(x, y, this.highlight.color, 0.95);
      }
    }

    // ghost + active piece
    const a = game.active;
    if (a) {
      const color = PIECE_COLORS[a.type];
      if (settings.ghost) {
        const gy = game.ghostY();
        for (const [x, y] of cellsAt(a.type, a.rot, a.x, gy)) {
          if (y <= VISIBLE_H) this.drawCell(x, y, color, 0.25);
        }
      }
      const alpha = 1 - 0.45 * Math.min(1, Math.max(0, this.lockProgress));
      for (const [x, y] of cellsAt(a.type, a.rot, a.x, a.y)) {
        if (y <= VISIBLE_H) this.drawCell(x, y, color, alpha);
      }
    }
  }
}

/** Small static canvas of a piece, for hold/next panes. */
export function renderPieceTile(type: PieceType | null, cell = 18): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  const w = 5 * cell;
  const h = 3 * cell;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  if (!type) return canvas;
  const cells = PIECE_CELLS[type][0];
  const xs = cells.map((c) => c[0]);
  const ys = cells.map((c) => c[1]);
  const cx = (Math.min(...xs) + Math.max(...xs) + 1) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys) + 1) / 2;
  ctx.fillStyle = PIECE_COLORS[type];
  for (const [x, y] of cells) {
    const px = (x - cx) * cell + w / 2;
    const py = (cy - 1 - y) * cell + h / 2;
    ctx.beginPath();
    ctx.roundRect(px + 1, py + 1, cell - 2, cell - 2, 3);
    ctx.fill();
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
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  const w = BOARD_W * cell;
  const h = heightRows * cell;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = css('--field-bg');
  ctx.fillRect(0, 0, w, h);
  const stackColor = css('--text-dim');
  const draw = (x: number, y: number, color: string, alpha: number) => {
    if (y >= heightRows) return;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x * cell + 0.5, (heightRows - 1 - y) * cell + 0.5, cell - 1, cell - 1, 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  };
  for (let y = 0; y < heightRows; y++) {
    for (let x = 0; x < BOARD_W; x++) {
      if (board.filled(x, y)) draw(x, y, stackColor, 0.8);
    }
  }
  if (pieceCells && pieceType) {
    for (const [x, y] of pieceCells) draw(x, y, PIECE_COLORS[pieceType], 1);
  }
  return canvas;
}
