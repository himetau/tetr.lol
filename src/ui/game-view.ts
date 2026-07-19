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
import { Board, VISIBLE_H } from '../core/board';
import { InputHandler, keyDescriptor, type Keybinds } from '../core/handling';
import { FieldRenderer, renderPieceTile, renderMiniBoard } from './board-canvas';
import { settings, saveSettings, onSettingsChange, botNodesOf, type OpponentKind } from './settings';
import { EngineClient } from './engine-client';
import { ColdClearClient, type CC2Move } from './cc2-client';
import { GarbageQueue, ScheduledAttacker, versusAttack, scaleAttack } from '../core/versus';
import { BotPlayer } from './bot-player';
import { bestMove, type GradeResult, type Grade, type AltInfo } from '../engine/grade';
import { matchOpener, chainsToLoop, type OpenerPlacement } from '../engine/opener';
import { bookAdvice } from '../engine/book';
import { enumeratePlacements } from '../engine/enumerate';
import { lstLoopMove } from '../engine/lst-loop';
import { CC2_LST_LOOP_JSON } from '../engine/cc2-weights';
import { buildFourwideStart, refillWalls, WELL_X, WELL_W } from '../engine/fourwide';
import { genAllspin } from '../engine/allspin-gen';
import {
  gradeSound, actionSound, clearSound, comboSound, b2bBreakSound, b2bSound, topoutSound,
  personalBestSound, garbageSound, garbageQueuedSound, clutchSound, GarbageWarner,
  surgeSound, bigSendSound, BIG_SEND_MIN,
} from './sound';
import { actionText, sentNumber, lockActionLabel, clearedRowsOf } from './fx';
import { stats, saveStats, gradeAccuracy, emptyGrades, recordSession, fmtSprint, type Mode } from './stats';
import { PIECE_COLORS, type PieceType } from '../core/pieces';
import type { SpinKind } from '../core/spin';

