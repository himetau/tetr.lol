// 1v1 vs Cold Clear: two live boards trading garbage, tetr.io style. The
// launch overlay tunes the bot (speed, strength) and the garbage channel
// (telegraph delay, messiness) - the same knobs as Settings → Versus.
// Rounds end on a top out; first to the chosen score takes the match.
// No grading, no undo - this mode is for playing the matchup.

import { Game, type LockEvent } from '../core/game';
import { VISIBLE_H } from '../core/board';
import { InputHandler, keyDescriptor, type Keybinds } from '../core/handling';
import { FieldRenderer, renderPieceTile, holdCellOf, queueCellOf, sideColWidth } from './board-canvas';
import { settings, saveSettings, onSettingsChange, botNodesOf, DEFAULT_SETTINGS, type BotLevel } from './settings';
import { GarbageQueue, versusAttack, scaleAttack, type GarbageConfig } from '../core/versus';
import { BotPlayer } from './bot-player';
import {
  clearSound, comboSound, garbageSound, garbageQueuedSound, actionSound, b2bBreakSound, b2bSound,
  spinSound, comboBreakSound, countdownSound, goSound, clutchSound, GarbageWarner,
  personalBestSound, gameOverSound, topoutSound, lockSound, surgeSound, bigSendSound, BIG_SEND_MIN,
} from './sound';
import { stats, saveStats, recordSession } from './stats';
import { actionText, sentNumber, lockActionLabel, clearedRowsOf, ChainBubble } from './fx';
import { PIECE_COLORS, cellsAt } from '../core/pieces';

export class VersusView {
  readonly root: HTMLElement;
  // pieces spawn in the vanish zone, floating 3 rows above the field; a
  // blocked spawn clutches up through the remaining hidden rows (tetr.io's
  // clutch clear) instead of topping out outright
  private game = new Game(undefined, { spawnLift: 3, clutchRows: 1 });
  private input: InputHandler;
  private renderer: FieldRenderer;
  private botRenderer: FieldRenderer;
  private bot: BotPlayer | null = null;
  private incoming: GarbageQueue | null = null; // garbage aimed at the player
  private rafId = 0;
  private lastT = 0;
  private unsubSettings: () => void;

  private roundLive = false;
  private clock = 0;        // current round ms
  private matchMs = 0;      // all rounds so far + current
  private b2b = 0;
  private combo = -1;
  private score = { me: 0, cc: 0 };
  private round = 0;
  private sent = 0;
  private taken = 0;
  private pieces = 0;
  private tsds = 0;
  private tsses = 0;
  private lastPending = 0;
  private matchRecorded = false;
  private warner = new GarbageWarner();
  private deathWarn!: HTMLElement; // the pulsing "!" when the queue would kill you

  // gravity mode: guideline Extended Placement Lock Down (same as quick play)
  private gravAcc = 0;
  private lockTimerMs = 0;
  private moveResets = 0;
  private lowestY = Infinity;

  private fieldPanel!: HTMLElement;
  private botPanel!: HTMLElement;
  private leftCol!: HTMLElement;
  private rightCol!: HTMLElement;
  private holdBox!: HTMLElement;
  private queueBox!: HTMLElement;
  private hud!: HTMLElement;
  private botHud!: HTMLElement;
  private toast!: HTMLElement;
  private overlay!: HTMLElement;
  private b2bTag!: ChainBubble;
  private gmActive!: HTMLElement;
  private gmQueued!: HTMLElement;
  private botGm!: HTMLElement;
  private playerMeter!: HTMLElement; // garbage-bolt landing point (player side)
  private botMeter!: HTMLElement;    // garbage-bolt landing point (bot side)
  private toastTimer = 0;
  private roundTimer = 0;
  private countdownTimers: number[] = [];
  private counting = false;

  private keydown = (e: KeyboardEvent) => this.onKeyDown(e);
  private keyup = (e: KeyboardEvent) => this.input.keyUp(e.code, performance.now());

