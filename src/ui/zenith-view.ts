// Quick play: a single-player simulator of TETR.IO QUICK PLAY (Zenith
// Tower) at a chosen starting altitude — per-floor gravity/lock delay,
// bot-generated garbage pressure, climb speed, and altitude scoring.
// No grading here: this mode is for feeling out the speed, not the loop.

import { Game, type LockEvent } from '../core/game';
import { cellsAt } from '../core/pieces';
import { InputHandler, keyDescriptor, type Keybinds } from '../core/handling';
import { FieldRenderer, renderPieceTile } from './board-canvas';
import { settings, onSettingsChange } from './settings';
import { ZenithRun, FLOORS, floorIndexAt, type Pressure } from '../core/zenith';
import {
  lockSound, clearSound, comboSound, garbageSound, garbageQueuedSound, actionSound,
  b2bBreakSound, spinSound, comboBreakSound, countdownSound, goSound, damageAlertSound,
  dangerSound, clutchSound, levelUpSound, personalBestSound, gameOverSound,
} from './sound';
import { stats, saveStats, recordSession } from './stats';
import { actionText, lockActionLabel, clearedRowsOf } from './fx';
import { PIECE_COLORS } from '../core/pieces';

export class ZenithView {
  readonly root: HTMLElement;
  private game = new Game();
  private input: InputHandler;
  private renderer: FieldRenderer;
  private rafId = 0;
  private lastT = 0;
  private unsubSettings: () => void;

  private run: ZenithRun | null = null;
  private gravAcc = 0;
  private lockTimerMs = 0;
  // guideline Extended Placement Lock Down: the timer resets on successful
  // moves/rotations, at most 15 times; falling to a new lowest row restores
  // the budget
  private moveResets = 0;
  private lowestY = Infinity;
  private pieces = 0;
  private tsds = 0;
  private tsses = 0;

  // launch options (kept across retries)
  private startAltitude = 0;
  private pressure: Pressure = 'normal';
  private gravityMod = false;

  private fieldPanel!: HTMLElement;
  private holdBox!: HTMLElement;
  private queueBox!: HTMLElement;
  private hud!: HTMLElement;
  private toast!: HTMLElement;
  private overlay!: HTMLElement;
  private b2bTag!: HTMLElement;
  private gmActive!: HTMLElement;
  private gmQueued!: HTMLElement;
  private toastTimer = 0;
  private lastIncoming = 0;
  // countdown before the run goes live (input + clock held until "go")
  private countdownTimers: number[] = [];
  private counting = false;
  // immersion cues: floor advance, altitude PB, stack-danger alarm
  private lastFloor = 0;
  private bestAltitude = 0;
  private pbPlayed = true;
  private inDanger = false;

  private keydown = (e: KeyboardEvent) => this.onKeyDown(e);
  private keyup = (e: KeyboardEvent) => this.input.keyUp(e.code, performance.now());

  constructor() {
    this.input = new InputHandler(this.game);
    this.input.settings = settings.handling;
    this.input.binds = settings.binds;
    this.input.onAction = (a) => {
      if (a === 'hold') {
        this.resetLockdown();
        // the hold/next panes swap the instant you hold, like tetr.io
        this.refreshPanes();
      }
      if (settings.soundFx && this.run) actionSound(a);
    };
    // lock-delay resets come from *successful* moves only (guideline EPLD)
    this.game.onMove = (kind) => {
      if (kind === 'drop') return; // soft drop never resets the timer
      if (this.moveResets < 15) {
        this.moveResets++;
        this.lockTimerMs = 0;
      }
    };
    this.renderer = new FieldRenderer(this.cellSize());
    this.root = this.build();
    this.game.onLock = (ev) => this.onLock(ev);
    this.unsubSettings = onSettingsChange(() => {
      this.input.settings = settings.handling;
      this.input.binds = settings.binds;
      this.renderer.setCellSize(this.cellSize());
    });
    this.showLaunch();
    document.addEventListener('keydown', this.keydown);
    document.addEventListener('keyup', this.keyup);
    this.loop(performance.now());
  }

