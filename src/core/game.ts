import { Board, BOARD_H, BOARD_W } from './board';
import { cellsAt, type Cell, type PieceType, type Rot } from './pieces';
import { tryRotate } from './srs';
import { detectSpin, type SpinKind } from './spin';
import { SevenBag, type BagState } from './rng';

export interface ActivePiece {
  type: PieceType;
  rot: Rot;
  x: number;
  y: number;
}

export interface LockEvent {
  piece: PieceType;
  rot: Rot;
  x: number;
  y: number;
  cells: Cell[];          // absolute cells stamped (pre-clear)
  spin: SpinKind;
  linesCleared: number;
  boardBefore: Board;     // board before the piece was stamped
  colorsBefore: (PieceType | null)[][]; // per-cell piece colors, pre-stamp
  boardAfter: Board;      // board after stamping + clears
  queueBefore: PieceType[]; // preview at decision time (piece spawn)
  holdBefore: PieceType | null;
  usedHold: boolean;
  pieceIndex: number;     // 0-based count of locked pieces
}

// State at the moment a piece (decision point) spawned, for undo.
interface Snapshot {
  board: Board;
  colors: (PieceType | null)[][];
  hold: PieceType | null;
  activeType: PieceType;
  queueRest: PieceType[]; // queue after the active piece was taken from it
  bag: BagState; // bag rewound with the queue so undo doesn't leak drawn pieces
  pieceIndex: number;
}

function emptyColors(): (PieceType | null)[][] {
  return Array.from({ length: BOARD_H }, () => new Array<PieceType | null>(BOARD_W).fill(null));
}

export const SPAWN_X = 4;
// low enough that the whole piece (incl. its top row) is inside the
// rendered area instead of hanging half-clipped above the field
export const SPAWN_Y = 19;
export const PREVIEW_N = 5;

export class Game {
  board = new Board();
  /** per-cell piece colors for the locked stack (null = gray/unknown) */
  colors = emptyColors();
  active: ActivePiece | null = null;
  hold: PieceType | null = null;
  canHold = true;
  pieceIndex = 0;
  onLock: ((ev: LockEvent) => void) | null = null;
  /** successful piece movement (lock-delay reset hook for gravity modes) */
  onMove: ((kind: 'shift' | 'rotate' | 'drop') => void) | null = null;
  topOut = false;

  private bag: SevenBag;
  private queue: PieceType[] = [];
  private lastMoveWasRotation = false;
  private lastKickIndex = 0;
  private usedHoldThisPiece = false;
  private history: Snapshot[] = [];
  private current: Snapshot | null = null; // snapshot of the live decision point

  constructor(seed?: number) {
    this.bag = new SevenBag(seed);
    this.refillQueue();
    this.spawn();
  }

  private refillQueue(): void {
    while (this.queue.length < PREVIEW_N + 1) this.queue.push(this.bag.next());
  }

  preview(): PieceType[] {
    return this.queue.slice(0, PREVIEW_N);
  }

  /** Board + current piece + queue snapshot for the analysis engine. */
  analysisState() {
    return {
      rows: Array.from(this.board.rows),
      active: this.active ? { ...this.active } : null,
      queue: this.preview(),
      hold: this.hold,
      canHold: this.canHold,
      pieceIndex: this.pieceIndex,
    };
  }

  /**
   * Spawn a piece. `realSpawn` marks a new decision point (records the undo
   * snapshot); hold-swaps pass false so undo rewinds to before the hold.
   */
  private spawn(type?: PieceType, realSpawn = true): boolean {
    const t = type ?? this.queue.shift()!;
    this.refillQueue();
    if (realSpawn) {
      this.current = {
        board: this.board.clone(),
        colors: this.colors.map((r) => [...r]),
        hold: this.hold,
        activeType: t,
        queueRest: [...this.queue],
        bag: this.bag.getState(),
        pieceIndex: this.pieceIndex,
      };
      this.usedHoldThisPiece = false;
    }
    this.active = { type: t, rot: 0, x: SPAWN_X, y: SPAWN_Y };
    this.lastMoveWasRotation = false;
    if (this.board.collides(cellsAt(t, 0, SPAWN_X, SPAWN_Y))) {
      this.topOut = true;
      this.active = null;
      return false;
    }
    return true;
  }