  constructor() {
    this.input = new InputHandler(this.game);
    this.input.settings = settings.handling;
    this.input.binds = settings.binds;
    this.input.onAction = (a) => {
      if (a === 'hold') {
        this.resetLockdown();
        this.refreshPanes();
      }
      if (settings.soundFx && this.roundLive) actionSound(a);
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
    this.botRenderer = new FieldRenderer(this.botCellSize());
    this.root = this.build();
    this.game.onLock = (ev) => this.onLock(ev);
    this.unsubSettings = onSettingsChange(() => {
      this.input.settings = settings.handling;
      this.input.binds = settings.binds;
      this.renderer.setCellSize(this.cellSize());
      this.botRenderer.setCellSize(this.botCellSize());
      this.leftCol.style.width = sideColWidth(this.cellSize());
      this.rightCol.style.width = sideColWidth(this.cellSize());
      this.rightCol.style.transform = `translateY(-${this.cellSize()}px)`;
      this.refreshPanes();
    });
    this.showLaunch();
    document.addEventListener('keydown', this.keydown);
    document.addEventListener('keyup', this.keyup);
    this.loop(performance.now());
  }

  destroy(): void {
    this.recordMatch(); // leaving mid-match still banks finished rounds
    cancelAnimationFrame(this.rafId);
    clearTimeout(this.roundTimer);
    this.clearCountdown();
    this.unsubSettings();
    this.bot?.destroy();
    document.removeEventListener('keydown', this.keydown);
    document.removeEventListener('keyup', this.keyup);
  }

  private cellSize(): number {
    // 20 visible rows + 3 vanish rows above the field - the same formula as
    // the drill and quick play views, so the main board never shrinks in 1v1
    const fit = Math.max(14, Math.min(34, Math.floor((window.innerHeight - 140) / 24)));
    const zoomed = Math.round(fit * (settings.boardZoom / 100));
    return Math.max(10, Math.min(44, zoomed));
  }

  private botCellSize(): number {
    // the opponent's board is the one that gives up space for the 1v1 layout
    return Math.max(8, Math.round(this.cellSize() * 0.55));
  }

  private build(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'game-wrap';
    // side columns share the sizing of every other mode (hug the queue tiles)
    const colW = sideColWidth(this.cellSize());

    const left = document.createElement('div');
    left.className = 'side-col';
    left.style.width = colW;
    this.leftCol = left;
    this.holdBox = panel('Hold');
    left.appendChild(this.holdBox);
    const match = panel('Match');
    this.hud = document.createElement('div');
    this.hud.className = 'zenith-hud';
    match.appendChild(this.hud);
    left.appendChild(match);
    const controls = document.createElement('div');
    controls.className = 'drill-controls';
    controls.style.flexDirection = 'column';
    controls.append(
      btn('Rematch (R)', () => this.startMatch()),
      btn('Setup (Esc)', () => this.showLaunch()),
    );
    left.appendChild(controls);

    this.fieldPanel = document.createElement('div');
    this.fieldPanel.className = 'field-panel';
    const row = document.createElement('div');
    row.className = 'field-row';
    const strip = document.createElement('div');
    strip.className = 'board-strip';
    this.b2bTag = new ChainBubble();
    const meter = document.createElement('div');
    meter.className = 'gmeter';
    this.gmQueued = document.createElement('div');
    this.gmQueued.className = 'gm-queued';
    this.gmActive = document.createElement('div');
    this.gmActive.className = 'gm-active';
    meter.append(this.gmQueued, this.gmActive);
    this.playerMeter = meter;
    strip.append(meter);
    row.append(strip, this.renderer.el);
    this.fieldPanel.appendChild(row);
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
    right.style.width = colW;
    right.style.transform = `translateY(-${this.cellSize()}px)`; // queue rides one row high, like the drills
    this.rightCol = right;
    this.queueBox = panel('Next');
    right.append(this.b2bTag.el, this.queueBox);

    // the opponent's board, live
    const botCol = document.createElement('div');
    botCol.className = 'vs-bot-col';
    const tag = document.createElement('div');
    tag.className = 'vs-nametag';
    tag.textContent = '✦ Cold Clear';
    this.botPanel = document.createElement('div');
    this.botPanel.className = 'field-panel vs-bot-field';
    const botRow = document.createElement('div');
    botRow.className = 'field-row';
    const botStrip = document.createElement('div');
    botStrip.className = 'board-strip';
    const botMeter = document.createElement('div');
    botMeter.className = 'gmeter';
    this.botGm = document.createElement('div');
    this.botGm.className = 'gm-active';
    botMeter.appendChild(this.botGm);
    this.botMeter = botMeter;
    botStrip.appendChild(botMeter);
    botRow.append(botStrip, this.botRenderer.el);
    this.botPanel.appendChild(botRow);
    this.botHud = document.createElement('div');
    this.botHud.className = 'vs-bot-hud';
    // nametag under the board - above it the bot's vanish-zone pieces cover it
    botCol.append(this.botPanel, tag, this.botHud);

    wrap.append(left, this.fieldPanel, right, botCol);
    return wrap;
  }

  // ---- launch / results ----

  private garbageCfg(): GarbageConfig {
    const v = settings.versus;
    return {
      delayMs: v.garbageDelayMs,
      messiness: v.messiness / 100,
      cap: v.garbageCap,
      holeMin: 0,
      holeMax: 9,
    };
  }

  private showLaunch(): void {
    this.stopRound();
    this.overlay.replaceChildren();
    this.overlay.classList.add('show');
    const v = settings.versus;

    const box = document.createElement('div');
    box.className = 'zenith-box';
    box.innerHTML = `<h2>1v1 vs Cold Clear</h2>
      <p class="sub">The real bot on its own board, trading garbage with you.<br>Tune it here - the same knobs live in Settings.</p>`;

    const opts = document.createElement('div');
    opts.className = 'zenith-opts';
    const strength = document.createElement('select');
    for (const lv of ['easy', 'normal', 'hard', 'elite', 'custom'] as BotLevel[]) {
      const o = document.createElement('option');
      o.value = lv;
      o.textContent = `strength: ${lv}`;
      if (lv === v.botLevel) o.selected = true;
      strength.appendChild(o);
    }
    const firstTo = document.createElement('select');
    for (const n of [1, 2, 3, 5, 7, 10]) {
      const o = document.createElement('option');
      o.value = String(n);
      o.textContent = `first to ${n}`;
      if (n === v.firstTo) o.selected = true;
      firstTo.appendChild(o);
    }
    firstTo.addEventListener('change', () => { v.firstTo = Number(firstTo.value); saveSettings(); });
    const grav = document.createElement('select');
    for (const g of [0, 0.5, 1, 1.5, 2, 3, 5, 20]) {
      const o = document.createElement('option');
      o.value = String(g);
      o.textContent = g === 0 ? 'gravity: off' : `gravity: ${g}G`;
      if (g === v.gravity) o.selected = true;
      grav.appendChild(o);
    }
    grav.addEventListener('change', () => { v.gravity = Number(grav.value); saveSettings(); });
    opts.append(strength, firstTo, grav);
    box.appendChild(opts);

    const save = <T,>(set: (val: T) => void) => (val: T) => { set(val); saveSettings(); };
    box.appendChild(launchSlider('bot speed', 'pps', 0.5, 4, 0.25, v.botPps, save((val) => { v.botPps = val; })));
    // custom node budget - only meaningful when strength is 'custom'
    const nodesRow = launchSlider('bot nodes', '', 500, 100000, 500, v.botNodes, save((val) => { v.botNodes = val; }));
    nodesRow.style.display = v.botLevel === 'custom' ? '' : 'none';
    strength.addEventListener('change', () => {
      v.botLevel = strength.value as BotLevel;
      nodesRow.style.display = v.botLevel === 'custom' ? '' : 'none';
      saveSettings();
    });
    box.appendChild(nodesRow);
    box.appendChild(launchSlider('garbage delay', 's', 0, 5, 0.25, v.garbageDelayMs / 1000, save((val) => { v.garbageDelayMs = Math.round(val * 1000); })));
    box.appendChild(launchSlider('messiness', '%', 0, 100, 5, v.messiness, save((val) => { v.messiness = val; })));

    // every remaining dial: handicaps, cap, and the damage table itself
    const adv = document.createElement('details');
    adv.className = 'vs-adv';
    const sum = document.createElement('summary');
    sum.textContent = 'advanced - damage rules & handicaps';
    adv.appendChild(sum);
    const advBody = document.createElement('div');
    const rebuildAdv = () => {
      advBody.replaceChildren(
        launchSlider('my attack', '%', 25, 300, 25, v.attackScale, save((val) => { v.attackScale = val; })),
        launchSlider('bot attack', '%', 25, 300, 25, v.botAttackScale, save((val) => { v.botAttackScale = val; })),
        launchSlider('garbage cap', ' rows', 1, 20, 1, v.garbageCap, save((val) => { v.garbageCap = val; })),
        launchSlider('spin attack', '× lines', 0, 4, 0.5, v.rules.spinMult, save((val) => { v.rules.spinMult = val; })),
        launchSlider('quad attack', '', 0, 8, 1, v.rules.quadAttack, save((val) => { v.rules.quadAttack = val; })),
        launchSlider('B2B bonus', '', 0, 4, 1, v.rules.b2bBonus, save((val) => { v.rules.b2bBonus = val; })),
        launchSlider('combo interval', ' (0 = off)', 0, 4, 1, v.rules.comboDiv, save((val) => { v.rules.comboDiv = val; })),
        launchSlider('all clear', '', 0, 20, 1, v.rules.allClear, save((val) => { v.rules.allClear = val; })),
      );
      const reset = document.createElement('button');
      reset.className = 'btn vs-rules-reset';
      reset.textContent = 'Reset damage & handicaps';
      reset.addEventListener('click', () => {
        const d = DEFAULT_SETTINGS.versus;
        v.attackScale = d.attackScale;
        v.botAttackScale = d.botAttackScale;
        v.garbageCap = d.garbageCap;
        v.rules = { ...d.rules };
        saveSettings();
        rebuildAdv();
      });
      advBody.appendChild(reset);
    };
    rebuildAdv();
    adv.appendChild(advBody);
    box.appendChild(adv);

    const start = document.createElement('button');
    start.className = 'btn primary zenith-start';
    start.textContent = 'Start match';
    start.addEventListener('click', () => this.startMatch());
    box.appendChild(start);
    this.overlay.appendChild(box);
    this.updateHud();
  }

  private showResults(): void {
    const won = this.score.me > this.score.cc;
    this.overlay.replaceChildren();
    this.overlay.classList.add('show');
    const box = document.createElement('div');
    box.className = 'zenith-box';
    box.innerHTML = `<h2>${won ? 'Victory' : 'Defeat'} · ${this.score.me}–${this.score.cc}</h2>
      <p class="sub">${this.pieces} pieces · ${this.sent} sent · ${this.taken} taken · ${fmtTime(this.matchMs)}</p>`;
    const rowEl = document.createElement('div');
    rowEl.className = 'zenith-opts';
    rowEl.append(
      btn('Rematch (R)', () => this.startMatch()),
      btn('Setup', () => this.showLaunch()),
    );
    box.appendChild(rowEl);
    this.overlay.appendChild(box);
  }

  // ---- match / round flow ----

  private startMatch(): void {
    this.recordMatch();
    this.matchRecorded = false;
    this.score = { me: 0, cc: 0 };
    this.round = 0;
    this.matchMs = 0;
    this.sent = 0;
    this.taken = 0;
    this.pieces = 0;
    this.tsds = 0;
    this.tsses = 0;
    this.startRound();
  }

  private startRound(): void {
    this.stopRound();
    clearTimeout(this.roundTimer);
    this.overlay.classList.remove('show');
    this.overlay.replaceChildren();
    this.round++;
    this.clock = 0;
    this.b2b = 0;
    this.combo = -1;
    this.lastPending = 0;
    this.warner.reset();
    this.deathWarn.classList.remove('show');
    this.b2bTag.reset();
    this.gmActive.style.height = '0px';
    this.gmQueued.style.height = '0px';
    this.botGm.style.height = '0px';
    this.game.reset(undefined, (Math.random() * 2 ** 31) | 0);
    this.resetLockdown();
    this.incoming = new GarbageQueue(this.garbageCfg());
    const v = settings.versus;
    if (this.bot) {
      this.bot.configure({ pps: v.botPps, nodes: botNodesOf(v), rules: v.rules, attackScale: v.botAttackScale });
      this.bot.reset((Math.random() * 2 ** 31) | 0);
    } else {
      this.bot = new BotPlayer({
        pps: v.botPps,
        nodes: botNodesOf(v),
        garbage: this.garbageCfg(),
        rules: v.rules,
        attackScale: v.botAttackScale,
      });
    }
    this.bot.onAttack = (lines) => {
      this.incoming?.queue(lines, this.clock);
      // the garbage streaks from the bot's field to your meter - it's already
      // in the queue (cancelable) the instant it launches, tetr.io style
      this.flyGarbage(this.botPanel, this.playerMeter, lines);
    };
    this.bot.onTopOut = () => this.endRound('me');
    this.bot.onLockEvent = (ev) => this.onBotLock(ev);
    this.beginCountdown();
    this.refreshPanes();
    this.updateHud();
  }

  /** Freeze play (round over / back to setup); keeps boards on screen.
   * Also disarms a pending next-round timer so Esc during the intermission
   * can't start a round under the setup overlay. */
  private stopRound(): void {
    this.roundLive = false;
    this.input.enabled = false;
    clearTimeout(this.roundTimer);
    this.clearCountdown();
  }

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
        this.roundLive = true;
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

  private endRound(winner: 'me' | 'cc'): void {
    if (!this.roundLive) return;
    this.stopRound();
    this.score[winner]++;
    if (settings.soundFx) {
      if (winner === 'me') personalBestSound();
      else gameOverSound();
    }
    if (winner === 'me' && settings.effects) {
      this.botRenderer.fxTopout(this.bot!.game.board, this.bot!.game.colors);
      actionText(this.botPanel, 'KO', '', 'surge');
    }
    const over = this.score.me >= settings.versus.firstTo || this.score.cc >= settings.versus.firstTo;
    this.updateHud();
    if (over) {
      this.recordMatch();
      this.roundTimer = window.setTimeout(() => this.showResults(), 900);
    } else {
      this.showToast(`${winner === 'me' ? 'You take' : 'Cold Clear takes'} round ${this.round} - ${this.score.me}–${this.score.cc}`);
      this.roundTimer = window.setTimeout(() => this.startRound(), 1800);
    }
  }

  /** Fold the finished rounds into lifetime stats (once per match). */
  private recordMatch(): void {
    if (this.matchRecorded || this.score.me + this.score.cc === 0 || this.pieces < 5) return;
    this.matchRecorded = true;
    const m = stats.modes.versus;
    m.pieces += this.pieces;
    m.tsds += this.tsds;
    m.tsses += this.tsses;
    m.drills++;
    saveStats();
    recordSession({
      at: new Date().toISOString(),
      mode: 'versus',
      pieces: this.pieces,
      tsds: this.tsds,
      grades: { best: 0, good: 0, inaccuracy: 0, mistake: 0, killer: 0 },
      durationMs: this.matchMs,
      wins: this.score.me,
      losses: this.score.cc,
    });
  }

  // ---- input ----

  private onKeyDown(e: KeyboardEvent): void {
    const desc = keyDescriptor(e);
    const b: Keybinds = this.input.binds;
    if (b.retry.includes(desc)) {
      e.preventDefault();
      this.startMatch();
      return;
    }
    if (e.code === 'Escape') {
      e.preventDefault();
      this.showLaunch();
      return;
    }
    if (desc !== e.code) return; // no undo/combo chords in versus
    if (Object.values(b).some((codes) => codes.includes(desc))) e.preventDefault();
    this.input.keyDown(desc, performance.now());
  }

  // ---- game events ----

  /** New piece in play: fresh lock timer, move budget, and lowest-row mark. */
  private resetLockdown(): void {
    this.lockTimerMs = 0;
    this.moveResets = 0;
    this.lowestY = Infinity;
    this.gravAcc = 0;
    this.renderer.lockProgress = 0;
  }

  private applyGravity(dtMs: number): void {
    const g = settings.versus.gravity;
    const a = this.game.active;
    if (g <= 0 || !a) {
      this.renderer.lockProgress = 0;
      return;
    }
    // a new lowest row restores the move-reset budget (guideline), measured
    // on the lowest cell - rotation states have different cell offsets
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
      this.gravAcc += g * 60 * (dtMs / 1000); // 1G = 1 cell/frame @ 60fps
      while (this.gravAcc >= 1) {
        this.gravAcc--;
        if (!this.game.softDropStep()) break;
      }
    } else {
      this.gravAcc = 0;
      this.lockTimerMs += dtMs;
      // the grounded piece dims as its lock timer runs (tetr.io cue)
      this.renderer.lockProgress = this.lockTimerMs / 500;
      if (this.lockTimerMs >= 500) {
        if (settings.soundFx) lockSound(); // gravity lock, not a hard drop
        this.game.hardDrop();
      }
    }
  }

