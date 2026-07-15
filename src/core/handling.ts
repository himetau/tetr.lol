// tetr.io-style handling: DAS/ARR in milliseconds processed on the render
// loop with real timestamps, so sub-frame repeat rates (ARR < 16ms) work.
// ARR 0 = instant slide to wall; SDF >= 41 = instant soft drop (tetr.io "∞").

import type { Game } from './game';

export interface HandlingSettings {
  dasMs: number;
  arrMs: number;
  sdf: number;        // soft drop factor; >= 41 means instant
  softDropCps: number; // base soft-drop cells/sec at SDF 1
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
  private dasStart = 0;               // when the current direction was pressed
  private arrAccum = 0;
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

  keyDown(code: string, time: number): void {
    if (this.held.has(code)) return; // ignore key repeat
    this.held.add(code);
    if (!this.enabled) return;
    const action = this.codeAction(code);
    if (!action) return;
    switch (action) {
      case 'left':
      case 'right': {
        const dir: Dir = action === 'left' ? -1 : 1;
        this.dirStack = this.dirStack.filter((d) => d !== dir);
        this.dirStack.push(dir);
        this.dasStart = time;
        this.arrAccum = 0;
        this.step(dir);
        break;
      }
      case 'softDrop':
        this.softDropHeld = true;
        this.sdAccum = 0;
        if (this.settings.sdf >= 41) this.game.softDropToFloor();
        break;
      case 'hardDrop':
        this.game.hardDrop();
        this.resetCharge(time);
        break;
      case 'rotateCW':
        this.game.rotate(1);
        break;
      case 'rotateCCW':
        this.game.rotate(-1);
        break;
      case 'rotate180':
        this.game.rotate(2);
        break;
      case 'hold':
        this.game.holdPiece();
        this.resetCharge(time);
        break;
      default:
        break;
    }
    this.onAction?.(action);
  }

  keyUp(code: string, time: number): void {
    this.held.delete(code);
    const action = this.codeAction(code);
    if (action === 'left' || action === 'right') {
      const dir: Dir = action === 'left' ? -1 : 1;
      this.dirStack = this.dirStack.filter((d) => d !== dir);
      // A still-held opposite direction re-charges DAS from now.
      if (this.dirStack.length > 0) {
        this.dasStart = time;
        this.arrAccum = 0;
        this.step(this.dirStack[this.dirStack.length - 1]);
      }
    } else if (action === 'softDrop') {
      this.softDropHeld = false;
    }
  }

  /** After hard drop / hold, keep DAS charged (tetr.io keeps charge; DCD=0). */
  private resetCharge(_time: number): void {
    this.arrAccum = 0;
  }

  private step(dir: Dir): void {
    if (dir === -1) this.game.moveLeft();
    else this.game.moveRight();
    if (this.softDropHeld && this.settings.sdf >= 41) this.game.softDropToFloor();
  }

  /** Call every frame with performance.now(). */
  update(time: number): void {
    if (!this.enabled) { this.lastTime = time; return; }
    const dt = this.lastTime ? time - this.lastTime : 0;
    this.lastTime = time;

    const dir = this.dirStack[this.dirStack.length - 1];
    if (dir !== undefined) {
      const heldFor = time - this.dasStart;
      if (heldFor >= this.settings.dasMs) {
        if (this.settings.arrMs <= 0) {
          // instant: slide to wall
          let moved = true;
          while (moved) moved = dir === -1 ? this.game.moveLeft() : this.game.moveRight();
          if (this.softDropHeld && this.settings.sdf >= 41) this.game.softDropToFloor();
        } else {
          this.arrAccum += dt;
          while (this.arrAccum >= this.settings.arrMs) {
            this.arrAccum -= this.settings.arrMs;
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