  private tryShift(dx: number, dy: number): boolean {
    const a = this.active;
    if (!a) return false;
    if (this.board.collides(cellsAt(a.type, a.rot, a.x + dx, a.y + dy))) return false;
    a.x += dx;
    a.y += dy;
    this.lastMoveWasRotation = false;
    this.onMove?.(dy < 0 ? 'drop' : 'shift');
    return true;
  }

  moveLeft(): boolean { return this.tryShift(-1, 0); }
  moveRight(): boolean { return this.tryShift(1, 0); }
  softDropStep(): boolean { return this.tryShift(0, -1); }

  softDropToFloor(): number {
    let n = 0;
    while (this.tryShift(0, -1)) n++;
    return n;
  }

  rotate(dir: 1 | -1 | 2): boolean {
    const a = this.active;
    if (!a) return false;
    const res = tryRotate(this.board, a.type, a.rot, a.x, a.y, dir);
    if (!res) return false;
    a.x = res.x;
    a.y = res.y;
    a.rot = res.rot;
    this.lastMoveWasRotation = true;
    this.lastKickIndex = res.kickIndex;
    this.onMove?.('rotate');
    return true;
  }

  holdPiece(): boolean {
    if (!this.canHold || !this.active) return false;
    const cur = this.active.type;
    const swap = this.hold;
    this.hold = cur;
    this.canHold = false;
    this.usedHoldThisPiece = true;
    this.spawn(swap ?? undefined, false);
    return true;
  }

  ghostY(): number {
    const a = this.active;
    if (!a) return 0;
    let y = a.y;
    while (!this.board.collides(cellsAt(a.type, a.rot, a.x, y - 1))) y--;
    return y;
  }

  hardDrop(): LockEvent | null {
    const a = this.active;
    if (!a) return null;
    const gy = this.ghostY();
    if (gy !== a.y) {
      a.y = gy;
      this.lastMoveWasRotation = false;
    }
    return this.lock();
  }

  /** Place the active piece exactly at `cells`, performing a hold first if the
   * piece isn't in hand. Locks with the given spin kind (a trusted external
   * verdict, e.g. from Cold Clear) rather than re-detecting it. For "watch the
   * bot" playback. */
  applyMove(piece: PieceType, cells: [number, number][], spin: SpinKind): LockEvent | null {
    let a = this.active;
    if (!a) return null;
    if (a.type !== piece) {
      if (!this.canHold || !this.holdPiece()) return null;
      a = this.active;
      if (!a || a.type !== piece) return null;
    }
    if (!this.placeActiveAt(cells)) return null;
    return this.lock(spin);
  }

  /** Orient/position the active piece so its cells match `cells` exactly. */
  private placeActiveAt(cells: [number, number][]): boolean {
    const a = this.active;
    if (!a) return false;
    const want = cells.map(([x, y]) => x * 64 + y).sort((p, q) => p - q);
    for (let rot = 0 as Rot; rot < 4; rot = (rot + 1) as Rot) {
      const base = cellsAt(a.type, rot, 0, 0);
      for (const [tx, ty] of cells) {
        for (const [bx, by] of base) {
          const ox = tx - bx;
          const oy = ty - by;
          const got = cellsAt(a.type, rot, ox, oy).map(([x, y]) => x * 64 + y).sort((p, q) => p - q);
          if (got.length === want.length && got.every((v, i) => v === want[i])) {
            a.rot = rot;
            a.x = ox;
            a.y = oy;
            return true;
          }
        }
      }
    }
    return false;
  }