  private onLock(ev: LockEvent): void {
    this.resetLockdown();
    this.pieces++;
    // clutch: the next piece climbed into the buffer to fit - a saved block-out
    if (this.game.clutched && !this.game.topOut) {
      if (settings.effects) actionText(this.fieldPanel, 'CLUTCH', '', 'surge');
      if (settings.soundFx) clutchSound();
    }
    if (ev.piece === 'T' && ev.spin === 'full' && ev.linesCleared >= 2) this.tsds++;
    else if (ev.piece === 'T' && ev.spin === 'full' && ev.linesCleared === 1) this.tsses++;
    if (settings.soundFx && ev.spin !== 'none' && ev.linesCleared === 0) spinSound();
    if (settings.effects) {
      this.renderer.fxLock(ev.cells);
      this.renderer.fxDrop(ev.cells, PIECE_COLORS[ev.piece]);
    }

    if (this.roundLive && this.incoming) {
      if (ev.linesCleared > 0) {
        this.combo++;
        const b2bBefore = this.b2b;
        const keepsB2b = ev.spin !== 'none' || ev.linesCleared === 4;
        const v = settings.versus;
        const atk = scaleAttack(
          versusAttack(ev.linesCleared, ev.spin, this.combo, b2bBefore, ev.boardAfter.isEmpty(), v.rules),
          v.attackScale,
        );
        this.b2b = keepsB2b ? this.b2b + 1 : 0;
        const canceled = this.incoming.cancel(atk);
        const sentNow = atk - canceled;
        if (sentNow > 0) {
          this.sent += sentNow;
          this.bot?.receiveAttack(sentNow);
          this.flyGarbage(this.fieldPanel, this.botMeter, sentNow);
        }
        if (settings.soundFx) {
          if (b2bBefore > 0 && this.b2b === 0) {
            b2bBreakSound();
            if (b2bBefore >= BIG_SEND_MIN) surgeSound(b2bBefore); // cashing out a big chain
          }
          clearSound(ev.linesCleared, ev.spin === 'full', this.b2b, ev.boardAfter.isEmpty());
          b2bSound(this.b2b); // rising jingle, climbs with the chain
          if (this.combo >= 1) comboSound(this.combo, keepsB2b);
          if (canceled >= 4) clutchSound();
          if (sentNow >= BIG_SEND_MIN) bigSendSound(sentNow); // spike slam
        }
        // big attack: a shaking "+N" number and a field kick that scale with it
        if (settings.effects && sentNow >= BIG_SEND_MIN) {
          sentNumber(this.fieldPanel, sentNow, (sentNow - BIG_SEND_MIN) / 12);
          this.renderer.kick(2 + Math.min(10, sentNow));
        }
        if (settings.effects) {
          if (ev.boardAfter.isEmpty()) this.renderer.fxAllClear();
          else this.renderer.fxClear(clearedRowsOf(ev), [PIECE_COLORS[ev.piece], '#ffffff']);
          const label = lockActionLabel(ev);
          if (label) {
            const sub = [this.b2b >= 2 ? `B2B ×${this.b2b}` : '', this.combo >= 1 ? `COMBO ×${this.combo}` : '', sentNow > 0 ? `+${sentNow}` : '']
              .filter(Boolean).join('   ');
            actionText(this.fieldPanel, label.main, sub, label.kind);
          }
        }
        if (canceled > 0) this.showToast(`blocked ${canceled}${sentNow > 0 ? ` · +${sentNow} sent` : ''}`);
      } else {
        if (settings.soundFx && this.combo >= 1) comboBreakSound();
        this.combo = -1;
        const rows = this.incoming.rise(this.clock);
        if (rows.length > 0) {
          this.game.addGarbage(rows);
          this.taken += rows.length;
          if (settings.soundFx) garbageSound(rows.length);
          this.renderer.fxGarbage(rows.length);
          this.renderer.fxGarbageIn(rows.length);
        }
      }
      this.b2bTag.set('B2B', this.b2b, this.b2b >= BIG_SEND_MIN);
    }

    if (this.game.topOut) {
      this.renderer.fxTopout(this.game.board, this.game.colors);
      if (settings.soundFx) topoutSound();
      this.endRound('cc');
    }
    this.refreshPanes();
  }

