// Quick play: a single-player simulator of TETR.IO QUICK PLAY (Zenith
// Tower) at a chosen starting altitude — per-floor gravity/lock delay,
// bot-generated garbage pressure, climb speed, and altitude scoring.
// No grading here: this mode is for feeling out the speed, not the loop.

import { Game, type LockEvent } from '../core/game';
import { InputHandler, keyDescriptor, type Keybinds } from '../core/handling';
import { FieldRenderer, renderPieceTile } from './board-canvas';
import { settings, onSettingsChange } from './settings';
import { ZenithRun, FLOORS, floorIndexAt, type Pressure } from '../core/zenith';
import { lockSound, clearSound, garbageSound, mistakeSound } from './sound';
import { stats, saveStats, recordSession } from './stats';

export class ZenithView {
  readonly root: HTMLElement;
  private game = new Game();
  private input: InputHandler;
  private renderer: FieldRenderer;
  private rafId = 0;
  private lastT = 0;
  private unsubSettings: () => void;

  private run: ZenithRun | null = null;
  private pendingGarbage: number[] = [];
  private gravAcc = 0;
  private lockTimerMs = 0;
  private groundMs = 0;
  private pieces = 0;
  private tsds = 0;

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
  private toastTimer = 0;

  private keydown = (e: KeyboardEvent) => this.onKeyDown(e);
  private keyup = (e: KeyboardEvent) => this.input.keyUp(e.code, performance.now());

