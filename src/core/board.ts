import type { Cell } from "./pieces";

export const BOARD_W = 10;
export const BOARD_H = 26; // 20 visible + hidden rows above
export const VISIBLE_H = 20;

const FULL_ROW = (1 << BOARD_W) - 1;

// Row 0 is the bottom. Bit x of rows[y] = cell at column x.
export class Board {
  rows: Uint32Array;

  constructor(rows?: Uint32Array) {
    this.rows = rows ?? new Uint32Array(BOARD_H);
  }

  clone(): Board {
    return new Board(this.rows.slice());
  }

  filled(x: number, y: number): boolean {
    // walls and the floor count as filled
    if (x < 0 || x >= BOARD_W || y < 0) {
      return true;
    }
    if (y >= BOARD_H) {
      return false;
    }
    return ((this.rows[y] >>> x) & 1) === 1;
  }

  collides(cells: Cell[]): boolean {
    for (const [x, y] of cells) {
      if (this.filled(x, y)) {
        return true;
      }
    }
    return false;
  }

  place(cells: Cell[]): void {
    for (const [x, y] of cells) {
      if (y >= 0 && y < BOARD_H) {
        this.rows[y] |= 1 << x;
      }
    }
  }

  /** Clears full rows, returns the cleared row indices (bottom-up, pre-clear). */
  clearLines(): number[] {
    const cleared: number[] = [];
    let dst = 0;
    for (let y = 0; y < BOARD_H; y++) {
      if (this.rows[y] === FULL_ROW) {
        cleared.push(y);
      } else {
        this.rows[dst++] = this.rows[y];
      }
    }
    while (dst < BOARD_H) {
      this.rows[dst++] = 0;
    }
    return cleared;
  }

  /** Insert garbage rows at the bottom, pushing the stack up.
   * holes[i] = the open column of the i-th inserted row (bottom-up). */
  insertGarbage(holes: number[]): void {
    const n = holes.length;
    if (n === 0) {
      return;
    }
    for (let y = BOARD_H - 1; y >= n; y--) {
      this.rows[y] = this.rows[y - n];
    }
    for (let i = 0; i < n; i++) {
      this.rows[i] = FULL_ROW & ~(1 << holes[i]);
    }
  }

  /** Tallest column, optionally ignoring a column bitmask (4-wide's
   * infinite walls would otherwise read as a full board). */
  maxHeight(ignoreCols = 0): number {
    for (let y = BOARD_H - 1; y >= 0; y--) {
      if ((this.rows[y] & ~ignoreCols) !== 0) {
        return y + 1;
      }
    }
    return 0;
  }

  columnHeight(x: number): number {
    for (let y = BOARD_H - 1; y >= 0; y--) {
      if ((this.rows[y] >>> x) & 1) {
        return y + 1;
      }
    }
    return 0;
  }

  isEmpty(): boolean {
    for (let y = 0; y < BOARD_H; y++) {
      if (this.rows[y] !== 0) {
        return false;
      }
    }
    return true;
  }

  cellCount(): number {
    let n = 0;
    for (let y = 0; y < BOARD_H; y++) {
      let r = this.rows[y];
      while (r) {
        n += r & 1;
        r >>>= 1;
      }
    }
    return n;
  }

  key(): string {
    return this.rows.join(",");
  }

  static fromStrings(lines: string[]): Board {
    // lines are top-down, 'X'/'#' = filled, anything else empty; e.g.
    // ["X_________", "XX________"]
    const b = new Board();
    const h = lines.length;
    for (let i = 0; i < h; i++) {
      const y = h - 1 - i;
      for (let x = 0; x < Math.min(BOARD_W, lines[i].length); x++) {
        const c = lines[i][x];
        if (c === "X" || c === "#") {
          b.rows[y] |= 1 << x;
        }
      }
    }
    return b;
  }

  toStrings(height?: number): string[] {
    const h = height ?? Math.max(1, this.maxHeight());
    const out: string[] = [];
    for (let y = h - 1; y >= 0; y--) {
      let s = "";
      for (let x = 0; x < BOARD_W; x++) {
        s += (this.rows[y] >>> x) & 1 ? "X" : "_";
      }
      out.push(s);
    }
    return out;
  }
}