  destroy(): void {
    // leaving mid-climb abandons the run — only topped-out runs are recorded
    this.endRun(false);
    cancelAnimationFrame(this.rafId);
    this.unsubSettings();
    document.removeEventListener('keydown', this.keydown);
    document.removeEventListener('keyup', this.keyup);
  }

  private cellSize(): number {
    const fit = Math.max(14, Math.min(34, Math.floor((window.innerHeight - 140) / 21)));
    const zoomed = Math.round(fit * (settings.boardZoom / 100));
    return Math.max(10, Math.min(44, zoomed));
  }

  private build(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'game-wrap';
    const colW = `${Math.max(130, 5 * Math.round(this.cellSize() * 0.68) + 24)}px`;

    const left = document.createElement('div');
    left.className = 'side-col';
    left.style.width = colW;
    this.holdBox = panel('Hold');
    left.appendChild(this.holdBox);
    const runPanel = panel('Run');
    this.hud = document.createElement('div');
    this.hud.className = 'zenith-hud';
    runPanel.appendChild(this.hud);
    left.appendChild(runPanel);
    const controls = document.createElement('div');
    controls.className = 'drill-controls';
    controls.style.flexDirection = 'column';
    controls.append(
      btn('Retry (R)', () => this.startRun()),
      btn('Change floor (Esc)', () => this.showLaunch()),
    );
    left.appendChild(controls);

    this.fieldPanel = document.createElement('div');
    this.fieldPanel.className = 'field-panel';
    const row = document.createElement('div');
    row.className = 'field-row';
    const strip = document.createElement('div');
    strip.className = 'board-strip';
    this.b2bTag = document.createElement('div');
    this.b2bTag.className = 'b2b-tag';
    const meter = document.createElement('div');
    meter.className = 'gmeter';
    this.gmQueued = document.createElement('div');
    this.gmQueued.className = 'gm-queued';
    this.gmActive = document.createElement('div');
    this.gmActive.className = 'gm-active';
    meter.append(this.gmQueued, this.gmActive);
    strip.append(this.b2bTag, meter);
    row.append(strip, this.renderer.canvas);
    this.fieldPanel.appendChild(row);
    this.toast = document.createElement('div');
    this.toast.className = 'reason-toast';
    this.overlay = document.createElement('div');
    this.overlay.className = 'zenith-overlay';
    this.fieldPanel.append(this.toast, this.overlay);

    const right = document.createElement('div');
    right.className = 'side-col';
    right.style.width = colW;
    this.queueBox = panel('Next');
    right.appendChild(this.queueBox);

    wrap.append(left, this.fieldPanel, right);
    return wrap;
  }

  // ---- launch / end overlays ----

