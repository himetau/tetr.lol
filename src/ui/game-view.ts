// The drill screen: field + hold/next panes, live grading feedback with a
// docked alternatives panel on the right, undo/retry, mistake alerts.
//
// LST drill = the full flow: build the TKI opener yourself (book-checked
// per piece), the first TSD drops you into the LST loop (engine-graded with
// LST-structure bias). Freeplay = empty board, generic grading.

import { Game, type LockEvent } from '../core/game';
import { Board } from '../core/board';
import { InputHandler, keyDescriptor, type Keybinds } from '../core/handling';
import { FieldRenderer, renderPieceTile, renderMiniBoard } from './board-canvas';
import { settings, onSettingsChange } from './settings';
import { EngineClient } from './engine-client';
import type { GradeResult, Grade, AltInfo } from '../engine/grade';
import { matchOpener, type OpenerPlacement } from '../engine/opener';
import { mistakeSound, actionSound, clearSound, b2bBreakSound, topoutSound } from './sound';
import { stats, saveStats, accuracy, emptyGrades, recordSession, type Mode } from './stats';
import { PIECE_COLORS } from '../core/pieces';

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
  private rafId = 0;
  private mode: Mode;
  private openerPhase = false;
  private paused = false;

  // feedback elements
  private chip!: HTMLElement;
  private toast!: HTMLElement;
  private fieldPanel!: HTMLElement;
  private b2bTag!: HTMLElement;
  private b2b = 0;
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

  // session counters
  private session = { pieces: 0, tsds: 0, mistakes: 0, best: 0, graded: 0, grades: emptyGrades(), startedAt: Date.now() };

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
    left.appendChild(controls);

    this.fieldPanel = document.createElement('div');
    this.fieldPanel.className = 'field-panel';
    const row = document.createElement('div');
    row.className = 'field-row';
    const strip = document.createElement('div');
    strip.className = 'board-strip';
    this.b2bTag = document.createElement('div');
    this.b2bTag.className = 'b2b-tag';
    strip.appendChild(this.b2bTag);
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

  /** Persist the finished drill for the progress charts (short stubs are noise). */
  private flushSession(): void {
    const s = this.session;
    if (s.graded < 5) return;
    recordSession({
      at: new Date().toISOString(),
      mode: this.mode,
      pieces: s.pieces,
      tsds: s.tsds,
      grades: { ...s.grades },
      durationMs: Date.now() - s.startedAt,
    });
  }

  private resetDrill(): void {
    this.engine.cancel();
    this.flushSession();
    // ?seed=N pins the bag order (practice/testing)
    const seedParam = new URLSearchParams(location.search).get('seed');
    const seed = seedParam ? Number(seedParam) : undefined;
    this.game.reset(undefined, seed);
    this.openerPhase = this.mode === 'lst';
    this.session = { pieces: 0, tsds: 0, mistakes: 0, best: 0, graded: 0, grades: emptyGrades(), startedAt: Date.now() };
    this.b2b = 0;
    this.b2bTag.textContent = '';
    this.openerHistory = [];
    stats.modes[this.mode].drills++;
    saveStats();
    this.lastLock = null;
    this.preview = null;
    this.paused = false;
    this.input.enabled = true;
    this.hideFeedback();
    this.clearDock();
    this.refreshPanes();
    this.refreshSession();
  }

  private undo(): void {
    if (this.game.undo()) {
      this.engine.cancel();
      // opener history entries correspond 1:1 to opener-phase piece indices;
      // only truncate when the undone piece was one of them
      while (this.openerHistory.length > this.game.pieceIndex) this.openerHistory.pop();
      if (this.mode === 'lst') {
        this.openerPhase = !this.openerHistory.some((p) => p.wasTsd);
      }
      this.lastLock = null;
      this.preview = null;
      this.session.pieces = this.game.pieceIndex;
      this.hideFeedback();
      this.clearDock();
      this.resume();
      this.refreshPanes();
      this.refreshSession();
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
    if (e.code === 'Escape' && this.paused) {
      e.preventDefault();
      this.resume();
      return;
    }
    // combo chords are view-level only; never feed them to piece movement
    if (desc !== e.code) return;
    if (Object.values(b).some((codes) => codes.includes(desc))) e.preventDefault();
    this.input.keyDown(desc, performance.now());
    this.refreshPanes();
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.input.keyUp(e.code, performance.now());
  }

  private onLock(ev: LockEvent): void {
    // B2B chain: spins and quads keep it, a plain clear breaks it
    if (ev.linesCleared > 0) {
      if (ev.spin !== 'none' || ev.linesCleared === 4) {
        this.b2b++;
      } else {
        if (this.b2b > 0 && settings.soundFx) b2bBreakSound();
        this.b2b = 0;
      }
      if (settings.soundFx) clearSound(ev.linesCleared, ev.spin === 'full', this.b2b, ev.boardAfter.isEmpty());
    }
    this.b2bTag.textContent = this.b2b >= 1 ? `B2B ×${this.b2b}` : '';
    this.lastLock = ev;
    this.session.pieces++;
    stats.modes[this.mode].pieces++;
    if (ev.spin === 'full' && ev.linesCleared >= 2) {
      this.session.tsds++;
      stats.modes[this.mode].tsds++;
    } else if (ev.spin === 'full' && ev.linesCleared === 1) {
      stats.modes[this.mode].tsses++;
    }
    saveStats();

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

    this.engine.gradeLock(ev, { lstBias: this.mode === 'lst', neural: settings.neuralEval });
    if (this.game.topOut) {
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
    this.refreshAll();
  }

  private recordGrade(g: Grade): void {
    stats.modes[this.mode].grades[g]++;
    this.session.grades[g]++;
    this.session.graded++;
    if (g === 'best') this.session.best++;
    if (g === 'mistake' || g === 'killer') this.session.mistakes++;
    saveStats();
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

    const fl = settings.feedbackLevel;
    const isBad = grade === 'inaccuracy' || grade === 'mistake' || grade === 'killer';
    if (fl === 'off' && !isBad) return;
    if (fl === 'mistakes' && !isBad) return;

    let label = GRADE_LABEL[grade];
    if (this.lastLock?.spin === 'full' && this.lastLock.linesCleared >= 2) label = `TSD · ${label}`;
    if (r.book?.userMatched) label = `Book · ${r.book.solutions[0] ?? 'LST'}`;
    this.showChip(grade, label + (isBad ? openerNote : ''));

    if (isBad) {
      if (r.reasons.length > 0) this.showToast(r.reasons[0]);
      if (grade === 'mistake' || grade === 'killer') {
        this.fieldPanel.classList.remove('flash-bad');
        void this.fieldPanel.offsetWidth; // restart animation
        this.fieldPanel.classList.add('flash-bad');
        if (settings.soundOnMistake) mistakeSound();
        if (settings.stopOnMistake) {
          this.paused = true;
          this.input.enabled = false;
          this.showToast(`${r.reasons[0] ?? 'Mistake'} — Esc to continue, Ctrl+Z to undo`);
        }
      }
    } else if (r.book && !r.book.sustainable) {
      // not the player's fault, but they should know why the loop is ending
      this.showToast('Book: this queue cannot sustain the loop — burn and rebuild');
    }
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
      ? 'breaks LST structure'
      : `your move ranked #${Math.min(r.userRank + 1, r.alts.length)}`;
    head.textContent = `${GRADE_LABEL[grade]} · ${rankNote}`;
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
      const tag = alt.spin === 'full' ? (alt.linesCleared >= 2 ? 'TSD' : alt.linesCleared === 1 ? 'TSS' : 'spin') :
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
    const acc = accuracy(stats.modes[this.mode]);
    const phase = this.mode === 'lst' ? (this.openerPhase ? 'TKI opener' : 'LST loop') : 'freeplay';
    this.statStrip.innerHTML =
      `phase <b>${phase}</b><br>` +
      `pieces <b>${this.session.pieces}</b><br>` +
      `TSDs <b>${this.session.tsds}</b><br>` +
      `mistakes <b>${this.session.mistakes}</b><br>` +
      `accuracy <b>${(acc * 100).toFixed(0)}%</b>`;
  }

  private loop(t: number): void {
    this.rafId = requestAnimationFrame((tt) => this.loop(tt));
    if (!this.paused) this.input.update(t);
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
