// Quick play: a single-player simulator of TETR.IO QUICK PLAY (Zenith
// Tower) at a chosen starting altitude - per-floor gravity/lock delay,
// bot-generated garbage pressure, climb speed, and altitude scoring.
// No grading here: this mode is for feeling out the speed, not the loop.

import { Game, type LockEvent } from '../core/game';
import { VISIBLE_H, BOARD_W } from '../core/board';
import { cellsAt } from '../core/pieces';
import { InputHandler, keyDescriptor, type Keybinds } from '../core/handling';
import { FieldRenderer, renderPieceTile } from './board-canvas';
import { ZenithAltimeter } from './zenith-altimeter';
import { settings, onSettingsChange } from './settings';
import { ZenithRun, FLOORS, floorIndexAt, type Pressure } from '../core/zenith';
import {
  lockSound, clearSound, comboSound, garbageSound, garbageQueuedSound, actionSound,
  b2bBreakSound, b2bSound, spinSound, comboBreakSound, countdownSound, goSound, GarbageWarner,
  dangerSound, clutchSound, levelUpSound, personalBestSound, gameOverSound,
  surgeSound, bigSendSound, BIG_SEND_MIN,
} from './sound';
import { stats, saveStats, recordSession } from './stats';
import { actionText, sentNumber, lockActionLabel, clearedRowsOf, ChainBubble } from './fx';
import { PIECE_COLORS } from '../core/pieces';