  private showLaunch(): void {
    this.endRun(false);
    this.input.enabled = false;
    this.overlay.replaceChildren();
    this.overlay.classList.add('show');

    const box = document.createElement('div');
    box.className = 'zenith-box qp-menu';
    const head = document.createElement('div');
    head.className = 'qp-head';
    head.innerHTML = `<h2>Quick play</h2>
      <p class="sub">Zenith-style climb at your chosen altitude — garbage pressure is simulated, no live opponents.</p>`;
    box.appendChild(head);

    // floor cards — pick your starting altitude, tetr.io-style
    const grid = document.createElement('div');
    grid.className = 'qp-floors';
    let selectedBtn: HTMLElement | null = null;
    FLOORS.forEach((f, i) => {
      const b = document.createElement('button');
      b.className = 'floor-btn qp-floor';
      b.style.setProperty('--fc', floorColor(i));
      b.style.setProperty('--d', `${i * 34}ms`);
      b.innerHTML =
        `<span class="qp-fnum">F${i + 1}</span>` +
        `<span class="qp-fname">${f.name}</span>` +
        `<span class="qp-falt">${f.from}m</span>`;
      if (f.from === this.startAltitude) {
        b.classList.add('primary');
        selectedBtn = b;
      }
      b.addEventListener('click', () => {
        selectedBtn?.classList.remove('primary');
        selectedBtn = b;
        b.classList.add('primary');
        this.startAltitude = f.from;
        if (settings.soundFx) actionSound('rotateCW');
      });
      grid.appendChild(b);
    });
    box.appendChild(grid);

    // options: garbage pressure as a segmented control + a gravity-mod pill
    const opts = document.createElement('div');
    opts.className = 'qp-opts';

    const pressGroup = document.createElement('div');
    pressGroup.className = 'qp-opt';
    const pressLabel = document.createElement('span');
    pressLabel.className = 'qp-opt-label';
    pressLabel.textContent = 'Garbage';
    const seg = document.createElement('div');
    seg.className = 'qp-seg';
    const segBtns: HTMLElement[] = [];
    for (const [v, label] of [['calm', 'calm'], ['normal', 'normal'], ['brutal', 'brutal']] as const) {
      const sb = document.createElement('button');
      sb.className = 'qp-seg-btn' + (v === this.pressure ? ' on' : '');
      sb.textContent = label;
      sb.addEventListener('click', () => {
        this.pressure = v as Pressure;
        for (const el of segBtns) el.classList.remove('on');
        sb.classList.add('on');
        if (settings.soundFx) actionSound('left');
      });
      segBtns.push(sb);
      seg.appendChild(sb);
    }
    pressGroup.append(pressLabel, seg);

    const gmod = document.createElement('button');
    gmod.className = 'qp-toggle' + (this.gravityMod ? ' on' : '');
    gmod.innerHTML = `<span class="qp-toggle-dot"></span><span>Gravity mod<small>0.48G → 3.18G</small></span>`;
    gmod.addEventListener('click', () => {
      this.gravityMod = !this.gravityMod;
      gmod.classList.toggle('on', this.gravityMod);
      if (settings.soundFx) actionSound('move');
    });
    opts.append(pressGroup, gmod);
    box.appendChild(opts);

    const start = document.createElement('button');
    start.className = 'btn primary qp-start';
    start.textContent = 'Start climb';
    start.addEventListener('click', () => this.startRun());
    box.appendChild(start);

    this.overlay.appendChild(box);
    this.hud.innerHTML = `<div class="alt">—</div>`;
  }

  private showResults(): void {
    const r = this.run;
    if (!r) return;
    this.overlay.replaceChildren();
    this.overlay.classList.add('show');
    const box = document.createElement('div');
    box.className = 'zenith-box';
    const f = FLOORS[floorIndexAt(r.altitude)];
    box.innerHTML = `<h2>${Math.round(r.altitude)}m</h2>
      <p class="sub">${f.name} · ${fmtTime(r.timeMs)} · ${this.pieces} pieces · ${r.linesSent} sent</p>`;
    const row = document.createElement('div');
    row.className = 'zenith-opts';
    row.append(
      btn('Retry (R)', () => this.startRun()),
      btn('Change floor', () => this.showLaunch()),
    );
    box.appendChild(row);
    this.overlay.appendChild(box);
  }

  private startRun(): void {
    // retry restarts the run outright — an abandoned climb records nothing
    this.endRun(false);
    this.overlay.classList.remove('show');
    this.overlay.replaceChildren();
    this.game.reset();
    this.run = new ZenithRun(this.startAltitude, this.pressure, this.gravityMod);
    this.gravAcc = 0;
    this.resetLockdown();
    this.pieces = 0;
    this.tsds = 0;
    this.tsses = 0;
    this.lastIncoming = 0;
    this.b2bTag.textContent = '';
    this.gmActive.style.height = '0px';
    this.gmQueued.style.height = '0px';
    this.lastFloor = floorIndexAt(this.startAltitude);
    this.inDanger = false;
    // PB jingle only when there is a real record to chase from below
    this.bestAltitude = Math.max(0, ...stats.sessions.filter((s) => s.mode === 'quick').map((s) => s.altitude ?? 0));
    this.pbPlayed = this.bestAltitude < Math.max(50, this.startAltitude + 10);
    this.beginCountdown();
    this.refreshPanes();
    this.updateHud();
  }