  /** fx/sounds for the bot's visible board (its logic lives in BotPlayer) */
  private onBotLock(ev: LockEvent): void {
    if (!settings.effects) return;
    this.botRenderer.fxLock(ev.cells);
    this.botRenderer.fxDrop(ev.cells, PIECE_COLORS[ev.piece]);
    if (ev.linesCleared > 0) {
      if (ev.boardAfter.isEmpty()) this.botRenderer.fxAllClear();
      else this.botRenderer.fxClear(clearedRowsOf(ev), [PIECE_COLORS[ev.piece], '#ffffff']);
      const label = lockActionLabel(ev);
      if (label) actionText(this.botPanel, label.main, '', label.kind);
    }
  }

  // ---- per-frame ----

  private loop(t: number): void {
    this.rafId = requestAnimationFrame((tt) => this.loop(tt));
    const dt = this.lastT ? Math.min(t - this.lastT, 100) : 0;
    this.lastT = t;
    if (this.roundLive && !this.counting) {
      this.input.update(t);
      this.applyGravity(dt);
      this.clock += dt;
      this.matchMs += dt;
      this.bot?.update(dt);
      const inc = this.incoming?.pending() ?? 0;
      if (inc > this.lastPending && settings.soundFx) garbageQueuedSound(inc - this.lastPending);
      this.lastPending = inc;
      // escalating incoming-garbage warnings + the death "!" (letting the whole
      // queue through would bury the stack past the top of the field)
      const lethal = this.warner.update(inc, this.game.board.maxHeight() + inc >= VISIBLE_H, settings.soundFx);
      this.deathWarn.classList.toggle('show', lethal);
      // meters + danger vignettes
      const cell = this.cellSize();
      const active = Math.min(this.incoming?.active(this.clock) ?? 0, 20);
      const queued = Math.min(inc - active, 20 - active);
      this.gmActive.style.height = `${active * cell}px`;
      this.gmQueued.style.height = `${queued * cell}px`;
      this.botGm.style.height = `${Math.min(this.bot?.pendingLines() ?? 0, 20) * this.botCellSize()}px`;
      this.renderer.danger = Math.max(0, Math.min(1, (this.game.board.maxHeight() - 12) / 6));
      this.botRenderer.danger = Math.max(0, Math.min(1, ((this.bot?.game.board.maxHeight() ?? 0) - 12) / 6));
      this.updateHud();
    }
    this.renderer.render(this.game);
    if (this.bot) this.botRenderer.render(this.bot.game);
  }