// LST drill goal: 20 TSDs in one run with back-to-back never broken, the
// loop never dead, no I piece spent on a clear (quads and I-burns are
// off-plan; parking the I or laying it as build filler is fine), and not a
// single T wasted — every locked T must be a full T-spin double.
const LST_GOAL_TSDS = 20;

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
  // PPS window: first game input → most recent lock (doesn't decay while idle)
  private playStart = 0;
  private lastLockAt = 0;
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
  private warner = new GarbageWarner();
  private gmActive!: HTMLElement;
  private gmQueued!: HTMLElement;

  // feedback elements
  private chip!: HTMLElement;
  private toast!: HTMLElement;
  private deathWarn!: HTMLElement; // pulsing "!" when the queue would kill you
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
  private evalSel: HTMLSelectElement | null = null;
  private unsubSettings: () => void;

  // opener-phase placement history (popped on undo)
  private openerHistory: (OpenerPlacement & { wasTsd: boolean })[] = [];

  // LST goal run state: first violation ends the goal (short label for the
  // session panel), goalDone latches the 20-TSD success jingle
  private goalFail: string | null = null;
  private goalDone = false;

  // who played the last assisted move in the LST drill: the cover book, the
  // goal-legal loop player, the plain engine fallback, or Cold Clear 2
  private assistWho: 'Book' | 'Loop' | 'Engine' | 'Cold Clear' = 'Book';

  // last graded context for the paths dock
  private lastLock: LockEvent | null = null;
  private preview: { board: Board; colors: (PieceType | null)[][]; cells: [number, number][]; piece: PieceType } | null = null;

  // session counters — lifetime stats only absorb these when the session
  // ends ranked (no undo, no bot assist, run finished naturally)
  private session = freshSession();

  private keydown = (e: KeyboardEvent) => this.onKeyDown(e);
  private keyup = (e: KeyboardEvent) => this.onKeyUp(e);

  constructor(mode: Mode) {
    this.mode = mode;
    // pieces spawn in the vanish zone, floating 3 rows above the field; a
    // blocked spawn clutches up through the remaining hidden rows (tetr.io's
    // clutch clear) instead of topping out outright
    this.game = new Game(undefined, { spawnLift: 3, clutchRows: 1 });
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
    // 20 visible rows + 3 vanish rows above the field
    const fit = Math.max(14, Math.min(34, Math.floor((window.innerHeight - 140) / 24)));
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

  /** Is placement evaluation on for this drill? (quick/versus have none) */
  private evalOn(): boolean {
    const m = this.mode;
    return m === 'lst' || m === 'fourwide' || m === 'free' || m === 'allspin'
      ? settings.evalDrill[m]
      : false;
  }

  /** The paths dock only exists while evaluation is on. */
  private applyEvalVisibility(): void {
    this.pathsDock.style.display = this.evalOn() ? '' : 'none';
  }

  /** Re-apply settings to a live drill (zoom, handling, binds, evaluation). */
  private applySettings(): void {
    // reset-to-defaults replaces the nested objects; re-point the references
    this.input.settings = settings.handling;
    this.input.binds = settings.binds;
    this.renderer.setCellSize(this.cellSize());
    const colW = `${Math.max(110, 5 * Math.round(this.cellSize() * 0.68) + 24)}px`;
    this.leftCol.style.width = colW;
    this.rightCol.style.width = colW;
    this.applyEvalVisibility();
    if (this.evalSel) this.evalSel.value = this.evalOn() ? 'on' : 'off';
    this.refreshPanes();
    this.refreshSession();
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
    this.statStrip.className = 'sess-grid';
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
    } else if (this.mode === 'lst') {
      controls.append(btn('▶ Watch book (B)', () => this.bookPlay()));
      // which engine drives "watch book" once the position leaves the book:
      // the built-in heuristic loop player, or loop-tuned Cold Clear 2
      const assistSel = document.createElement('select');
      assistSel.className = 'opp-select';
      for (const [v, label] of [['engine', 'assist: engine'], ['cc2', 'assist: cold clear']] as const) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = label;
        assistSel.appendChild(o);
      }
      assistSel.value = settings.lstAssist;
      assistSel.addEventListener('change', () => {
        settings.lstAssist = assistSel.value as 'engine' | 'cc2';
        saveSettings();
        assistSel.blur();
        if (settings.lstAssist === 'cc2' && !this.cc2) this.cc2 = new ColdClearClient();
      });
      controls.append(assistSel);
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
    // per-mode evaluation switch — same setting as in Settings → Trainer
    if (this.mode === 'lst' || this.mode === 'fourwide' || this.mode === 'free' || this.mode === 'allspin') {
      const gm = this.mode;
      const evalSel = document.createElement('select');
      evalSel.className = 'opp-select';
      for (const [v, label] of [['on', 'evaluation on'], ['off', 'evaluation off']] as const) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = label;
        evalSel.appendChild(o);
      }
      evalSel.value = settings.evalDrill[gm] ? 'on' : 'off';
      this.evalSel = evalSel;
      evalSel.addEventListener('change', () => {
        settings.evalDrill[gm] = evalSel.value === 'on';
        saveSettings(); // triggers applySettings → dock visibility + session refresh
        evalSel.blur();
        this.hideFeedback();
        this.clearDock();
      });
      controls.append(evalSel);
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
    row.append(strip, this.renderer.el);
    this.fieldPanel.appendChild(row);
    this.chip = document.createElement('div');
    this.chip.className = 'grade-chip';
    this.toast = document.createElement('div');
    this.toast.className = 'reason-toast';
    this.deathWarn = document.createElement('div');
    this.deathWarn.className = 'death-warn';
    this.deathWarn.textContent = '!';
    this.fieldPanel.append(this.chip, this.toast, this.deathWarn);

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
    // with evaluation off there are no grades — piece count is the size gate
    if (s.tainted || (this.evalOn() ? s.graded < 5 : s.pieces < 5)) return false;
    const m = stats.modes[this.mode];
    m.pieces += s.pieces;
    m.tsds += s.tsds;
    m.tsses += s.tsses;
    m.drills++;
    for (const g of Object.keys(s.grades) as Grade[]) m.grades[g] += s.grades[g];
    saveStats();
    // active play window only — idle time before the first input doesn't count
    const activeMs = this.playStart ? Math.max(0, (this.lastLockAt || Date.now()) - this.playStart) : Date.now() - s.startedAt;
    const pps = s.pieces >= 2 && activeMs > 0 ? Math.round((s.pieces / (activeMs / 1000)) * 100) / 100 : undefined;
    recordSession({
      at: new Date().toISOString(),
      mode: this.mode,
      pieces: s.pieces,
      tsds: s.tsds,
      grades: { ...s.grades },
      durationMs: activeMs,
      ...(pps !== undefined ? { pps } : {}),
      ...(this.mode === 'fourwide' ? { maxCombo: this.maxCombo } : {}),
      ...(this.mode === 'allspin' ? { maxB2b: this.maxB2b } : {}),
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
      this.playStart = 0;
      this.lastLockAt = 0;
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
    this.goalFail = null;
    this.goalDone = false;
    this.lastLock = null;
    this.preview = null;
    this.paused = false;
    this.input.enabled = true;
    this.hideFeedback();
    this.clearDock();
    this.applyEvalVisibility();
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

  // ---- drill opponent (versus-style pressure) ----

  /**
   * (Re)build the pressure system from settings. `fresh` on retry/top-out;
   * all-spin's board-cleared 'continue' keeps the live queue and bot. The
   * bot worker survives retries — it just gets a fresh board and retuned
   * pace/strength.
   */
  private setupOpponent(fresh: boolean): void {
    if (!fresh && this.opp) return;
    const kind: OpponentKind = (this.mode === 'fourwide' || this.mode === 'free' || this.mode === 'allspin')
      ? settings.versus.drill[this.mode]
      : 'off';
    this.vsClock = 0;
    this.vsSent = 0;
    this.vsTaken = 0;
    this.vsKos = 0;
    this.vsLastPending = 0;
    this.warner.reset();
    this.deathWarn.classList.remove('show');
    this.gmActive.style.height = '0px';
    this.gmQueued.style.height = '0px';
    if (kind === 'off') {
      this.opp?.bot?.destroy();
      this.opp = null;
      return;
    }
    const v = settings.versus;
    const cfg = {
      delayMs: v.garbageDelayMs,
      messiness: v.messiness / 100,
      cap: v.garbageCap,
      // 4-wide: holes stay inside the well so garbage rows remain clearable
      holeMin: this.mode === 'fourwide' ? WELL_X : 0,
      holeMax: this.mode === 'fourwide' ? WELL_X + WELL_W - 1 : 9,
    };
    const queue = new GarbageQueue(cfg);
    if (kind === 'bot') {
      let bot = this.opp?.bot ?? null;
      if (bot) {
        bot.configure({ pps: v.botPps, nodes: botNodesOf(v), rules: v.rules, attackScale: v.botAttackScale });
        bot.reset((Math.random() * 2 ** 31) | 0);
      } else {
        // the bot plays a normal full-width board even in the 4-wide drill
        bot = new BotPlayer({
          pps: v.botPps,
          nodes: botNodesOf(v),
          garbage: { ...cfg, holeMin: 0, holeMax: 9 },
          rules: v.rules,
          attackScale: v.botAttackScale,
        });
      }
      bot.onAttack = (lines) => queue.queue(lines, this.vsClock);
      bot.onTopOut = () => {
        this.vsKos++;
        if (settings.soundFx) personalBestSound();
        this.showToast(`KO! Cold Clear topped out ×${this.vsKos} — fresh bot board`);
        this.opp?.bot?.reset((Math.random() * 2 ** 31) | 0);
        this.refreshSession();
      };
      this.opp = { kind, queue, sched: null, bot };
    } else {
      this.opp?.bot?.destroy();
      this.opp = { kind, queue, sched: new ScheduledAttacker(v.pressure), bot: null };
    }
  }

  /** The pressure clock only runs while the player is actually drilling. */
  private opponentLive(): boolean {
    if (!this.opp || this.paused || this.game.topOut) return false;
    if (this.mode === 'free' && (this.sprintStart === 0 || this.sprintMs !== null)) return false;
    return true;
  }

  /** Per-frame: advance the opponent, collect its attacks, drive the meter. */
  private tickOpponent(dt: number): void {
    const o = this.opp;
    if (!o) return;
    if (!this.opponentLive()) return;
    this.vsClock += dt;
    if (o.sched) for (const lines of o.sched.tick(dt)) o.queue.queue(lines, this.vsClock);
    o.bot?.update(dt);
    const pending = o.queue.pending();
    if (pending > this.vsLastPending && settings.soundFx) garbageQueuedSound(pending - this.vsLastPending);
    this.vsLastPending = pending;
    // escalating incoming-garbage warnings + the death "!" (letting the whole
    // queue through would bury the stack past the top of the field)
    const lethal = this.warner.update(pending, this.game.board.maxHeight() + pending >= VISIBLE_H, settings.soundFx);
    this.deathWarn.classList.toggle('show', lethal);
    const cell = this.cellSize();
    const active = Math.min(o.queue.active(this.vsClock), 20);
    const queued = Math.min(pending - active, 20 - active);
    this.gmActive.style.height = `${active * cell}px`;
    this.gmQueued.style.height = `${queued * cell}px`;
  }

  /**
   * Versus bookkeeping for a player lock: a clear cancels incoming garbage
   * first and sends the rest at the bot; a non-clearing lock lets active
   * garbage rise into the board. `comboNow` is 0-based (0 = first clear).
   */
  private versusLock(ev: LockEvent, b2bBefore: number, comboNow: number): void {
    const o = this.opp;
    if (!o || !this.opponentLive()) return;
    if (ev.linesCleared > 0) {
      const v = settings.versus;
      const atk = scaleAttack(
        versusAttack(ev.linesCleared, ev.spin, comboNow, b2bBefore, ev.boardAfter.isEmpty(), v.rules),
        v.attackScale,
      );
      const canceled = o.queue.cancel(atk);
      const sent = atk - canceled;
      if (sent > 0) {
        this.vsSent += sent;
        o.bot?.receiveAttack(sent);
      }
      if (canceled >= 4 && settings.soundFx) clutchSound();
      // big attack: spike slam + a shaking "+N" number and a scaling field kick
      if (sent >= BIG_SEND_MIN) {
        if (settings.soundFx) bigSendSound(sent);
        if (settings.effects) {
          sentNumber(this.fieldPanel, sent, (sent - BIG_SEND_MIN) / 12);
          this.renderer.kick(2 + Math.min(10, sent));
        }
      }
    } else {
      const rows = o.queue.rise(this.vsClock);
      if (rows.length > 0) {
        this.game.addGarbage(rows);
        this.vsTaken += rows.length;
        if (settings.soundFx) garbageSound(rows.length);
        this.renderer.fxGarbage(rows.length);
        this.renderer.fxGarbageIn(rows.length);
      }
    }
    this.vsLastPending = o.queue.pending();
  }

  private onKeyDown(e: KeyboardEvent): void {
    const desc = keyDescriptor(e);
    const b: Keybinds = this.input.binds;
    const has = (codes: string[]) => codes.includes(desc);

    if ((this.mode === 'allspin' || this.mode === 'lst') && e.code === 'KeyB' && desc === e.code) {
      e.preventDefault();
      if (this.mode === 'lst') this.bookPlay();
      else void this.botPlay();
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
      // PPS clock likewise — every mode
      if (this.playStart === 0 && this.input.enabled) this.playStart = Date.now();
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
    if (this.playStart === 0) this.playStart = Date.now(); // bot-first edge case
    this.lastLockAt = Date.now();
    // clutch: the just-spawned next piece had to climb into the buffer to fit —
    // a saved block-out, announced tetr.io style
    if (this.game.clutched && !this.game.topOut) {
      if (settings.effects) actionText(this.fieldPanel, 'CLUTCH', '', 'surge');
      if (settings.soundFx) clutchSound();
    }
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
      if (this.evalOn()) this.engine.gradeLock(ev, { fourwide: true });
      this.versusLock(ev, 0, this.combo - 1);
      this.handleTopOut();
      this.refreshAll();
      return;
    }
    // consecutive-clear combo (feeds the versus attack table)
    this.combo = ev.linesCleared > 0 ? this.combo + 1 : 0;
    // B2B chain: spins and quads keep it, a plain clear breaks it
    if (ev.linesCleared > 0) {
      if (ev.spin !== 'none' || ev.linesCleared === 4) {
        this.b2b++;
        this.maxB2b = Math.max(this.maxB2b, this.b2b);
      } else {
        if (this.b2b > 0 && settings.soundFx) {
          b2bBreakSound();
          if (this.b2b >= BIG_SEND_MIN) surgeSound(this.b2b); // cashing out a big chain
        }
        this.b2b = 0;
      }
      if (settings.soundFx) {
        clearSound(ev.linesCleared, ev.spin === 'full', this.b2b, ev.boardAfter.isEmpty());
        b2bSound(this.b2b); // rising jingle, climbs with the chain
      }
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
    if (this.mode === 'lst') this.trackLstGoal(ev);

    if (this.openerPhase) {
      const openerDone = ev.spin === 'full' && ev.linesCleared >= 2;
      this.openerHistory.push({
        piece: ev.piece,
        cells: ev.cells.map(([a, b]) => [a, b] as [number, number]),
        wasTsd: openerDone,
      });
      // book playback: keep phase bookkeeping, skip grading the book's own move
      if (this.botMoving) {
        if (openerDone) this.openerPhase = false;
        this.botMoveFeedback(ev);
        this.refreshAll();
        return;
      }
      // evaluation off: still advance the opener → loop phase, no grading
      if (!this.evalOn()) {
        if (openerDone) this.openerPhase = false;
        this.refreshAll();
        return;
      }
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
      else if (this.evalOn()) void this.gradeAllspin(ev, b2bBefore);
    } else if (this.botMoving) {
      this.botMoveFeedback(ev);
    } else if (this.evalOn()) {
      this.engine.gradeLock(ev, { lstBias: this.mode === 'lst', neural: settings.neuralEval });
    }
    this.versusLock(ev, b2bBefore, this.combo - 1);
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

  /**
   * The LST goal run: reach LST_GOAL_TSDS TSDs with back-to-back never broken,
   * no I piece spent on a clear, and every locked T a full TSD (a TSS, flat T,
   * or T burn wastes the run). No explicit "loop alive" check — a dead loop
   * can only show up as a wasted T or a broken chain, both caught here, and a
   * rigid col-2 template test just misfires on valid right-handed / freestyle
   * loops. The first violation ends the goal until R resets the run.
   */
  private trackLstGoal(ev: LockEvent): void {
    if (this.goalDone) return;
    if (this.goalFail === null) {
      if (ev.piece === 'T' && !(ev.spin === 'full' && ev.linesCleared >= 2)) {
        this.goalFail = 'T wasted ✗';
        this.showToast('Goal lost — wasted a T (every T must be a full TSD) · R for a fresh 20-TSD run');
      } else if (ev.linesCleared > 0 && ev.linesCleared < 4 && ev.spin === 'none') {
        this.goalFail = 'B2B ✗';
        this.showToast('Goal lost — broke back-to-back · R for a fresh 20-TSD run');
      } else if (ev.piece === 'I' && ev.linesCleared > 0) {
        this.goalFail = 'I spent ✗';
        this.showToast('Goal lost — spent the I on a clear · R for a fresh 20-TSD run');
      }
    }
    if (this.goalFail === null && this.session.tsds >= LST_GOAL_TSDS) {
      this.goalDone = true;
      if (settings.soundFx) personalBestSound();
      this.showToast(`Goal reached — ${LST_GOAL_TSDS} TSDs, B2B intact, no T or I wasted ✓`);
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
        this.preview = { board: before, colors: lock.colorsBefore, cells: alt.cells, piece: alt.piece };
        card.classList.add('selected');
      });
      card.addEventListener('mouseleave', () => {
        this.preview = null;
        card.classList.remove('selected');
      });
      this.pathsBody.appendChild(card);
    });
  }

  // ---- lst: book playback ("watch book") ----

  /** Play the book's move for the current position: TKI targets during the
   * opener, the LST cover book in the loop, the ready TSD as the payoff.
   * When the position is off-book the loop player keeps chasing the 20-TSD
   * goal (goal-legal moves only — never a wasted T); only when even that is
   * stuck does the plain engine take over, so the button always plays. */
  private bookPlay(): void {
    if (this.mode !== 'lst' || !this.game.active) return;
    if (this.paused) this.resume();
    const queue = [this.game.active.type, ...this.game.preview()];
    let found = this.lstBookMove();
    if (found) {
      this.assistWho = 'Book';
    } else if (!this.openerPhase && settings.lstAssist === 'cc2') {
      // off-book loop, Cold Clear selected: let the loop-tuned bot drive
      // (async — it thinks on a worker); the rest of this method is skipped
      void this.cc2LoopPlay(queue);
      return;
    } else if (!this.openerPhase) {
      // off-book loop: hunt for a goal-legal continuation before anything
      // that would waste the T
      const loop = lstLoopMove(this.game.board, queue, this.game.hold);
      if (loop) {
        this.assistWho = 'Loop';
        found = { piece: loop.piece, cells: loop.cells, spin: loop.spin };
      } else if (this.game.hold === null || this.game.hold !== 'T') {
        // no legal loop move: park the T so it survives for a later TSD
        // rather than being forced onto the stack
        if (this.game.active.type === 'T') {
          found = { piece: 'T', cells: [], spin: 'none', park: true };
          this.assistWho = 'Loop';
        }
      }
    }
    if (!found) {
      // genuinely off-plan (opener miss, or the loop is unrecoverable): the
      // plain engine keeps the demo moving even if it can't stay clean
      this.assistWho = 'Engine';
      const mv = bestMove(Array.from(this.game.board.rows), queue, this.game.hold, true);
      if (mv) found = { piece: mv.piece, cells: mv.cells, spin: mv.spin };
    }
    if (!found) {
      this.showToast('No move available — the board is jammed');
      return;
    }
    this.taintSession(`${this.assistWho} assist`);
    if (found.park) {
      if (this.game.holdPiece()) {
        this.showToast(this.assistWho === 'Loop'
          ? `Loop: park the ${found.piece} — keep it for the next TSD`
          : `Book: park ${found.piece} in hold`);
      }
      this.refreshAll();
      return;
    }
    this.botMoving = true;
    const ev = this.game.applyMove(found.piece, found.cells, found.spin);
    this.botMoving = false;
    if (!ev) this.showToast(`${this.assistWho} move is not reachable here`);
    else this.handleTopOut();
    this.refreshAll();
  }

  /** Off-book loop playback driven by Cold Clear 2 with the loop-tuned
   * weights (settings.lstAssist === 'cc2'). Async: the bot thinks on its
   * worker, so a later lock/undo/reset supersedes a stale result. */
  private async cc2LoopPlay(queue: PieceType[]): Promise<void> {
    if (!this.cc2) this.cc2 = new ColdClearClient();
    const q = ++this.cc2Query;
    const moves = await this.cc2.analyze(
      Array.from(this.game.board.rows),
      queue,
      this.game.hold,
      this.b2b > 0,
      this.combo,
      30000,
      CC2_LST_LOOP_JSON,
    );
    if (q !== this.cc2Query || this.mode !== 'lst' || !this.game.active) return;
    const best = moves[0];
    if (!best) { this.showToast('Cold Clear found no move here'); return; }
    const spin: SpinKind = best.spin === 'f' ? 'full' : best.spin === 'm' ? 'mini' : 'none';
    this.assistWho = 'Cold Clear';
    this.taintSession('Cold Clear assist');
    this.botMoving = true;
    const ev = this.game.applyMove(best.piece as PieceType, pairsOf(best.cells), spin);
    this.botMoving = false;
    if (!ev) this.showToast('Cold Clear move is not reachable here');
    else this.handleTopOut();
    this.refreshAll();
  }

  private lstBookMove(): { piece: PieceType; cells: [number, number][]; spin: SpinKind; park?: boolean } | null {
    const board = this.game.board;
    const active = this.game.active!.type;
    const holdP = this.game.hold ?? this.game.preview()[0] ?? null;
    const canHold = holdP !== null && holdP !== active;
    // a ready full T-spin double is the goal in both phases; prefer the one
    // whose result is still a book state so the loop keeps going
    const tsd = () => {
      const opts = enumeratePlacements(board, 'T').filter((p) => p.spin === 'full' && p.linesCleared >= 2);
      return opts.find((p) => bookAdvice(p.after, [], null).onBook) ?? opts[0];
    };

    if (this.openerPhase) {
      const match = matchOpener(this.openerHistory);
      // build toward a target that flows into the LST loop book when possible
      const targets = [...match.matching].sort((a, b) => Number(chainsToLoop(b)) - Number(chainsToLoop(a)));
      const placed = new Set(this.openerHistory.map((h) => h.piece));
      const tryPiece = (piece: PieceType): { piece: PieceType; cells: [number, number][]; spin: SpinKind } | null => {
        if (piece === 'T') {
          // the T is always the TSD payoff — a flat drop into the notch
          // matches a target's T cells but ruins the opener
          const p = tsd();
          return p ? { piece: 'T', cells: p.cells.map(([a, b]) => [a, b] as [number, number]), spin: p.spin } : null;
        }
        for (const t of targets) {
          const want = t.pieces[piece];
          if (!want || placed.has(piece)) continue;
          const p = enumeratePlacements(board, piece).find((pl) => sameCells(pl.cells, want));
          if (p) return { piece, cells: p.cells.map(([a, b]) => [a, b] as [number, number]), spin: p.spin };
        }
        return null;
      };
      const mv = tryPiece(active) ?? (canHold ? tryPiece(holdP) : null);
      // no spot yet (needs support, or the T came early): stash the active piece
      if (!mv && this.game.hold === null) return { piece: active, cells: [], spin: 'none', park: true };
      return mv;
    }

    const adv = bookAdvice(board, [active, ...this.game.preview()], this.game.hold);
    if (adv.onBook) {
      // prefer keeping the hold slot free, like the book planner does
      const ordered = [...adv.moves].sort((a, b) => Number(a.usesHold) - Number(b.usesHold));
      for (const mv of ordered) {
        const p = enumeratePlacements(board, mv.piece).find((pl) => sameCells(pl.cells, mv.cells));
        if (p) return { piece: mv.piece, cells: p.cells.map(([a, b]) => [a, b] as [number, number]), spin: p.spin };
      }
    }
    if (active === 'T' || (canHold && holdP === 'T')) {
      const p = tsd();
      if (p) return { piece: 'T', cells: p.cells.map(([a, b]) => [a, b] as [number, number]), spin: p.spin };
    }
    if (adv.onBook && adv.holdIsBook && this.game.hold !== active) {
      return { piece: active, cells: [], spin: 'none', park: true };
    }
    return null;
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
    const who = this.mode === 'lst' ? this.assistWho : 'Cold Clear';
    const tag = ev.spin !== 'none' && ev.linesCleared > 0 ? `${ev.piece}-spin ×${ev.linesCleared}`
      : ev.linesCleared === 4 ? 'quad'
      : ev.linesCleared > 0 ? `${ev.linesCleared} line${ev.linesCleared > 1 ? 's' : ''}` : 'build';
    this.showChip('best', `${who} · ${tag}`);
    this.dockNote(`${who} played ${ev.piece}${ev.usedHold ? ' (hold)' : ''} — ${tag}`);
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
      card.addEventListener('mouseenter', () => { this.preview = { board: before, colors: ev.colorsBefore, cells, piece }; card.classList.add('selected'); });
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

  /** Live PPS over the active window (first input → last lock). */
  private livePps(): string {
    if (this.playStart === 0 || this.session.pieces < 2) return '—';
    const ms = (this.lastLockAt || Date.now()) - this.playStart;
    if (ms < 500) return '—';
    return (this.session.pieces / (ms / 1000)).toFixed(2);
  }

  private refreshSession(): void {
    const s = this.session;
    const evalOn = this.evalOn();
    // this session's accuracy (resets on retry), not the lifetime number
    const acc = gradeAccuracy(s.grades);
    const cells: [string, string][] = [];
    if (this.mode === 'lst') {
      cells.push(
        ['phase', this.openerPhase ? 'TKI' : 'LST loop'],
        ['TSDs', `${s.tsds}/${LST_GOAL_TSDS}`],
        ['goal', this.goalDone ? 'done ✓' : this.goalFail ?? 'on track'],
      );
    }
    if (this.mode === 'free') {
      const clock = this.sprintMs ?? (this.sprintStart ? Date.now() - this.sprintStart : 0);
      cells.push(['time', fmtSprint(clock)], ['lines', `${Math.min(s.lines, 40)}/40`]);
    }
    if (this.mode === 'fourwide') cells.push(['combo', `×${this.combo}`], ['best', `×${this.maxCombo}`]);
    if (this.mode === 'allspin') cells.push(['B2B', `×${this.b2b}`], ['best', `×${this.maxB2b}`]);
    cells.push(['pieces', String(s.pieces)], ['PPS', this.livePps()]);
    // opponent traffic (and KOs when a real bot is on the other side)
    if (this.opp) {
      cells.push(['sent', String(this.vsSent)], ['taken', String(this.vsTaken)]);
      if (this.opp.bot) cells.push(['KOs', String(this.vsKos)]);
    }
    if (evalOn) cells.push(['errors', String(s.mistakes)], ['acc', `${(acc * 100).toFixed(0)}%`]);
    const body = cells
      .map(([k, v]) => `<div class="sc"><span class="k">${k}</span><span class="v">${v}</span></div>`)
      .join('');
    const ranked = s.tainted
      ? `<div class="sc wide rank-no"><span class="k">session</span><span class="v">unranked</span></div>`
      : `<div class="sc wide rank-ok"><span class="k">session</span><span class="v">ranked ✓</span></div>`;
    this.statStrip.innerHTML = body + ranked;
  }

  private loop(t: number): void {
    this.rafId = requestAnimationFrame((tt) => this.loop(tt));
    const dt = this.lastT ? Math.min(t - this.lastT, 100) : 0;
    this.lastT = t;
    if (!this.paused) this.input.update(t);
    this.tickOpponent(dt);
    // live clock/PPS repaint while a run is underway — the sprint clock ticks
    // fast; the other modes only need the PPS cell to feel alive
    const sprintLive = this.mode === 'free' && this.sprintStart !== 0 && this.sprintMs === null;
    const interval = sprintLive ? 100 : 500;
    if (this.playStart !== 0 && !this.paused && !this.game.topOut && t - this.clockAt > interval) {
      this.clockAt = t;
      this.refreshSession();
    }
    if (this.preview) {
      // render preview: boardBefore with its real skins + the alternative
      // placement as its own piece skin, outlined
      this.renderer.highlight = { cells: this.preview.cells, color: '#e8b34c', piece: this.preview.piece };
      this.renderer.renderStatic(this.preview.board, this.preview.colors);
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
