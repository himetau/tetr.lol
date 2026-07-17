// The drill screen: field + hold/next panes, live grading feedback with a
// docked alternatives panel on the right, undo/retry, mistake alerts.
//
// LST drill = the full flow: build the TKI opener yourself (book-checked
// per piece), the first TSD drops you into the LST loop (engine-graded with
// LST-structure bias). 4-wide drill = center well between infinite wall
// columns, graded against the 4-wide combo book (engine/fourwide.ts).
// 40 Lines = sprint on an empty board: the clock starts on your first
// input and the run ends at 40 cleared lines; placements get generic grading.

import { Game, type LockEvent } from '../core/game';
import { Board } from '../core/board';
import { InputHandler, keyDescriptor, type Keybinds } from '../core/handling';
import { FieldRenderer, renderPieceTile, renderMiniBoard } from './board-canvas';
import { settings, saveSettings, onSettingsChange, BOT_NODES, type OpponentKind } from './settings';
import { EngineClient } from './engine-client';
import { ColdClearClient, type CC2Move } from './cc2-client';
import { GarbageQueue, ScheduledAttacker, versusAttack } from '../core/versus';
import { BotPlayer } from './bot-player';
import type { GradeResult, Grade, AltInfo } from '../engine/grade';
import { matchOpener, type OpenerPlacement } from '../engine/opener';
import { buildFourwideStart, refillWalls, WELL_X, WELL_W } from '../engine/fourwide';
import { genAllspin } from '../engine/allspin-gen';
import {
  gradeSound, actionSound, clearSound, comboSound, b2bBreakSound, topoutSound,
  personalBestSound, garbageSound, garbageQueuedSound, damageAlertSound, clutchSound,
} from './sound';
import { actionText, lockActionLabel, clearedRowsOf } from './fx';
import { stats, saveStats, gradeAccuracy, emptyGrades, recordSession, fmtSprint, type Mode } from './stats';
import { PIECE_COLORS, type PieceType } from '../core/pieces';
import type { SpinKind } from '../core/spin';

const GRADE_LABEL: Record<Grade, string> = {
  best: '★ Best',
  good: 'Good',
  inaccuracy: 'Inaccuracy',
  mistake: 'Mistake',
  killer: 'Loop killer',
};

const GRADE_CLASS: Record<Grade, string> = {
  best: 'g-best',
  good: 'g-good',
  inaccuracy: 'g-inaccuracy',
  mistake: 'g-mistake',
  killer: 'g-killer',
};

export class GameView {
  readonly root: HTMLElement;
  private game: Game;
  private input: InputHandler;
  private renderer: FieldRenderer;
  private engine = new EngineClient();
  /** Cold Clear 2 (all-spin patched) — real bot analysis for the all-spin mode */
  private cc2: ColdClearClient | null = null;
  private cc2Query = 0;
  private botMoving = false; // suppress grading while the bot plays its own move
  private rafId = 0;
  private mode: Mode;
  private openerPhase = false;
  private paused = false;
  private combo = 0;
  private maxCombo = 0;
  // combo value before each lock, popped on undo
  private comboHistory: number[] = [];
  // 4-wide: best combo across all recorded sessions, for the PB jingle
  private comboRecord = 0;
  private pbPlayed = false;
  // 40 lines sprint (free mode): clock starts on the first game input,
  // sprintMs is set once the run reaches 40 lines (frozen final time)
  private sprintStart = 0;
  private sprintMs: number | null = null;
  private clockAt = 0; // last live-clock repaint, throttles refreshSession
  private lastT = 0;   // previous rAF timestamp, for opponent dt

  // drill opponent (versus-style pressure): a scheduled attacker or a real
  // Cold Clear bot playing a hidden board, feeding one incoming queue
  private opp: { kind: 'garbage' | 'bot'; queue: GarbageQueue; sched: ScheduledAttacker | null; bot: BotPlayer | null } | null = null;
  private vsClock = 0;       // pressure clock (pauses with the drill)
  private vsSent = 0;
  private vsTaken = 0;
  private vsKos = 0;
  private vsLastPending = 0; // for the telegraph sound
  private gmActive!: HTMLElement;
  private gmQueued!: HTMLElement;

  // feedback elements
  private chip!: HTMLElement;
  private toast!: HTMLElement;
  private fieldPanel!: HTMLElement;
  private b2bTag!: HTMLElement;
  private b2b = 0;
  private maxB2b = 0;
  private holdBox!: HTMLElement;
  private queueBox!: HTMLElement;
  private statStrip!: HTMLElement;
  private pathsDock!: HTMLElement;
  private pathsBody!: HTMLElement;
  private leftCol!: HTMLElement;
  private rightCol!: HTMLElement;
  private chipTimer = 0;
  private toastTimer = 0;
  private retryTimer = 0;
  private unsubSettings: () => void;

  // opener-phase placement history (popped on undo)
  private openerHistory: (OpenerPlacement & { wasTsd: boolean })[] = [];

  // last graded context for the paths dock
  private lastLock: LockEvent | null = null;
  private preview: { board: Board; cells: [number, number][] } | null = null;

  // session counters — lifetime stats only absorb these when the session
  // ends ranked (no undo, no bot assist, run finished naturally)
  private session = freshSession();

  private keydown = (e: KeyboardEvent) => this.onKeyDown(e);
  private keyup = (e: KeyboardEvent) => this.onKeyUp(e);