  // ---- panes / hud ----

  private refreshPanes(): void {
    // hold/next tiles: the shared sizing used by every mode
    const cell = this.cellSize();
    const holdCell = holdCellOf(cell);
    const queueCell = queueCellOf(cell);
    this.holdBox.querySelector('canvas')?.remove();
    this.holdBox.appendChild(renderPieceTile(this.game.hold, holdCell));
    for (const c of [...this.queueBox.querySelectorAll('canvas')]) c.remove();
    for (const p of this.game.preview()) this.queueBox.appendChild(renderPieceTile(p, queueCell));
  }

  private updateHud(): void {
    const v = settings.versus;
    const botTag = v.botLevel === 'custom' ? `${v.botNodes} nodes` : v.botLevel;
    this.hud.innerHTML =
      `<div class="alt vs-score">${this.score.me}<small>–</small>${this.score.cc}</div>` +
      // deliberately two lines - the column is too narrow for one
      `<div class="floor">first to ${v.firstTo}</div>` +
      `<div class="floor">round ${Math.max(1, this.round)}</div>` +
      `<div class="meta">time <b>${fmtTime(this.clock)}</b></div>` +
      `<div class="meta">sent <b>${this.sent}</b> · taken <b>${this.taken}</b></div>` +
      `<div class="meta">bot <b>${botTag}</b></div>` +
      `<div class="meta"><b>${v.botPps}</b> pps</div>`;
    const bot = this.bot;
    this.botHud.innerHTML = bot
      ? `sent <b>${bot.linesSent}</b> · taken <b>${bot.garbageTaken}</b>` +
        (bot.b2b >= 1 ? ` · B2B <b>×${bot.b2b}</b>` : '')
      : '&nbsp;';
  }