  constructor() {
    this.input = new InputHandler(this.game);
    this.input.settings = settings.handling;
    this.input.binds = settings.binds;
    this.input.onAction = (a) => {
      if (a === 'left' || a === 'right' || a === 'rotateCW' || a === 'rotateCCW' || a === 'rotate180') {
        this.lockTimerMs = 0; // successful-or-not; capped by groundMs
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
    this.endRun(true);
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
    this.fieldPanel.appendChild(this.renderer.canvas);
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
    this.endRun(true);
    this.input.enabled = false;
    this.overlay.replaceChildren();
    this.overlay.classList.add('show');

    const box = document.createElement('div');
    box.className = 'zenith-box';
    box.innerHTML = `<h2>Quick play</h2>
      <p class="sub">Zenith-style climb at your chosen altitude.<br>Garbage pressure is simulated — no live opponents.</p>`;

    const grid = document.createElement('div');
    grid.className = 'floor-grid';
    let selectedBtn: HTMLElement | null = null;
    FLOORS.forEach((f, i) => {
      const b = document.createElement('button');
      b.className = 'btn floor-btn';
      b.innerHTML = `<b>F${i + 1} · ${f.from}m</b><span>${f.name}</span>`;
      if (f.from === this.startAltitude) {
        b.classList.add('primary');
        selectedBtn = b;
      }
      b.addEventListener('click', () => {
        selectedBtn?.classList.remove('primary');
        selectedBtn = b;
        b.classList.add('primary');
        this.startAltitude = f.from;
      });
      grid.appendChild(b);
    });
    box.appendChild(grid);

    const opts = document.createElement('div');
    opts.className = 'zenith-opts';
    const pressure = document.createElement('select');
    for (const [v, label] of [['calm', 'calm garbage'], ['normal', 'normal garbage'], ['brutal', 'brutal garbage']] as const) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      if (v === this.pressure) o.selected = true;
      pressure.appendChild(o);
    }
    pressure.addEventListener('change', () => { this.pressure = pressure.value as Pressure; });
    const gmod = document.createElement('label');
    gmod.className = 'zenith-gmod';
    const gbox = document.createElement('input');
    gbox.type = 'checkbox';
    gbox.checked = this.gravityMod;
    gbox.addEventListener('change', () => { this.gravityMod = gbox.checked; });
    gmod.append(gbox, document.createTextNode(' Gravity mod (0.48G→3.18G)'));
    opts.append(pressure, gmod);
    box.appendChild(opts);

    const start = document.createElement('button');
    start.className = 'btn primary zenith-start';
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
    this.endRun(true);
    this.overlay.classList.remove('show');
    this.overlay.replaceChildren();
    this.game.reset();
    this.run = new ZenithRun(this.startAltitude, this.pressure, this.gravityMod);
    this.pendingGarbage = [];
    this.gravAcc = 0;
    this.lockTimerMs = 0;
    this.groundMs = 0;
    this.pieces = 0;
    this.tsds = 0;
    this.input.enabled = true;
    stats.modes.quick.drills++;
    saveStats();
    this.refreshPanes();
    this.updateHud();
  }

  /** Close out the active run; optionally persist it as a session. */
  private endRun(persist: boolean): void {
    const r = this.run;
    this.run = null;
    this.input.enabled = false;
    if (!r || !persist || this.pieces < 5) return;
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
    stats.modes.quick.pieces++;
    if (ev.spin === 'full' && ev.linesCleared >= 2) {
      this.tsds++;
      stats.modes.quick.tsds++;
    } else if (ev.spin === 'full' && ev.linesCleared === 1) {
      stats.modes.quick.tsses++;
    }
    saveStats();
    this.gravAcc = 0;
    this.lockTimerMs = 0;
    this.groundMs = 0;

    if (settings.soundFx) {
      if (ev.linesCleared > 0) clearSound(ev.linesCleared, ev.spin === 'full');
      else lockSound();
    }

    if (r) {
      if (ev.linesCleared > 0) {
        const out = r.onClear(ev.linesCleared, ev.spin, ev.boardAfter.isEmpty());
        if (out.surged > 0) this.showToast(`SURGE — ${out.surged + out.sent + out.canceled} lines`);
        else if (out.canceled > 0) this.showToast(`blocked ${out.canceled}${out.sent > 0 ? ` · +${out.sent} sent` : ''}`);
      } else {
        r.onLockNoClear();
        // garbage enters while you are not clearing
        if (this.pendingGarbage.length > 0) {
          const rows = this.pendingGarbage.splice(0, 8);
          this.game.addGarbage(rows);
          if (settings.soundFx) garbageSound(rows.length);
        }
      }
    }

    if (this.game.topOut) {
      if (settings.soundOnMistake) mistakeSound();
      this.endRunToResults();
    }
    this.refreshPanes();
  }

  private endRunToResults(): void {
    this.showResults();
    this.endRun(true);
  }

  // ---- per-frame ----

  private applyGravity(dtMs: number): void {
    const r = this.run;
    const a = this.game.active;
    if (!r || !a) return;
    const grounded = this.game.ghostY() === a.y;
    if (!grounded) {
      this.lockTimerMs = 0;
      this.groundMs = 0;
      this.gravAcc += r.gravityCps() * (dtMs / 1000);
      while (this.gravAcc >= 1) {
        this.gravAcc--;
        if (!this.game.softDropStep()) break;
      }
    } else {
      this.gravAcc = 0;
      this.lockTimerMs += dtMs;
      this.groundMs += dtMs;
      // lock delay, with a hard cap so wiggling cannot stall forever
      if (this.lockTimerMs >= r.lockMs() || this.groundMs >= 3 * r.lockMs()) {
        this.game.hardDrop();
      }
    }
  }

  private loop(t: number): void {
    this.rafId = requestAnimationFrame((tt) => this.loop(tt));
    const dt = this.lastT ? Math.min(t - this.lastT, 100) : 0;
    this.lastT = t;
    const r = this.run;
    if (r && !this.game.topOut) {
      this.input.update(t);
      const holes = r.tick(dt);
      if (holes.length > 0) this.pendingGarbage.push(...holes);
      this.applyGravity(dt);
      this.updateHud();
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
    const incoming = r.incomingLines() + this.pendingGarbage.length;
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