  /** 3-2-1-go before the clock and input go live; retry/Esc cancels it. */
  private beginCountdown(): void {
    this.clearCountdown();
    this.counting = true;
    this.input.enabled = false;
    const digit = document.createElement('div');
    digit.className = 'zenith-count';
    this.overlay.replaceChildren(digit);
    this.overlay.classList.add('show', 'counting');
    const step = (n: 1 | 2 | 3) => {
      digit.textContent = String(n);
      digit.classList.remove('tick');
      void digit.offsetWidth; // restart the pop animation
      digit.classList.add('tick');
      if (settings.soundFx) countdownSound(n);
    };
    step(3);
    this.countdownTimers = [
      window.setTimeout(() => step(2), 450),
      window.setTimeout(() => step(1), 900),
      window.setTimeout(() => {
        this.clearCountdown();
        this.overlay.classList.remove('show');
        this.overlay.replaceChildren();
        this.input.enabled = true;
        if (settings.soundFx) goSound();
      }, 1350),
    ];
  }

  private clearCountdown(): void {
    for (const t of this.countdownTimers) clearTimeout(t);
    this.countdownTimers = [];
    this.counting = false;
    this.overlay.classList.remove('counting');
  }

  /**
   * Close out the active run. Only a naturally finished (topped-out) run
   * persists — its pieces/TSDs fold into lifetime stats here, so abandoned
   * runs leave no trace in the charts or totals.
   */
  private endRun(persist: boolean): void {
    this.clearCountdown();
    const r = this.run;
    this.run = null;
    this.input.enabled = false;
    if (!r || !persist || this.pieces < 5) return;
    const m = stats.modes.quick;
    m.pieces += this.pieces;
    m.tsds += this.tsds;
    m.tsses += this.tsses;
    m.drills++;
    saveStats();
    recordSession({
      at: new Date().toISOString(),
      mode: 'quick',
      pieces: this.pieces,
      tsds: this.tsds,
      grades: { best: 0, good: 0, inaccuracy: 0, mistake: 0, killer: 0 },
      durationMs: r.timeMs,
      altitude: r.altitude,
    });
  }

  // ---- input ----

  private onKeyDown(e: KeyboardEvent): void {
    const desc = keyDescriptor(e);
    const b: Keybinds = this.input.binds;
    if (b.retry.includes(desc)) {
      e.preventDefault();
      this.startRun();
      return;
    }
    if (e.code === 'Escape') {
      e.preventDefault();
      this.showLaunch();
      return;
    }
    if (desc !== e.code) return;
    if (Object.values(b).some((codes) => codes.includes(desc))) e.preventDefault();
    this.input.keyDown(desc, performance.now());
  }

  // ---- game events ----