  private showToast(text: string): void {
    this.toast.textContent = text;
    this.toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('show'), 2600);
  }

  /**
   * A fast garbage "bolt" streaking from the attacker's field to the target's
   * garbage meter, tetr.io style. Purely cosmetic: the lines are already in
   * the receiver's queue (so they stay cancelable while the bolt is in flight,
   * and committed rows in the board are not). Thickness scales with the size
   * of the attack; the bolt fades as it merges into the meter.
   */
  private flyGarbage(fromEl: HTMLElement, toEl: HTMLElement, lines: number): void {
    if (!settings.effects || lines <= 0) return;
    const from = fromEl.getBoundingClientRect();
    const to = toEl.getBoundingClientRect();
    const x0 = from.left + from.width / 2;
    const y0 = from.top + from.height / 2;
    const x1 = to.left + to.width / 2;
    const y1 = to.top + to.height / 2;
    const bolt = document.createElement('div');
    bolt.className = 'garbage-bolt';
    bolt.style.left = `${x0}px`;
    bolt.style.top = `${y0}px`;
    bolt.style.height = `${Math.max(6, Math.min(20, lines) * 3)}px`;
    const angle = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
    bolt.style.transform = `translate(0px, 0px) rotate(${angle}deg)`;
    document.body.appendChild(bolt);
    requestAnimationFrame(() => {
      bolt.style.transform = `translate(${x1 - x0}px, ${y1 - y0}px) rotate(${angle}deg)`;
      bolt.style.opacity = '0.1';
    });
    const done = () => bolt.remove();
    bolt.addEventListener('transitionend', done, { once: true });
    window.setTimeout(done, 600); // safety net if transitionend is missed
  }
}

/** compact labelled slider for the launch overlay */
function launchSlider(name: string, unit: string, min: number, max: number, step: number, value: number, onChange: (v: number) => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'vs-slider';
  const label = document.createElement('span');
  const show = (v: number) => { label.textContent = `${name} · ${v}${unit}`; };
  show(value);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    show(v);
    onChange(v);
  });
  row.append(label, input);
  return row;
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