export class ZenithView {
  readonly root: HTMLElement;
  // pieces spawn 3 rows above the field (tetr.io's vanish zone); a blocked
  // spawn clutches up through the remaining hidden rows (tetr.io's clutch
  // clear) - the last-chance save when the stack is at the ceiling
  private game = new Game(undefined, { spawnLift: 3, clutchRows: 1 });
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
  private deathWarn!: HTMLElement; // pulsing "!" when the queue would kill you
  private warner = new GarbageWarner();
  private overlay!: HTMLElement;
  private b2bTag!: ChainBubble;
  private gmActive!: HTMLElement;
  private gmQueued!: HTMLElement;
  private altimeter!: ZenithAltimeter;
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
      this.altimeter.setWidth(BOARD_W * this.cellSize());
    });
    this.showLaunch();
    document.addEventListener('keydown', this.keydown);
    document.addEventListener('keyup', this.keyup);
    this.loop(performance.now());
  }

  destroy(): void {
    // leaving mid-climb abandons the run - only topped-out runs are recorded
    this.endRun(false);
    cancelAnimationFrame(this.rafId);
    this.unsubSettings();
    document.removeEventListener('keydown', this.keydown);
    document.removeEventListener('keyup', this.keyup);
  }

  private cellSize(): number {
    // 20 visible rows + 3 buffer rows for the clutch zone
    const fit = Math.max(14, Math.min(34, Math.floor((window.innerHeight - 140) / 24)));
    const zoomed = Math.round(fit * (settings.boardZoom / 100));
    return Math.max(10, Math.min(44, zoomed));
  }

  private build(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'game-wrap';
    // panel width hugs a 4.2-cell-wide piece tile; pieces are sized so the
    // I-piece nearly fills that width, and the panel grows taller to fit.
    // The Next queue's tiles are 1.5× the hold size, so its column is wider.
    const qc = Math.round(this.cellSize() * 0.62);
    const colWq = `${Math.max(104, Math.round(4.2 * Math.round(qc * 1.5)) + 24)}px`;

    const left = document.createElement('div');
    left.className = 'side-col';
    left.style.width = colWq; /* match the queue column so text has room */
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
    // B2B chain bubble (slot above the Next queue): heats gold→red as the
    // chain charges (it holds the pending surge, B2B−3)
    this.b2bTag = new ChainBubble();
    const meter = document.createElement('div');
    meter.className = 'gmeter';
    this.gmQueued = document.createElement('div');
    this.gmQueued.className = 'gm-queued';
    this.gmActive = document.createElement('div');
    this.gmActive.className = 'gm-active';
    meter.append(this.gmQueued, this.gmActive);
    strip.append(meter);
    row.append(strip, this.renderer.el);
    this.fieldPanel.appendChild(row);
    // the run readout lives on a canvas along the board's bottom edge -
    // altitude count, floor progress, climb-speed meter, surge sparks
    this.altimeter = new ZenithAltimeter(BOARD_W * this.cellSize());
    this.fieldPanel.appendChild(this.altimeter.el);
    this.toast = document.createElement('div');
    this.toast.className = 'reason-toast';
    this.overlay = document.createElement('div');
    this.overlay.className = 'zenith-overlay';
    this.deathWarn = document.createElement('div');
    this.deathWarn.className = 'death-warn';
    this.deathWarn.textContent = '!';
    this.fieldPanel.append(this.toast, this.overlay, this.deathWarn);

    const right = document.createElement('div');
    right.className = 'side-col';
    right.style.width = colWq;
    this.queueBox = panel('Next');
    right.append(this.b2bTag.el, this.queueBox);

    wrap.append(left, this.fieldPanel, right);
    return wrap;
  }

  // ---- launch / end overlays ----

  private showLaunch(): void {
    this.endRun(false);
    this.input.enabled = false;
    this.overlay.replaceChildren();
    this.overlay.classList.remove('results');
    this.overlay.classList.add('show');

    const box = document.createElement('div');
    box.className = 'zenith-box qp-menu';
    const head = document.createElement('div');
    head.className = 'qp-head';
    head.innerHTML = `<h2>Quick play</h2>
      <p class="sub">${QP_HINTS[Math.floor(Math.random() * QP_HINTS.length)]}</p>`;
    box.appendChild(head);

    // floor picker - plain themed boxes, pick your starting altitude
    const grid = document.createElement('div');
    grid.className = 'qp-floors';
    let selectedBtn: HTMLElement | null = null;
    FLOORS.forEach((f) => {
      const b = document.createElement('button');
      b.className = 'qp-floor';
      b.innerHTML =
        `<span class="qp-fbody"><span class="qp-fname">${f.name}</span>` +
        `<span class="qp-falt">${f.from}m</span></span>`;
      if (f.from === this.startAltitude) {
        b.classList.add('on');
        selectedBtn = b;
      }
      b.addEventListener('click', () => {
        selectedBtn?.classList.remove('on');
        selectedBtn = b;
        b.classList.add('on');
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
    this.hud.innerHTML = `<div class="meta">-</div>`;
  }

  private showResults(): void {
    const r = this.run;
    if (!r) return;
    this.overlay.replaceChildren();
    this.overlay.classList.add('show', 'results');
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
    // retry restarts the run outright - an abandoned climb records nothing
    this.endRun(false);
    this.overlay.classList.remove('show', 'results');
    this.overlay.replaceChildren();
    this.game.reset();
    this.run = new ZenithRun(this.startAltitude, this.pressure, this.gravityMod);
    this.warner.reset();
    this.deathWarn.classList.remove('show');
    this.gravAcc = 0;
    this.resetLockdown();
    this.pieces = 0;
    this.tsds = 0;
    this.tsses = 0;
    this.lastIncoming = 0;
    this.b2bTag.reset();
    this.gmActive.style.height = '0px';
    this.gmQueued.style.height = '0px';
    this.lastFloor = floorIndexAt(this.startAltitude);
    this.inDanger = false;
    this.altimeter.reset(this.startAltitude);
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
   * persists - its pieces/TSDs fold into lifetime stats here, so abandoned
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
    // clutch: the next piece climbed into the buffer to fit - a saved block-out
    if (this.game.clutched && !this.game.topOut) {
      if (settings.effects) actionText(this.fieldPanel, 'CLUTCH', '', 'surge');
      if (settings.soundFx) clutchSound();
    }
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
          b2bSound(r.b2b); // rising jingle, climbs with the chain
          // escalating combo jingle from the second consecutive clear
          if (r.combo >= 1) comboSound(r.combo, ev.spin !== 'none' || ev.linesCleared === 4);
          // blocked a big wave right before it hit
          if (out.canceled >= 4) clutchSound();
          // the surge burst on a broken chain, else the spike sound for a big send
          if (out.surged > 0) surgeSound(out.surged + out.sent);
          else if (out.sent >= BIG_SEND_MIN) bigSendSound(out.sent);
        }
        // big attack: a shaking "+N" number and a field kick that scale with it
        const spike = out.surged + out.sent;
        if (settings.effects && spike >= BIG_SEND_MIN) {
          sentNumber(this.fieldPanel, spike, (spike - BIG_SEND_MIN) / 12);
          this.renderer.kick(2 + Math.min(10, spike));
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
          if (out.surged > 0) actionText(this.fieldPanel, 'SURGE', `${out.surged + out.sent + out.canceled} LINES`, 'surge', 'low');
        }
        if (out.surged > 0) {
          this.altimeter.surge(out.surged + out.sent);
          this.showToast(`SURGE - ${out.surged + out.sent + out.canceled} lines`);
        } else if (out.canceled > 0) this.showToast(`blocked ${out.canceled}${out.sent > 0 ? ` · +${out.sent} sent` : ''}`);
      } else {
        // combo (>=2 consecutive clears) just ended without a clear
        if (settings.soundFx && r.combo >= 1) comboBreakSound();
        r.onLockNoClear();
        // garbage rises while you are not clearing (cancelable until here)
        const rows = r.riseGarbage(8, this.game.garbageBoardView());
        if (rows.length > 0) {
          this.game.addGarbage(rows);
          this.lastIncoming = r.incomingLines();
          if (settings.soundFx) garbageSound(rows.length);
          this.renderer.fxGarbage(rows.length);
          this.renderer.fxGarbageIn(rows.length);
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
    // Measured on the lowest CELL, not the piece origin - rotation states
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
      // telegraph sound when new garbage gets queued against you
      const inc = r.incomingLines();
      if (inc > this.lastIncoming && settings.soundFx) garbageQueuedSound(inc - this.lastIncoming);
      this.lastIncoming = inc;
      // escalating incoming-garbage warnings + the death "!" (letting the whole
      // queue through would bury the stack past the top of the field)
      const lethal = this.warner.update(inc, this.game.board.maxHeight() + inc >= VISIBLE_H, settings.soundFx);
      this.deathWarn.classList.toggle('show', lethal);
      this.applyGravity(dt);
      this.updateHud();
      // red vignette bleeds in as the stack climbs toward the top
      this.renderer.danger = Math.max(0, Math.min(1, (this.game.board.maxHeight() - 12) / 6));
    } else {
      this.renderer.danger = 0;
    }
    this.altimeter.frame(this.run, dt);
    this.renderer.render(this.game);
  }

  // ---- panes / hud ----

  private refreshPanes(): void {
    const cell = this.cellSize();
    // hold and next: same cell size, same 4.2-cell tile so pieces fill the
    // panel width (matches the colW formula in build())
    const holdCell = Math.max(10, Math.round(cell * 0.62));
    const queueCell = Math.round(holdCell * 1.5); // 1.5× bigger next pieces
    this.holdBox.querySelector('canvas')?.remove();
    this.holdBox.appendChild(renderPieceTile(this.game.hold, holdCell, 4.2));
    for (const c of [...this.queueBox.querySelectorAll('canvas')]) c.remove();
    for (const t of this.game.preview()) this.queueBox.appendChild(renderPieceTile(t, queueCell, 4.2));
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
      else this.showToast(`Floor ${fi + 1} - ${FLOORS[fi].name}`);
    }
    if (!this.pbPlayed && r.altitude > this.bestAltitude) {
      this.pbPlayed = true;
      if (settings.soundFx) personalBestSound();
      this.showToast(`New personal best - past ${Math.round(this.bestAltitude)}m!`);
    }

    // tetr.io-style meter on the board's left edge: solid red = active
    // (rises on your next non-clearing lock), translucent = telegraphed -
    // both remain cancelable until they rise
    const cell = this.cellSize();
    const active = Math.min(r.activeLines(), 20);
    const queued = Math.min(incoming - r.activeLines(), 20 - active);
    this.gmActive.style.height = `${active * cell}px`;
    this.gmQueued.style.height = `${queued * cell}px`;

    // glows once a surge is actually banked (breaking would release B2B−3)
    this.b2bTag.set('B2B', r.b2b, r.b2b >= 4);

    // altitude/floor/climb speed live on the altimeter canvas under the
    // board - the side panel keeps the secondary numbers
    this.hud.innerHTML =
      `<div class="meta m-time">time <b>${fmtTime(r.timeMs)}</b></div>` +
      `<div class="meta m-sent">sent <b>${r.linesSent}</b></div>` +
      `<div class="meta m-taken">taken <b>${r.garbageTaken}</b></div>` +
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

// rotating one-liner under the Quick play heading (in the app's voice)
const QP_HINTS = [
  'Pick a floor. Climb. Simple as that.',
  'The garbage is fake but the pressure is real.',
  'No opponents. Just you and gravity.',
  'Start high if you like living dangerously.',
  'Floor 10 is not a suggestion.',
  'Surge responsibly.',
];

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