  constructor(mode: Mode) {
    this.mode = mode;
    this.game = new Game();
    this.input = new InputHandler(this.game);
    this.input.settings = settings.handling;
    this.input.binds = settings.binds;
    this.input.onAction = (a) => {
      if (settings.soundFx) actionSound(a);
    };
    this.renderer = new FieldRenderer(this.cellSize());
    this.root = this.build();
    this.game.onLock = (ev) => this.onLock(ev);
    this.engine.onResult = (r) => this.onGrade(r);
    this.unsubSettings = onSettingsChange(() => this.applySettings());
    this.resetDrill();
    document.addEventListener('keydown', this.keydown);
    document.addEventListener('keyup', this.keyup);
    this.loop(performance.now());
  }

  private cellSize(): number {
    const fit = Math.max(14, Math.min(34, Math.floor((window.innerHeight - 140) / 21)));
    const zoomed = Math.round(fit * (settings.boardZoom / 100));
    return Math.max(10, Math.min(44, zoomed));
  }

  destroy(): void {
    this.flushSession();
    cancelAnimationFrame(this.rafId);
    clearTimeout(this.retryTimer);
    this.unsubSettings();
    this.cc2?.destroy();
    this.opp?.bot?.destroy();
    document.removeEventListener('keydown', this.keydown);
    document.removeEventListener('keyup', this.keyup);
  }

  /** Re-apply settings to a live drill (zoom, handling, binds). */
  private applySettings(): void {
    // reset-to-defaults replaces the nested objects; re-point the references
    this.input.settings = settings.handling;
    this.input.binds = settings.binds;
    this.renderer.setCellSize(this.cellSize());
    const colW = `${Math.max(110, 5 * Math.round(this.cellSize() * 0.68) + 24)}px`;
    this.leftCol.style.width = colW;
    this.rightCol.style.width = colW;
    this.refreshPanes();
  }

  private build(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'game-wrap';
    // side columns grow with zoom so the scaled piece tiles fit
    const colW = `${Math.max(110, 5 * Math.round(this.cellSize() * 0.68) + 24)}px`;

    const left = document.createElement('div');
    left.className = 'side-col';
    left.style.width = colW;
    this.leftCol = left;
    this.holdBox = panel('Hold');
    left.appendChild(this.holdBox);
    const sess = panel('Session');
    this.statStrip = document.createElement('div');
    this.statStrip.style.fontSize = '12.5px';
    this.statStrip.style.lineHeight = '1.9';
    sess.appendChild(this.statStrip);
    left.appendChild(sess);
    const controls = document.createElement('div');
    controls.className = 'drill-controls';
    controls.style.flexDirection = 'column';
    controls.append(
      btn('Retry (R)', () => this.resetDrill()),
      btn('Undo (Ctrl+Z)', () => this.undo()),
    );
    if (this.mode === 'allspin') {
      controls.append(btn('▶ Watch bot (B)', () => void this.botPlay()));
    }
    // drill opponent: nothing, quickplay-style garbage, or a hidden Cold
    // Clear bot trading attacks with you (tunables live in Settings)
    if (this.mode === 'fourwide' || this.mode === 'free' || this.mode === 'allspin') {
      const drillMode = this.mode;
      const sel = document.createElement('select');
      sel.className = 'opp-select';
      for (const [v, label] of [['off', 'no opponent'], ['garbage', 'vs garbage'], ['bot', 'vs cold clear']] as const) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = label;
        sel.appendChild(o);
      }
      sel.value = settings.versus.drill[drillMode];
      sel.addEventListener('change', () => {
        settings.versus.drill[drillMode] = sel.value as OpponentKind;
        saveSettings();
        sel.blur();
        this.resetDrill();
      });
      controls.append(sel);
    }
    left.appendChild(controls);

    this.fieldPanel = document.createElement('div');
    this.fieldPanel.className = 'field-panel';
    const row = document.createElement('div');
    row.className = 'field-row';
    const strip = document.createElement('div');
    strip.className = 'board-strip';
    this.b2bTag = document.createElement('div');
    this.b2bTag.className = 'b2b-tag';
    // incoming-garbage meter (only fills when a drill opponent is on)
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
    this.chip = document.createElement('div');
    this.chip.className = 'grade-chip';
    this.toast = document.createElement('div');
    this.toast.className = 'reason-toast';
    this.fieldPanel.append(this.chip, this.toast);

    const right = document.createElement('div');
    right.className = 'side-col';
    right.style.width = colW;
    this.rightCol = right;
    this.queueBox = panel('Next');
    right.appendChild(this.queueBox);

    // docked alternatives panel
    this.pathsDock = document.createElement('aside');
    this.pathsDock.className = 'paths-dock';
    const dockHead = document.createElement('div');
    dockHead.className = 'dock-head';
    dockHead.innerHTML = `<span class="label">Paths</span><span class="kbd">Tab</span>`;
    this.pathsBody = document.createElement('div');
    this.pathsBody.className = 'dock-body';
    this.pathsBody.innerHTML = `<div class="dock-empty">place a piece —<br>alternatives appear here</div>`;
    this.pathsDock.append(dockHead, this.pathsBody);