  private onLock(ev: LockEvent): void {
    const r = this.run;
    this.pieces++;
    // tsd/tss stats are T-spins specifically, not the new all-spins
    if (ev.piece === 'T' && ev.spin === 'full' && ev.linesCleared >= 2) {
      this.tsds++;
    } else if (ev.piece === 'T' && ev.spin === 'full' && ev.linesCleared === 1) {
      this.tsses++;
    }
    this.gravAcc = 0;
    this.resetLockdown();
    // a spin that didn't clear (a setup) still gets its own cue
    if (settings.soundFx && ev.spin !== 'none' && ev.linesCleared === 0) spinSound();
    if (settings.effects) {
      this.renderer.fxLock(ev.cells);
      this.renderer.fxDrop(ev.cells, PIECE_COLORS[ev.piece]);
    }

    if (r) {
      if (ev.linesCleared > 0) {
        const b2bBefore = r.b2b;
        const out = r.onClear(ev.linesCleared, ev.spin, ev.boardAfter.isEmpty());
        if (settings.soundFx) {
          if (b2bBefore > 0 && r.b2b === 0) b2bBreakSound();
          clearSound(ev.linesCleared, ev.spin === 'full', r.b2b, ev.boardAfter.isEmpty());
          // escalating combo jingle from the second consecutive clear
          if (r.combo >= 1) comboSound(r.combo, ev.spin !== 'none' || ev.linesCleared === 4);
          // blocked a big wave right before it hit
          if (out.canceled >= 4) clutchSound();
        }
        if (settings.effects) {
          if (ev.boardAfter.isEmpty()) this.renderer.fxAllClear();
          else this.renderer.fxClear(clearedRowsOf(ev), [PIECE_COLORS[ev.piece], '#ffffff']);
          const label = lockActionLabel(ev);
          if (label) {
            const sub = [r.b2b >= 2 ? `B2B ×${r.b2b}` : '', r.combo >= 1 ? `COMBO ×${r.combo}` : '']
              .filter(Boolean).join('   ');
            actionText(this.fieldPanel, label.main, sub, label.kind);
          }
          if (out.surged > 0) actionText(this.fieldPanel, 'SURGE', `${out.surged + out.sent + out.canceled} LINES`, 'surge');
        }
        if (out.surged > 0) this.showToast(`SURGE — ${out.surged + out.sent + out.canceled} lines`);
        else if (out.canceled > 0) this.showToast(`blocked ${out.canceled}${out.sent > 0 ? ` · +${out.sent} sent` : ''}`);
      } else {
        // combo (>=2 consecutive clears) just ended without a clear
        if (settings.soundFx && r.combo >= 1) comboBreakSound();
        r.onLockNoClear();
        // garbage rises while you are not clearing (cancelable until here)
        const rows = r.riseGarbage(8);
        if (rows.length > 0) {
          this.game.addGarbage(rows);
          this.lastIncoming = r.incomingLines();
          if (settings.soundFx) garbageSound(rows.length);
          this.renderer.fxGarbage(rows.length);
        }
      }
    }

    if (this.game.topOut) {
      this.renderer.fxTopout(this.game.board, this.game.colors);
      if (settings.soundFx) gameOverSound();
      this.endRunToResults();
    } else if (r) {
      // stack-danger alarm: sounds once as the board climbs into the red,
      // re-arms after digging back down
      const h = this.game.board.maxHeight();
      if (h >= 16 && !this.inDanger) {
        this.inDanger = true;
        if (settings.soundFx) dangerSound();
      } else if (h <= 12) {
        this.inDanger = false;
      }
    }
    this.refreshPanes();
  }

  private endRunToResults(): void {
    this.showResults();
    this.endRun(true);
  }

  // ---- per-frame ----

  /** New piece in play: fresh lock timer, move budget, and lowest-row mark. */
  private resetLockdown(): void {
    this.lockTimerMs = 0;
    this.moveResets = 0;
    this.lowestY = Infinity;
    this.renderer.lockProgress = 0;
  }

  private applyGravity(dtMs: number): void {
    const r = this.run;
    const a = this.game.active;
    if (!r || !a) return;
    // reaching a new lowest row restores the move-reset budget (guideline).
    // Measured on the lowest CELL, not the piece origin — rotation states
    // have different cell offsets and would fake "lower" on a flat floor.
    let bottom = Infinity;
    for (const [, cy] of cellsAt(a.type, a.rot, a.x, a.y)) bottom = Math.min(bottom, cy);
    if (bottom < this.lowestY) {
      this.lowestY = bottom;
      this.moveResets = 0;
      this.lockTimerMs = 0;
    }
    const grounded = this.game.ghostY() === a.y;
    if (!grounded) {
      this.renderer.lockProgress = 0;
      this.gravAcc += r.gravityCps() * (dtMs / 1000);
      while (this.gravAcc >= 1) {
        this.gravAcc--;
        if (!this.game.softDropStep()) break;
      }
    } else {
      this.gravAcc = 0;
      this.lockTimerMs += dtMs;
      // the grounded piece dims as its lock timer runs (tetr.io cue)
      this.renderer.lockProgress = this.lockTimerMs / r.lockMs();
      // lock delay; stalling is bounded by the 15-move reset budget
      if (this.lockTimerMs >= r.lockMs()) {
        if (settings.soundFx) lockSound(); // gravity lock, not a hard drop
        this.game.hardDrop();
      }
    }
  }