  private lock(spinOverride?: SpinKind): LockEvent | null {
    const a = this.active;
    const snap = this.current;
    if (!a || !snap) return null;
    this.history.push(snap);

    const boardBefore = this.board.clone();
    const colorsBefore = this.colors.map((r) => [...r]);
    const cells = cellsAt(a.type, a.rot, a.x, a.y);
    const spin = spinOverride ?? detectSpin(this.board, a.type, a.rot, a.x, a.y, this.lastMoveWasRotation, this.lastKickIndex);
    this.board.place(cells);
    for (const [cx, cy] of cells) {
      if (cy >= 0 && cy < BOARD_H) this.colors[cy][cx] = a.type;
    }
    const cleared = this.board.clearLines();
    for (let i = cleared.length - 1; i >= 0; i--) this.colors.splice(cleared[i], 1);
    while (this.colors.length < BOARD_H) this.colors.push(new Array<PieceType | null>(BOARD_W).fill(null));

    const ev: LockEvent = {
      piece: a.type,
      rot: a.rot,
      x: a.x,
      y: a.y,
      cells,
      spin,
      linesCleared: cleared.length,
      boardBefore,
      colorsBefore,
      boardAfter: this.board.clone(),
      queueBefore: [snap.activeType, ...snap.queueRest].slice(0, PREVIEW_N + 1),
      holdBefore: snap.hold,
      usedHold: this.usedHoldThisPiece,
      pieceIndex: this.pieceIndex,
    };

    this.pieceIndex++;
    this.canHold = true;
    this.spawn();
    this.onLock?.(ev);
    return ev;
  }

  /** Push garbage rows in from the bottom (quick play / versus). Lifts the
   * active piece if the stack shoves into it; tops out only when the stack is
   * genuinely buried past the ceiling, or the piece cannot be nudged back
   * inside the field.
   *
   * Deliberately does NOT top out on the active piece's *origin* leaving the
   * field the way the old code did: that both killed unfairly when you took
   * garbage near the top and, when it didn't fire, left the piece hovering
   * invisibly in the buffer forever ("floating, not really dead"). Death is
   * now decided by real cells and real stack height. */
  addGarbage(holes: number[]): void {
    const n = holes.length;
    if (n === 0) return;
    // Buried: rows that would be shoved above the top of the field are lost —
    // that is a top out (you got sealed under the garbage). Measured before
    // insertion, since insertGarbage silently discards the overflow.
    const buried = this.board.maxHeight() + n > BOARD_H;
    this.board.insertGarbage(holes);
    this.colors.splice(BOARD_H - n, n);
    for (let i = 0; i < n; i++) this.colors.unshift(new Array<PieceType | null>(BOARD_W).fill(null));
    if (buried) {
      this.topOut = true;
      this.active = null;
      return;
    }
    const a = this.active;
    if (a) {
      // rise the garbage under the piece: nudge it up out of collision, but
      // only declare a lock-out once the whole piece is pushed clear out of
      // the field (its lowest cell reaches the ceiling)
      while (this.board.collides(cellsAt(a.type, a.rot, a.x, a.y))) {
        a.y++;
        const lowest = Math.min(...cellsAt(a.type, a.rot, a.x, a.y).map(([, cy]) => cy));
        if (lowest >= BOARD_H) {
          this.topOut = true;
          this.active = null;
          return;
        }
      }
    }
  }

  /** Rewind one locked piece (to its spawn-time decision point). */
  undo(): boolean {
    const snap = this.history.pop();
    if (!snap) return false;
    this.board = snap.board.clone();
    this.colors = snap.colors.map((r) => [...r]);
    this.hold = snap.hold;
    this.canHold = true;
    this.pieceIndex = snap.pieceIndex;
    this.topOut = false;
    this.queue = [...snap.queueRest];
    this.bag.setState(snap.bag);
    this.refillQueue();
    this.spawn(snap.activeType, true);
    return true;
  }

  get undoDepth(): number {
    return this.history.length;
  }

  /** Replace the whole game state (used by drills to set up a board). */
  reset(board?: Board, seed?: number, queueOverride?: PieceType[]): void {
    this.board = board ?? new Board();
    this.colors = emptyColors();
    this.hold = null;
    this.canHold = true;
    this.pieceIndex = 0;
    this.topOut = false;
    this.history = [];
    this.bag = new SevenBag(seed);
    this.queue = queueOverride ? [...queueOverride] : [];
    this.refillQueue();
    this.spawn();
  }
}