    wrap.append(left, this.fieldPanel, right, this.pathsDock);
    return wrap;
  }

  /**
   * Fold the session into lifetime stats and the progress charts — runs on
   * retry, top out, and leaving the drill. Strict: a session touched by undo
   * or the bot is unranked and records nothing; short stubs (<5 graded
   * placements) are noise. Returns whether anything was recorded.
   */
  private flushSession(): boolean {
    const s = this.session;
    if (s.tainted || s.graded < 5) return false;
    const m = stats.modes[this.mode];
    m.pieces += s.pieces;
    m.tsds += s.tsds;
    m.tsses += s.tsses;
    m.drills++;
    for (const g of Object.keys(s.grades) as Grade[]) m.grades[g] += s.grades[g];
    saveStats();
    recordSession({
      at: new Date().toISOString(),
      mode: this.mode,
      pieces: s.pieces,
      tsds: s.tsds,
      grades: { ...s.grades },
      durationMs: Date.now() - s.startedAt,
      ...(this.mode === 'fourwide' ? { maxCombo: this.maxCombo } : {}),
      ...(this.mode === 'free' && this.sprintMs !== null ? { sprintMs: this.sprintMs } : {}),
    });
    return true;
  }

  /** Undo or bot assistance makes the session unranked — it won't be recorded. */
  private taintSession(what: string): void {
    if (!this.session.tainted) {
      this.session.tainted = true;
      this.showToast(`${what} — session unranked, R for a fresh ranked run`);
    }
    this.refreshSession();
  }

  /**
   * 'restart' (retry / top out): the run is recorded — retry saves the
   * session to stats the same as topping out, unless it's unranked or a
   * <5-placement stub. 'continue' (all-spin cleared its setup): new board,
   * same session.
   */
  private resetDrill(end: 'restart' | 'continue' = 'restart'): void {
    this.engine.cancel();
    let note = '';
    if (end === 'restart') {
      if (this.flushSession()) note = 'Retry — session saved to stats';
      else if (this.session.graded >= 5) note = 'Retry — unranked session discarded';
    }
    // ?seed=N pins the bag order (practice/testing); all-spin picks a fresh
    // random board each drill unless a seed is pinned
    const seedParam = new URLSearchParams(location.search).get('seed');
    const seed = seedParam ? Number(seedParam) : this.mode === 'allspin' ? (Math.random() * 2 ** 31) | 0 : undefined;
    if (this.mode === 'fourwide') {
      this.game.reset(buildFourwideStart(seed).board, seed);
    } else if (this.mode === 'allspin') {
      const setup = genAllspin(seed ?? 1, ((seed ?? 1) & 1) === 1);
      this.game.reset(setup.board, seed, [setup.spinPiece]);
    } else {
      this.game.reset(undefined, seed);
    }
    this.openerPhase = this.mode === 'lst';
    this.combo = 0;
    this.maxCombo = 0;
    this.comboHistory = [];
    this.comboRecord = this.mode === 'fourwide'
      ? Math.max(0, ...stats.sessions.filter((s) => s.mode === 'fourwide').map((s) => s.maxCombo ?? 0))
      : 0;
    this.pbPlayed = false;
    if (end === 'restart') {
      this.session = freshSession();
      this.maxB2b = 0;
      this.sprintStart = 0;
      this.sprintMs = null;
    }
    this.b2b = 0;
    this.b2bTag.textContent = '';
    // all-spin is a keep-the-chain drill: start mid-B2B so every clear must be
    // a spin/quad, and warm the Cold Clear worker so the first grade is quick
    if (this.mode === 'allspin') {
      this.b2b = 1;
      this.maxB2b = Math.max(this.maxB2b, 1);
      this.b2bTag.textContent = 'B2B ×1';
      if (!this.cc2) this.cc2 = new ColdClearClient();
    }
    this.setupOpponent(end === 'restart');
    this.openerHistory = [];
    this.lastLock = null;
    this.preview = null;
    this.paused = false;
    this.input.enabled = true;
    this.hideFeedback();
    this.clearDock();
    this.refreshPanes();
    this.refreshSession();
    if (note) this.showToast(note);
  }

  private undo(): void {
    if (this.sprintMs !== null) return; // a finished sprint is final — R restarts
    if (this.game.undo()) {
      this.engine.cancel();
      // opener history entries correspond 1:1 to opener-phase piece indices;
      // only truncate when the undone piece was one of them
      while (this.openerHistory.length > this.game.pieceIndex) this.openerHistory.pop();
      if (this.mode === 'lst') {
        this.openerPhase = !this.openerHistory.some((p) => p.wasTsd);
      }
      while (this.comboHistory.length > this.game.pieceIndex) {
        this.combo = this.comboHistory.pop() ?? 0;
      }
      if (this.mode === 'fourwide') this.b2bTag.textContent = this.combo >= 1 ? `Combo ×${this.combo}` : '';
      this.lastLock = null;
      this.preview = null;
      this.hideFeedback();
      this.clearDock();
      this.resume();
      this.refreshPanes();
      this.taintSession('Undo');
    }
  }

  private resume(): void {
    this.paused = false;
    this.input.enabled = true;
  }

  private onKeyDown(e: KeyboardEvent): void {
    const desc = keyDescriptor(e);
    const b: Keybinds = this.input.binds;
    const has = (codes: string[]) => codes.includes(desc);

    if (this.mode === 'allspin' && e.code === 'KeyB' && desc === e.code) {
      e.preventDefault();
      void this.botPlay();
      return;
    }
    if (has(b.undo)) {
      e.preventDefault();
      this.undo();
      return;
    }
    if (has(b.retry)) {
      e.preventDefault();
      this.resetDrill();
      return;
    }
    if (has(b.showPaths)) {
      e.preventDefault();
      this.pathsDock.classList.toggle('collapsed');
      return;
    }
    // a finished sprint stays frozen — only R starts the next run
    if (e.code === 'Escape' && this.paused && this.sprintMs === null) {
      e.preventDefault();
      this.resume();
      return;
    }
    // combo chords are view-level only; never feed them to piece movement
    if (desc !== e.code) return;
    if (Object.values(b).some((codes) => codes.includes(desc))) {
      e.preventDefault();
      // sprint clock starts on the first game input, not on drill reset
      if (this.mode === 'free' && this.sprintStart === 0 && this.input.enabled) this.sprintStart = Date.now();
    }
    this.input.keyDown(desc, performance.now());
    this.refreshPanes();
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.input.keyUp(e.code, performance.now());
  }

  /** Canvas + popup juice for a lock: drop impact, clear bursts, action text. */
  private fxOnLock(ev: LockEvent, b2b: number, combo: number): void {
    if (!settings.effects) return;
    const color = PIECE_COLORS[ev.piece];
    this.renderer.fxLock(ev.cells);
    this.renderer.fxDrop(ev.cells, color);
    if (ev.linesCleared === 0) return;
    if (ev.boardAfter.isEmpty()) this.renderer.fxAllClear();
    else this.renderer.fxClear(clearedRowsOf(ev), [color, '#ffffff']);
    const label = lockActionLabel(ev);
    if (label) {
      const sub = [b2b >= 2 ? `B2B ×${b2b}` : '', combo >= 2 ? `COMBO ×${combo}` : '']
        .filter(Boolean).join('   ');
      actionText(this.fieldPanel, label.main, sub, label.kind);
    }
  }

  private onLock(ev: LockEvent): void {
    this.comboHistory.push(this.combo);
    const b2bBefore = this.b2b; // chain state going into this placement
    if (this.mode === 'fourwide') {
      // combo = consecutive clearing locks; the wall columns are infinite
      this.combo = ev.linesCleared > 0 ? this.combo + 1 : 0;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      refillWalls(this.game.board);
      this.b2bTag.textContent = this.combo >= 1 ? `Combo ×${this.combo}` : '';
      if (ev.linesCleared > 0 && settings.soundFx) {
        clearSound(ev.linesCleared, false, this.combo, false);
        // escalating jingle from the second consecutive clear, like tetr.io
        if (this.combo >= 2) comboSound(this.combo - 1, ev.spin !== 'none' || ev.linesCleared === 4);
        if (!this.pbPlayed && this.comboRecord >= 3 && this.combo > this.comboRecord) {
          this.pbPlayed = true;
          personalBestSound();
          this.showToast(`New combo record — ×${this.combo}`);
        }
      }
      this.fxOnLock(ev, 0, this.combo);
      this.lastLock = ev;
      this.session.pieces++;
      this.engine.gradeLock(ev, { fourwide: true });
      this.handleTopOut();
      this.refreshAll();
      return;
    }
    // B2B chain: spins and quads keep it, a plain clear breaks it
    if (ev.linesCleared > 0) {
      if (ev.spin !== 'none' || ev.linesCleared === 4) {
        this.b2b++;
        this.maxB2b = Math.max(this.maxB2b, this.b2b);
      } else {
        if (this.b2b > 0 && settings.soundFx) b2bBreakSound();
        this.b2b = 0;
      }
      if (settings.soundFx) clearSound(ev.linesCleared, ev.spin === 'full', this.b2b, ev.boardAfter.isEmpty());
    }
    this.b2bTag.textContent = this.b2b >= 1 ? `B2B ×${this.b2b}` : '';
    this.fxOnLock(ev, this.b2b, 0);
    this.lastLock = ev;
    this.session.pieces++;
    this.session.lines += ev.linesCleared;
    if (ev.piece === 'T' && ev.spin === 'full' && ev.linesCleared >= 2) {
      this.session.tsds++;
    } else if (ev.piece === 'T' && ev.spin === 'full' && ev.linesCleared === 1) {
      this.session.tsses++;
    }

    if (this.openerPhase) {
      const openerDone = ev.spin === 'full' && ev.linesCleared >= 2;
      this.openerHistory.push({
        piece: ev.piece,
        cells: ev.cells.map(([a, b]) => [a, b] as [number, number]),
        wasTsd: openerDone,
      });
      const match = matchOpener(this.openerHistory);
      if (openerDone) {
        this.openerPhase = false;
        this.showChip('best', 'TSD! — into LST now');
        this.recordGrade('best');
        this.dockNote('TSD ✓ — LST loop grading from here');
        this.refreshAll();
        return;
      }
      if (match.ok) {
        this.showChip('best', `Book · ${match.matching[0].name}`);
        this.recordGrade('best');
        this.dockNote(`book move ✓ (${match.matching[0].name})`);
        this.refreshAll();
        return;
      }
      // off-book: fall through to engine grading, flagged
      this.engine.gradeLock(ev, { lstBias: false, neural: settings.neuralEval });
      this.refreshAll();
      return;
    }

    if (this.mode === 'allspin') {
      if (this.botMoving) this.botMoveFeedback(ev);
      else void this.gradeAllspin(ev, b2bBefore);
    } else {
      this.engine.gradeLock(ev, { lstBias: this.mode === 'lst', neural: settings.neuralEval });
    }
    if (this.mode === 'free' && this.sprintMs === null && this.session.lines >= 40 && !this.game.topOut) {
      this.finishSprint();
    }
    this.handleTopOut();
    this.refreshAll();
    // all-spin: a cleared board earns a fresh random setup (same session)
    if (this.mode === 'allspin' && ev.boardAfter.isEmpty() && !this.game.topOut) {
      this.showToast('Board cleared — new setup');
      clearTimeout(this.retryTimer);
      this.retryTimer = window.setTimeout(() => this.resetDrill('continue'), 700);
    }
  }

  /**
   * 40 lines reached — freeze the clock and the field. The run is recorded
   * (with its time) when the session flushes on retry or leaving the drill,
   * so the last placement's async grade still lands first.
   */
  private finishSprint(): void {
    this.sprintMs = Date.now() - (this.sprintStart || this.session.startedAt);
    this.paused = true;
    this.input.enabled = false;
    const prev = stats.sessions
      .filter((s) => s.mode === 'free' && s.sprintMs !== undefined)
      .reduce((best, s) => Math.min(best, s.sprintMs!), Infinity);
    const pb = !this.session.tainted && this.sprintMs < prev;
    if (pb && prev !== Infinity && settings.soundFx) personalBestSound();
    const tag = this.session.tainted ? ' (unranked)' : pb && prev !== Infinity ? ' — new record!' : '';
    this.showToast(`40 lines — ${fmtSprint(this.sprintMs)}${tag} · R to retry`);
  }

  private handleTopOut(): void {
    if (!this.game.topOut) return;
    this.renderer.fxTopout(this.game.board, this.game.colors);
    if (settings.soundFx) topoutSound();
    if (settings.autoRetryTopOut) {
      this.showToast('Top out — retrying…');
      clearTimeout(this.retryTimer);
      this.retryTimer = window.setTimeout(() => {
        if (this.game.topOut) this.resetDrill();
      }, 900);
    } else {
      this.showToast('Top out — R to retry');
    }
  }

  private recordGrade(g: Grade): void {
    this.session.grades[g]++;
    this.session.graded++;
    if (g === 'best') this.session.best++;
    if (g === 'mistake' || g === 'killer') this.session.mistakes++;
    this.refreshSession();
  }

  private onGrade(r: GradeResult): void {
    let grade = r.grade;
    const openerNote = this.openerPhase ? ' · left the TKI book' : '';
    // engine grading during the opener phase only happens off-book:
    // never let it look like a clean placement
    if (this.openerPhase && (grade === 'best' || grade === 'good')) grade = 'inaccuracy';
    this.recordGrade(grade);
    this.renderDock(r, grade);
    // the last grade of a finished sprint still counts, but must not clobber
    // the result toast or re-pause the frozen field
    if (this.sprintMs !== null) return;

    const fl = settings.feedbackLevel;
    const isBad = grade === 'inaccuracy' || grade === 'mistake' || grade === 'killer';
    if (fl === 'off' && !isBad) return;
    if (fl === 'mistakes' && !isBad) return;

    let label = this.gradeLabel(grade);
    if (this.mode !== 'allspin' && this.lastLock?.spin === 'full' && this.lastLock.linesCleared >= 2) label = `TSD · ${label}`;
    else if (this.mode === 'allspin' && this.lastLock && this.lastLock.spin !== 'none' && this.lastLock.linesCleared > 0) {
      label = `${this.lastLock.piece}-spin · ${label}`;
    }
    if (r.book?.userMatched) label = `Book · ${r.book.solutions[0] ?? 'LST'}`;
    this.showChip(grade, label + (isBad ? openerNote : ''));

    if (isBad) {
      if (r.reasons.length > 0) this.showToast(r.reasons[0]);
      if (grade === 'mistake' || grade === 'killer') {
        this.fieldPanel.classList.remove('flash-bad');
        void this.fieldPanel.offsetWidth; // restart animation
        this.fieldPanel.classList.add('flash-bad');
        if (settings.soundOnMistake) gradeSound(grade);
        if (settings.stopOnMistake) {
          this.paused = true;
          this.input.enabled = false;
          this.showToast(`${r.reasons[0] ?? 'Mistake'} — Esc to continue, Ctrl+Z to undo (unranks)`);
        }
      }
    } else if (r.book && !r.book.sustainable) {
      // not the player's fault, but they should know why the chain is ending
      this.showToast(this.mode === 'fourwide'
        ? 'Book: this queue cannot keep the combo to the horizon — plan the break'
        : 'Book: this queue cannot sustain the loop — burn and rebuild');
    }
  }

  /** grade chip label, with mode-appropriate wording for the worst grade */
  private gradeLabel(g: Grade): string {
    if (g === 'killer' && this.mode === 'fourwide') return 'Combo breaker';
    if (g === 'killer' && this.mode === 'allspin') return 'Blunder';
    return GRADE_LABEL[g];
  }

  // ---- docked alternatives panel ----

  private clearDock(): void {
    this.pathsBody.innerHTML = `<div class="dock-empty">place a piece —<br>alternatives appear here</div>`;
  }

  private dockNote(text: string): void {
    this.pathsBody.innerHTML = `<div class="dock-empty">${text}</div>`;
  }

  private renderDock(r: GradeResult, grade: Grade): void {
    const lock = this.lastLock;
    if (!lock) return;
    const before = lock.boardBefore;
    this.pathsBody.replaceChildren();

    const head = document.createElement('div');
    head.className = `dock-grade ${GRADE_CLASS[grade]}`;
    const rankNote = r.userRank === 0 && grade !== 'best' && grade !== 'good'
      ? (this.mode === 'fourwide' ? 'breaks the combo book' : 'breaks LST structure')
      : `your move ranked #${Math.min(r.userRank + 1, r.alts.length)}`;
    head.textContent = `${this.gradeLabel(grade)} · ${rankNote}`;
    this.pathsBody.appendChild(head);

    for (const reason of r.reasons) {
      const li = document.createElement('div');
      li.className = 'dock-reason';
      li.textContent = reason;
      this.pathsBody.appendChild(li);
    }

    const boardH = Math.max(6, Math.min(12, before.maxHeight() + 4));
    r.alts.forEach((alt: AltInfo, i: number) => {
      const card = document.createElement('div');
      card.className = 'alt-card dock-card' + (alt.isUser ? ' was-yours' : '') + (alt.isBook ? ' is-book' : '');
      card.appendChild(renderMiniBoard(before, alt.cells, alt.piece, boardH, 11));
      const meta = document.createElement('div');
      meta.className = 'meta';
      const tag = this.mode === 'allspin'
        ? (alt.spin !== 'none' ? `spin ×${alt.linesCleared}` : alt.linesCleared === 4 ? 'quad' : alt.linesCleared > 0 ? `${alt.linesCleared} line${alt.linesCleared > 1 ? 's' : ''} · breaks B2B` : '')
        : alt.spin === 'full' ? (alt.linesCleared >= 2 ? 'TSD' : alt.linesCleared === 1 ? 'TSS' : 'spin') :
          alt.linesCleared > 0 ? `${alt.linesCleared} line${alt.linesCleared > 1 ? 's' : ''}` : '';
      meta.innerHTML = `<b style="color:${PIECE_COLORS[alt.piece]}">#${i + 1} ${alt.piece}${alt.usesHold ? ' (hold)' : ''}</b>` +
        `<span>${[alt.isBook ? 'book' : '', tag, alt.isUser ? 'yours' : ''].filter(Boolean).join(' · ')}</span>`;
      card.appendChild(meta);
      card.addEventListener('mouseenter', () => {
        this.preview = { board: before, cells: alt.cells };
        card.classList.add('selected');
      });
      card.addEventListener('mouseleave', () => {
        this.preview = null;
        card.classList.remove('selected');
      });
      this.pathsBody.appendChild(card);
    });
  }

  // ---- all-spin: Cold Clear 2 (real bot) grading ----

  /** Let Cold Clear play its own best move on the current board (watch it). */
  private async botPlay(): Promise<void> {
    if (this.mode !== 'allspin' || this.paused || !this.game.active) return;
    this.taintSession('Bot assist');
    if (!this.cc2) this.cc2 = new ColdClearClient();
    const q = ++this.cc2Query;
    const moves = await this.cc2.analyze(
      Array.from(this.game.board.rows),
      [this.game.active.type, ...this.game.preview()],
      this.game.hold,
      this.b2b > 0,
      0,
    );
    if (q !== this.cc2Query || this.mode !== 'allspin' || !this.game.active) return;
    const best = moves[0];
    if (!best) return;
    const spin: SpinKind = best.spin === 'f' ? 'full' : best.spin === 'm' ? 'mini' : 'none';
    this.botMoving = true;
    const ev = this.game.applyMove(best.piece as PieceType, pairsOf(best.cells), spin);
    this.botMoving = false;
    if (!ev) this.showToast('Bot could not reproduce that placement');
    else this.handleTopOut();
    this.refreshAll();
  }

  private botMoveFeedback(ev: LockEvent): void {
    const tag = ev.spin !== 'none' && ev.linesCleared > 0 ? `${ev.piece}-spin ×${ev.linesCleared}`
      : ev.linesCleared === 4 ? 'quad'
      : ev.linesCleared > 0 ? `${ev.linesCleared} line${ev.linesCleared > 1 ? 's' : ''}` : 'build';
    this.showChip('best', `Cold Clear · ${tag}`);
    this.dockNote(`Cold Clear played ${ev.piece}${ev.usedHold ? ' (hold)' : ''} — ${tag}`);
  }

  private async gradeAllspin(ev: LockEvent, b2bBefore: number): Promise<void> {
    if (!this.cc2) this.cc2 = new ColdClearClient();
    const q = ++this.cc2Query;
    const moves = await this.cc2.analyze(
      Array.from(ev.boardBefore.rows),
      ev.queueBefore,
      ev.holdBefore,
      b2bBefore > 0,
      0,
    );
    // a newer lock / undo / reset superseded this query
    if (q !== this.cc2Query || this.lastLock !== ev) return;
    const best = moves[0] ?? null;

    const playerKeptB2b = ev.spin !== 'none' || ev.linesCleared === 4 || ev.linesCleared === 0;
    const botKeptB2b = !best || best.spin !== 'n' || best.lines === 4 || best.lines === 0;
    // where does the player's move rank in Cold Clear's ordered candidates?
    const rank = moves.findIndex((m) => sameCells(ev.cells, pairsOf(m.cells)));

    let grade: Grade;
    const reasons: string[] = [];
    if (!playerKeptB2b && botKeptB2b) {
      grade = 'mistake';
      reasons.push(`Broke back-to-back — cleared ${ev.linesCleared} line${ev.linesCleared > 1 ? 's' : ''} without a spin`);
    } else if (!playerKeptB2b) {
      grade = 'good'; // the chain was unavoidably lost — even the bot breaks it
    } else if (rank === 0) {
      grade = 'best';
    } else if (rank >= 1 && rank <= 3) {
      grade = 'good';
    } else if (rank >= 4) {
      grade = 'inaccuracy'; // kept B2B but Cold Clear had clearly better lines
    } else {
      grade = 'mistake'; // not even among Cold Clear's top candidates
    }
    if (rank >= 1) reasons.push(`Your move was Cold Clear's #${rank + 1} choice`);
    else if (rank < 0) reasons.push(`Your move was outside Cold Clear's top ${moves.length} lines`);
    if (best && grade !== 'best') reasons.push(`Cold Clear: ${describeMove(best)}`);

    this.recordGrade(grade);
    this.renderAllspinDock(ev, moves, grade, reasons);

    const fl = settings.feedbackLevel;
    const isBad = grade === 'inaccuracy' || grade === 'mistake';
    if ((fl === 'off' || fl === 'mistakes') && !isBad) return;

    let label = this.gradeLabel(grade);
    if (ev.spin !== 'none' && ev.linesCleared > 0) label = `${ev.piece}-spin · ${label}`;
    this.showChip(grade, label);
    if (isBad && reasons.length) this.showToast(reasons[0]);
    // a broken chain is the sharp cue — flash / stop only for real mistakes
    if (grade === 'mistake') {
      this.fieldPanel.classList.remove('flash-bad');
      void this.fieldPanel.offsetWidth; // restart animation
      this.fieldPanel.classList.add('flash-bad');
      if (settings.soundOnMistake) gradeSound('mistake');
      if (settings.stopOnMistake) {
        this.paused = true;
        this.input.enabled = false;
        this.showToast(`${reasons[0] ?? 'Mistake'} — Esc to continue, Ctrl+Z to undo (unranks)`);
      }
    } else if (!isBad && best && reasons.length) {
      this.showToast(reasons[0]); // show Cold Clear's line even on a fine move
    }
  }

  private renderAllspinDock(ev: LockEvent, moves: CC2Move[], grade: Grade, reasons: string[]): void {
    const before = ev.boardBefore;
    this.pathsBody.replaceChildren();
    const head = document.createElement('div');
    head.className = `dock-grade ${GRADE_CLASS[grade]}`;
    head.textContent = `${this.gradeLabel(grade)} · Cold Clear 2`;
    this.pathsBody.appendChild(head);
    for (const reason of reasons) {
      const li = document.createElement('div');
      li.className = 'dock-reason';
      li.textContent = reason;
      this.pathsBody.appendChild(li);
    }
    const boardH = Math.max(6, Math.min(12, before.maxHeight() + 4));
    const addCard = (cells: [number, number][], piece: PieceType, top: string, bot: string, cls: string) => {
      const card = document.createElement('div');
      card.className = 'alt-card dock-card' + cls;
      card.appendChild(renderMiniBoard(before, cells, piece, boardH, 11));
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.innerHTML = `<b style="color:${PIECE_COLORS[piece]}">${top}</b><span>${bot}</span>`;
      card.appendChild(meta);
      card.addEventListener('mouseenter', () => { this.preview = { board: before, cells }; card.classList.add('selected'); });
      card.addEventListener('mouseleave', () => { this.preview = null; card.classList.remove('selected'); });
      this.pathsBody.appendChild(card);
    };
    // Cold Clear's ranked options — an "easy" (hard-drop) tag on each move that
    // needs no tuck, so you can pick a low-effort line that still keeps B2B
    moves.slice(0, 6).forEach((m, i) => {
      const ease = m.soft ? 'tuck' : 'easy';
      addCard(pairsOf(m.cells), m.piece as PieceType, `#${i + 1} ${m.piece}${m.usesHold ? ' (hold)' : ''} · ${ease}`, describeMove(m), i === 0 ? ' is-book' : '');
    });
    const yourTag = ev.spin !== 'none' && ev.linesCleared > 0 ? `spin ×${ev.linesCleared}`
      : ev.linesCleared > 0 ? `${ev.linesCleared} line${ev.linesCleared > 1 ? 's' : ''}` : 'no clear';
    addCard(ev.cells.map(([a, b]) => [a, b] as [number, number]), ev.piece, `Yours · ${ev.piece}`, yourTag, ' was-yours');
  }

  // ---- feedback chrome ----

  private showChip(grade: Grade, text: string): void {
    this.chip.textContent = text;
    this.chip.className = `grade-chip show ${GRADE_CLASS[grade]}`;
    clearTimeout(this.chipTimer);
    this.chipTimer = window.setTimeout(() => this.chip.classList.remove('show'), 1800);
  }

  private showToast(text: string): void {
    this.toast.textContent = text;
    this.toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('show'), 3200);
  }

  private hideFeedback(): void {
    this.chip.classList.remove('show');
    this.toast.classList.remove('show');
  }

  private refreshAll(): void {
    this.refreshPanes();
    this.refreshSession();
  }

  private refreshPanes(): void {
    // hold/next tiles scale with the board zoom, like tetr.io
    const cell = this.cellSize();
    const holdCell = Math.max(10, Math.round(cell * 0.68));
    const queueCell = Math.max(8, Math.round(cell * 0.55));
    this.holdBox.querySelector('canvas')?.remove();
    this.holdBox.appendChild(renderPieceTile(this.game.hold, holdCell));
    for (const c of [...this.queueBox.querySelectorAll('canvas')]) c.remove();
    for (const t of this.game.preview()) this.queueBox.appendChild(renderPieceTile(t, queueCell));
  }

  private refreshSession(): void {
    // this session's accuracy (resets on retry), not the lifetime number
    const acc = gradeAccuracy(this.session.grades);
    const ranked = this.session.tainted
      ? `<b class="unranked">unranked</b>`
      : `<b>ranked ✓</b>`;
    if (this.mode === 'fourwide') {
      this.statStrip.innerHTML =
        `phase <b>4-wide combo</b><br>` +
        `pieces <b>${this.session.pieces}</b><br>` +
        `combo <b>${this.combo}</b><br>` +
        `best combo <b>${this.maxCombo}</b><br>` +
        `mistakes <b>${this.session.mistakes}</b><br>` +
        `accuracy <b>${(acc * 100).toFixed(0)}%</b><br>` +
        `session ${ranked}`;
      return;
    }
    if (this.mode === 'allspin') {
      this.statStrip.innerHTML =
        `phase <b>all-spin B2B</b><br>` +
        `pieces <b>${this.session.pieces}</b><br>` +
        `B2B <b>${this.b2b}</b><br>` +
        `best B2B <b>${this.maxB2b}</b><br>` +
        `mistakes <b>${this.session.mistakes}</b><br>` +
        `accuracy <b>${(acc * 100).toFixed(0)}%</b><br>` +
        `session ${ranked}`;
      return;
    }
    if (this.mode === 'free') {
      const clock = this.sprintMs ?? (this.sprintStart ? Date.now() - this.sprintStart : 0);
      this.statStrip.innerHTML =
        `phase <b>40 lines</b><br>` +
        `lines <b>${Math.min(this.session.lines, 40)}/40</b><br>` +
        `time <b>${fmtSprint(clock)}</b><br>` +
        `pieces <b>${this.session.pieces}</b><br>` +
        `mistakes <b>${this.session.mistakes}</b><br>` +
        `accuracy <b>${(acc * 100).toFixed(0)}%</b><br>` +
        `session ${ranked}`;
      return;
    }
    const phase = this.openerPhase ? 'TKI opener' : 'LST loop';
    this.statStrip.innerHTML =
      `phase <b>${phase}</b><br>` +
      `pieces <b>${this.session.pieces}</b><br>` +
      `TSDs <b>${this.session.tsds}</b><br>` +
      `mistakes <b>${this.session.mistakes}</b><br>` +
      `accuracy <b>${(acc * 100).toFixed(0)}%</b><br>` +
      `session ${ranked}`;
  }

  private loop(t: number): void {
    this.rafId = requestAnimationFrame((tt) => this.loop(tt));
    if (!this.paused) this.input.update(t);
    // live sprint clock while a 40 lines run is underway
    if (this.mode === 'free' && this.sprintStart !== 0 && this.sprintMs === null && t - this.clockAt > 100) {
      this.clockAt = t;
      this.refreshSession();
    }
    if (this.preview) {
      // render preview: boardBefore + alternative cells, no active piece
      this.renderer.highlight = { cells: this.preview.cells, color: '#e8b34c' };
      this.renderer.renderStatic(this.preview.board);
    } else {
      this.renderer.highlight = null;
      this.renderer.render(this.game);
    }
  }
}

