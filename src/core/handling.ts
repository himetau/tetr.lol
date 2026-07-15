// tetr.io-faithful handling. DAS/ARR/DCD in milliseconds processed on the
// render loop with real timestamps, so sub-frame repeat rates (ARR < 16ms)
// work. ARR 0 = instant slide to wall; SDF >= 41 = instant soft drop ("∞").
//
// The DAS charge is a single directional meter that is PRESERVED across a
// direction change while a key is still held (tetr.io's default) — so when
// the meter is already full and you flick to the other side, the piece
// bounces wall-to-wall instantly instead of re-charging from zero. A full
// release (no direction held) drops the charge; the next press starts fresh.
// `cancelDasOnDirChange` reproduces tetr.io's toggle that zeroes the meter on
// every direction change instead. `dcdMs` (DAS Cut Delay) caps the charge
// after a rotate / hold / hard drop so the next input can't instantly DAS.

import type { Game } from './game';

export interface HandlingSettings {
  dasMs: number;
  arrMs: number;
  sdf: number;         // soft drop factor; >= 41 means instant
  softDropCps: number; // base soft-drop cells/sec at SDF 1
  dcdMs: number;       // DAS cut delay (ms); 0 = disabled
  cancelDasOnDirChange: boolean; // zero the DAS charge on every direction change
}

export interface Keybinds {
  left: string[];
  right: string[];
  softDrop: string[];
  hardDrop: string[];
  rotateCW: string[];
  rotateCCW: string[];
  rotate180: string[];
  hold: string[];
  undo: string[];
  retry: string[];
  showPaths: string[];
}

export const DEFAULT_HANDLING: HandlingSettings = {
  dasMs: 130,
  arrMs: 10,
  sdf: 41,
  softDropCps: 30,
  dcdMs: 0,
  cancelDasOnDirChange: false, // tetr.io default: DAS carries, so flicks bounce
};

export const DEFAULT_KEYBINDS: Keybinds = {
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
  softDrop: ['ArrowDown'],
  hardDrop: ['Space'],
  rotateCW: ['ArrowUp', 'KeyX'],
  rotateCCW: ['KeyZ'],
  rotate180: ['KeyA'],
  hold: ['ShiftLeft', 'KeyC'],
  undo: ['Ctrl+KeyZ'],
  retry: ['KeyR'],
  showPaths: ['Tab'],
};

/** Keybind descriptor for a keyboard event: 'KeyZ' or 'Ctrl+KeyZ'.
 * Shift is not a combo modifier (it is commonly a bind by itself). */
export function keyDescriptor(e: KeyboardEvent): string {
  const c = e.code;
  if (/^(Control|Alt|Meta|Shift)/.test(c)) return c;
  let d = '';
  if (e.ctrlKey) d += 'Ctrl+';
  if (e.altKey) d += 'Alt+';
  return d + c;
}

type Dir = -1 | 1;

export class InputHandler {
  settings: HandlingSettings = { ...DEFAULT_HANDLING };
  binds: Keybinds = structuredClone(DEFAULT_KEYBINDS);
  enabled = true;

  onAction: ((action: keyof Keybinds) => void) | null = null;

  private held = new Set<string>();
  private dirStack: Dir[] = [];       // most recent direction last
  private dasTimer = 0;               // ms charged toward DAS in the active dir
  private arrTimer = 0;               // ms accumulated toward the next ARR step
  private softDropHeld = false;
  private sdAccum = 0;
  private lastTime = 0;

  constructor(private game: Game) {}

  private codeAction(code: string): keyof Keybinds | null {
    const b = this.binds;
    for (const k of Object.keys(b) as (keyof Keybinds)[]) {
      if (b[k].includes(code)) return k;
    }
    return null;
  }