  private loop(t: number): void {
    this.rafId = requestAnimationFrame((tt) => this.loop(tt));
    const dt = this.lastT ? Math.min(t - this.lastT, 100) : 0;
    this.lastT = t;
    const r = this.run;
    if (r && !this.counting && !this.game.topOut) {
      this.input.update(t);
      r.tick(dt);
      // telegraph sound when new garbage gets queued against you, plus a
      // danger klaxon once a big wave (8+) is stacked up and still growing
      const inc = r.incomingLines();
      if (inc > this.lastIncoming && settings.soundFx) {
        garbageQueuedSound(inc - this.lastIncoming);
        if (inc >= 8 && this.lastIncoming < 8) damageAlertSound();
      }
      this.lastIncoming = inc;
      this.applyGravity(dt);
      this.updateHud();
      // red vignette bleeds in as the stack climbs toward the top
      this.renderer.danger = Math.max(0, Math.min(1, (this.game.board.maxHeight() - 12) / 6));
    } else {
      this.renderer.danger = 0;
    }
    this.renderer.render(this.game);
  }

  // ---- panes / hud ----

  private refreshPanes(): void {
    const cell = this.cellSize();
    const holdCell = Math.max(10, Math.round(cell * 0.68));
    const queueCell = Math.max(8, Math.round(cell * 0.55));
    this.holdBox.querySelector('canvas')?.remove();
    this.holdBox.appendChild(renderPieceTile(this.game.hold, holdCell));
    for (const c of [...this.queueBox.querySelectorAll('canvas')]) c.remove();
    for (const t of this.game.preview()) this.queueBox.appendChild(renderPieceTile(t, queueCell));
  }

  private updateHud(): void {
    const r = this.run;
    // keep the last numbers on screen when the run just ended (the same
    // frame that locks the final piece still calls this from loop())
    if (!r) return;
    const fi = floorIndexAt(r.altitude);
    const incoming = r.incomingLines();

    if (fi > this.lastFloor) {
      this.lastFloor = fi;
      if (settings.soundFx) levelUpSound();
      if (settings.effects) actionText(this.fieldPanel, `FLOOR ${fi + 1}`, FLOORS[fi].name.toUpperCase(), 'floor');
      else this.showToast(`Floor ${fi + 1} — ${FLOORS[fi].name}`);
    }
    if (!this.pbPlayed && r.altitude > this.bestAltitude) {
      this.pbPlayed = true;
      if (settings.soundFx) personalBestSound();
      this.showToast(`New personal best — past ${Math.round(this.bestAltitude)}m!`);
    }

    // tetr.io-style meter on the board's left edge: solid red = active
    // (rises on your next non-clearing lock), translucent = telegraphed —
    // both remain cancelable until they rise
    const cell = this.cellSize();
    const active = Math.min(r.activeLines(), 20);
    const queued = Math.min(incoming - r.activeLines(), 20 - active);
    this.gmActive.style.height = `${active * cell}px`;
    this.gmQueued.style.height = `${queued * cell}px`;
    this.b2bTag.textContent = r.b2b >= 1 ? `B2B ×${r.b2b}` : '';

    this.hud.innerHTML =
      `<div class="alt">${r.altitude.toFixed(1)}<small>m</small></div>` +
      `<div class="floor">F${fi + 1} · ${FLOORS[fi].name}</div>` +
      `<div class="meta">climb <b>${r.climbRank}</b> · ${fmtTime(r.timeMs)}</div>` +
      `<div class="meta">sent <b>${r.linesSent}</b> · taken <b>${r.garbageTaken}</b></div>` +
      (incoming > 0 ? `<div class="incoming">▼ ${incoming} incoming</div>` : `<div class="meta">&nbsp;</div>`);
  }

  private showToast(text: string): void {
    this.toast.textContent = text;
    this.toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('show'), 2200);
  }
}

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Per-floor accent for the launch cards: cool at the bottom, hot at the top. */
function floorColor(i: number): string {
  return `hsl(${205 - i * 22}, 72%, 58%)`;
}

function panel(label: string): HTMLElement {
  const p = document.createElement('div');
  p.className = 'panel';
  const l = document.createElement('div');
  l.className = 'label';
  l.textContent = label;
  p.appendChild(l);
  return p;
}

function btn(text: string, onClick: () => void): HTMLElement {
  const b = document.createElement('button');
  b.className = 'btn';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}