function freshSession() {
  return { pieces: 0, tsds: 0, tsses: 0, lines: 0, mistakes: 0, best: 0, graded: 0, grades: emptyGrades(), startedAt: Date.now(), tainted: false };
}

/** flat [x0,y0,x1,y1,...] → [[x,y],...] */
function pairsOf(flat: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

function sameCells(a: readonly (readonly [number, number])[], b: readonly (readonly [number, number])[]): boolean {
  if (a.length !== b.length) return false;
  const key = (c: readonly [number, number]) => c[0] * 64 + c[1];
  const sa = a.map(key).sort((x, y) => x - y);
  const sb = b.map(key).sort((x, y) => x - y);
  return sa.every((v, i) => v === sb[i]);
}

/** "T (hold) on cols 4–6 spin — clears 2" */
function describeMove(m: CC2Move): string {
  const xs = m.cells.filter((_, i) => i % 2 === 0);
  const lo = Math.min(...xs) + 1;
  const hi = Math.max(...xs) + 1;
  const cols = lo === hi ? `col ${lo}` : `cols ${lo}–${hi}`;
  const spin = m.spin === 'f' ? ` ${m.lines >= 2 ? `${m.lines}-line ` : ''}spin` : m.spin === 'm' ? ' mini-spin' : m.lines === 4 ? ' quad' : '';
  const act = m.lines > 0 ? ` — clears ${m.lines}` : ' — build';
  return `${m.piece}${m.usesHold ? ' (hold)' : ''} on ${cols}${spin}${act}`;
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