  keyDown(code: string, _time: number): void {
    if (this.held.has(code)) return; // ignore key repeat
    this.held.add(code);
    if (!this.enabled) return;
    const action = this.codeAction(code);
    if (!action) return;
    switch (action) {
      case 'left':
      case 'right': {
        const dir: Dir = action === 'left' ? -1 : 1;
        const wasIdle = this.dirStack.length === 0;
        this.dirStack = this.dirStack.filter((d) => d !== dir);
        this.dirStack.push(dir);
        if (wasIdle) {
          // fresh press from rest: charge starts from zero
          this.dasTimer = 0;
          this.arrTimer = 0;
          this.step(dir);
        } else {
          // direction change with a key still held: bounce-aware
          this.changeDirection();
        }
        break;
      }
      case 'softDrop':
        this.softDropHeld = true;
        this.sdAccum = 0;
        if (this.settings.sdf >= 41) this.game.softDropToFloor();
        break;
      case 'hardDrop':
        this.game.hardDrop();
        this.applyCut();
        break;
      case 'rotateCW':
        this.game.rotate(1);
        this.applyCut();
        break;
      case 'rotateCCW':
        this.game.rotate(-1);
        this.applyCut();
        break;
      case 'rotate180':
        this.game.rotate(2);
        this.applyCut();
        break;
      case 'hold':
        this.game.holdPiece();
        this.applyCut();
        break;
      default:
        break;
    }
    this.onAction?.(action);
  }

  keyUp(code: string, _time: number): void {
    this.held.delete(code);
    const action = this.codeAction(code);
    if (action === 'left' || action === 'right') {
      const dir: Dir = action === 'left' ? -1 : 1;
      this.dirStack = this.dirStack.filter((d) => d !== dir);
      // reverting to a still-held opposite direction is a direction change;
      // the DAS charge carries (bounce) unless the toggle cancels it
      if (this.dirStack.length > 0) this.changeDirection();
    } else if (action === 'softDrop') {
      this.softDropHeld = false;
    }
  }

  /** A direction change while a key stays held: tap one cell, keep the DAS
   * charge so a full meter bounces the piece to the other wall. */
  private changeDirection(): void {
    const dir = this.dirStack[this.dirStack.length - 1];
    if (dir === undefined) return;
    this.step(dir);
    this.arrTimer = 0;
    if (this.settings.cancelDasOnDirChange) this.dasTimer = 0;
    // already charged + instant ARR: bounce to the wall this frame, no delay
    if (!this.settings.cancelDasOnDirChange
      && this.dasTimer >= this.settings.dasMs
      && this.settings.arrMs <= 0) {
      this.slideToWall(dir);
    }
  }

  /** DAS Cut Delay: after a rotate / hold / hard drop, cap the charge so the
   * next auto-shift can't fire until DCD more ms have accrued. Off when 0. */
  private applyCut(): void {
    this.arrTimer = 0;
    const dcd = this.settings.dcdMs;
    if (dcd > 0) {
      const cap = Math.max(0, this.settings.dasMs - dcd);
      if (this.dasTimer > cap) this.dasTimer = cap;
    }
  }

  private step(dir: Dir): void {
    if (dir === -1) this.game.moveLeft();
    else this.game.moveRight();
    if (this.softDropHeld && this.settings.sdf >= 41) this.game.softDropToFloor();
  }

  private slideToWall(dir: Dir): void {
    let moved = true;
    while (moved) moved = dir === -1 ? this.game.moveLeft() : this.game.moveRight();
    if (this.softDropHeld && this.settings.sdf >= 41) this.game.softDropToFloor();
  }

  /** Call every frame with performance.now(). */
  update(time: number): void {
    if (!this.enabled) { this.lastTime = time; return; }
    const dt = this.lastTime ? time - this.lastTime : 0;
    this.lastTime = time;

    const dir = this.dirStack[this.dirStack.length - 1];
    if (dir !== undefined) {
      this.dasTimer += dt;
      if (this.dasTimer >= this.settings.dasMs) {
        if (this.settings.arrMs <= 0) {
          this.slideToWall(dir);
        } else {
          // credit only the time spent past DAS (partial on the frame DAS
          // completes, full dt afterwards) so the repeat rate stays exact
          this.arrTimer += Math.min(dt, this.dasTimer - this.settings.dasMs);
          while (this.arrTimer >= this.settings.arrMs) {
            this.arrTimer -= this.settings.arrMs;
            this.step(dir);
          }
        }
      }
    }

    if (this.softDropHeld) {
      if (this.settings.sdf >= 41) {
        this.game.softDropToFloor();
      } else {
        const cps = this.settings.softDropCps * this.settings.sdf;
        this.sdAccum += (dt / 1000) * cps;
        while (this.sdAccum >= 1) {
          this.sdAccum -= 1;
          this.game.softDropStep();
        }
      }
    }
  }
}
