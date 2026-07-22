// The drill screen: field + hold/next panes, live grading feedback with a
// docked alternatives panel on the right, undo/retry, mistake alerts.
//
// LST drill = the full flow: build the TKI opener yourself (book-checked
// per piece), the first TSD drops you into the LST loop (engine-graded with
// LST-structure bias). 4-wide drill = center well between infinite wall
// columns, graded against the 4-wide combo book (engine/fourwide.ts).
// 40 Lines = sprint on an empty board: the clock starts on your first
// input and the run ends at 40 cleared lines; placements get generic grading.

import { Game, type LockEvent } from "../core/game";
import { Board, VISIBLE_H } from "../core/board";
import { InputHandler, keyDescriptor, type Keybinds } from "../core/handling";
import {
  FieldRenderer,
  renderPieceTile,
  renderMiniBoard,
  holdCellOf,
  queueCellOf,
  sideColWidth,
} from "./board-canvas";
import {
  settings,
  saveSettings,
  onSettingsChange,
  botNodesOf,
  type OpponentKind,
} from "./settings";
import { EngineClient, type SolvedLineMove } from "./engine-client";
import { ColdClearClient, pairsOf, type CC2Move } from "./cc2-client";
import { GarbageQueue, ScheduledAttacker, versusAttack, scaleAttack } from "../core/versus";
import { BotPlayer } from "./bot-player";
import { bestMove, type GradeResult, type Grade, type AltInfo } from "../engine/grade";
import { matchOpener, chainsToLoop, planOpener, type OpenerPlacement } from "../engine/opener";
import { bookAdvice } from "../engine/book";
import { enumeratePlacements, placementKey } from "../engine/enumerate";
import { lstLoopMove } from "../engine/lst-loop";
import { lstTier } from "../engine/lst-tier";
import LST_RUNS from "../data/lst-runs.json";
// the quad pool (?quad=1) is large and only needed for that mode, so it's loaded
// on demand in the constructor - see `quadPool` - to keep it out of the default
// drill's initial bundle.
type QuadPool = typeof import("../data/lst-quad-runs.json");
import { CC2_LST_LOOP_JSON } from "../engine/cc2-weights";
import { buildFourwideStart, refillWalls, wallMask, WELL_X, WELL_W } from "../engine/fourwide";
import { genAllspin } from "../engine/allspin-gen";
import {
  gradeSound,
  actionSound,
  clearSound,
  comboSound,
  b2bBreakSound,
  b2bSound,
  topoutSound,
  personalBestSound,
  garbageSound,
  garbageQueuedSound,
  clutchSound,
  GarbageWarner,
  surgeSound,
  bigSendSound,
  BIG_SEND_MIN,
  ThunderStreak,
  thunderSound,
} from "./sound";
import { actionText, sentNumber, lockActionLabel, clearedRowsOf, ChainBubble } from "./fx";
import { SceneBackground, MODE_HUE, hotHue } from "./scene-background";
import {
  stats,
  saveStats,
  gradeAccuracy,
  emptyGrades,
  recordSession,
  fmtSprint,
  type Mode,
} from "./stats";
import { PIECE_COLORS, type PieceType } from "../core/pieces";
import type { SpinKind } from "../core/spin";
import { btn, panel } from "./dom";

// LST drill goal: 20 TSDs in one run with back-to-back never broken, the
// loop never dead, no I piece spent on a clear (quads and I-burns are
// off-plan; parking the I or laying it as build filler is fine), and not a
// single T wasted - every locked T must be a full T-spin double.
const LST_GOAL_TSDS = 20;

const GRADE_LABEL: Record<Grade, string> = {
  best: "★ Best",
  good: "Good",
  inaccuracy: "Inaccuracy",
  mistake: "Mistake",
  killer: "Loop killer",
};

const GRADE_CLASS: Record<Grade, string> = {
  best: "g-best",
  good: "g-good",
  inaccuracy: "g-inaccuracy",
  mistake: "g-mistake",
  killer: "g-killer",
};

export class GameView {
  readonly root: HTMLElement;
  private game: Game;
  private input: InputHandler;
  private renderer: FieldRenderer;
  private engine = new EngineClient();
  /** Cold Clear 2 (all-spin patched) - real bot analysis for the all-spin mode */
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
  // rolling-thunder streak: two or more big sends in a row crack the thunder,
  // fed each clearing lock's would-be attack so it fires in every mode (even
  // solo, where there is no opponent to actually receive the lines)
  private thunder = new ThunderStreak();
  // 40 lines sprint (free mode): clock starts on the first game input,
  // sprintMs is set once the run reaches 40 lines (frozen final time)
  private sprintStart = 0;
  private sprintMs: number | null = null;
  // PPS window: first game input → most recent lock (doesn't decay while idle)
  private playStart = 0;
  private lastLockAt = 0;
  private clockAt = 0; // last live-clock repaint, throttles refreshSession
  private lastT = 0; // previous rAF timestamp, for opponent dt

  // drill opponent (versus-style pressure): a scheduled attacker or a real
  // Cold Clear bot playing a hidden board, feeding one incoming queue
  private opp: {
    kind: "garbage" | "bot";
    queue: GarbageQueue;
    sched: ScheduledAttacker | null;
    bot: BotPlayer | null;
  } | null = null;
  private vsClock = 0; // pressure clock (pauses with the drill)
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
  private overlay!: HTMLElement; // top-out death screen (quickplay-style)
  private topOutHandled = false; // death screen/sound fired for this top out
  private deathWarn!: HTMLElement; // pulsing "!" when the queue would kill you
  private fieldPanel!: HTMLElement;
  private background!: SceneBackground;
  private b2bTag!: ChainBubble;
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

  // who played the last assisted move in the LST drill: the verified run
  // plan, the cover book, the goal-legal loop player, the plain engine
  // fallback, or Cold Clear 2
  private assistWho: "Plan" | "Book" | "Loop" | "Engine" | "Cold Clear" = "Book";

  // verified 20-TSD run playback (watch book): the full goal-legal move
  // line for this seed from lst-runs.json, with the board key expected
  // before each move so playback resyncs across undo and drops out the
  // moment the user deviates
  private lstPlan: { piece: PieceType; cells: [number, number][]; spin: SpinKind }[] | null = null;
  private lstPlanKeys: string[] = [];
  // plan cursor: moves confirmed played in order, plus moves the user played
  // early. Between two TSDs nothing clears, so fill placements within a
  // cycle commute - playing the plan's move a few pieces ahead of schedule
  // is the same line, and gets graded (and resumed) as such.
  private lstPlanCursor = 0;
  private lstPlanConsumed = new Set<number>();
  private lstPlanHist: { cursor: number; consumed: number[] }[] = [];
  private lastLockOnPlan = false;
  // quad drill (?quad=1): deal from the LST+quad pool instead of the 20-TSD
  // pool; the goal allows well quads (I clearing 4) and its target is the
  // seed's verified clear count (TSDs + quads), not a flat 20
  private quadMode = false;
  // ?quad=1 forces quad mode on regardless of the setting (shareable practice link)
  private quadParam = false;
  // Unpooled (testing): deal a RANDOM seed with no shipped line - plan the
  // opener live and let the bounded-window re-solve drive the loop, so you can
  // watch the live solver handle a position that isn't in the verified pool.
  // Driven by the "Unpooled seed" setting or ?unpooled=1.
  private unpooled = false;
  private unpooledParam = false;
  // lazily imported when quadMode (kept out of the initial bundle otherwise)
  private quadPool: QuadPool | null = null;
  private lstQuads = 0;
  private lstGoalTarget = LST_GOAL_TSDS;
  // re-solve on deviation: when the player goes off the verified line, re-plan
  // the road ahead from the current position off-thread and adopt it, so the
  // drill keeps guiding on the player's own line instead of nagging them back
  private resolving = false;
  private resolveFromRows: number[] | null = null;

  // last graded context for the paths dock
  private lastLock: LockEvent | null = null;
  private preview: {
    board: Board;
    colors: (PieceType | null)[][];
    cells: [number, number][];
    piece: PieceType;
  } | null = null;

  // session counters - lifetime stats only absorb these when the session
  // ends ranked (no undo, no bot assist, run finished naturally)
  private session = freshSession();

  private keydown = (e: KeyboardEvent) => this.onKeyDown(e);
  private keyup = (e: KeyboardEvent) => this.onKeyUp(e);

  constructor(mode: Mode) {
    this.mode = mode;
    // pieces spawn in the vanish zone, floating 3 rows above the field; a
    // blocked spawn clutches up through the remaining hidden rows (tetr.io's
    // clutch clear) instead of topping out outright. In 4-wide the infinite
    // wall columns must not count as stack for garbage burial.
    this.game = new Game(undefined, {
      spawnLift: 3,
      clutchRows: 1,
      wallCols: mode === "fourwide" ? wallMask() : 0,
    });
    this.input = new InputHandler(this.game);
    this.input.settings = settings.handling;
    this.input.binds = settings.binds;
    this.input.onAction = (a) => {
      if (settings.soundFx) {
        actionSound(a);
      }
    };
    this.renderer = new FieldRenderer(this.cellSize());
    // the 4-wide walls are engine-infinite so pieces can't escape the well,
    // but they should draw no taller than the field
    if (this.mode === "fourwide") {
      this.renderer.wallCols = wallMask();
    }
    this.root = this.build();
    this.game.onLock = (ev) => this.onLock(ev);
    this.engine.onResult = (r) => this.onGrade(r);
    this.engine.onSolved = (moves) => this.adoptResolvedPlan(moves);
    this.unsubSettings = onSettingsChange(() => this.applySettings());
    // quad mode comes from the "Quad loop" setting or ?quad=1 (a shareable link
    // that forces it on). When on, fetch the large quad pool on demand before the
    // first drill starts; the normal drill path runs synchronously as before.
    const urlParams = new URLSearchParams(location.search);
    this.quadParam = urlParams.get("quad") === "1";
    this.unpooledParam = urlParams.get("unpooled") === "1";
    this.unpooled = this.wantUnpooled();
    this.quadMode = this.wantQuad();
    if (this.quadMode) {
      this.ensureQuadPool(() => this.resetDrill());
    } else {
      this.resetDrill();
    }
    document.addEventListener("keydown", this.keydown);
    document.addEventListener("keyup", this.keyup);
    this.loop(performance.now());
  }

  private cellSize(): number {
    // 20 visible rows + 3 vanish rows above the field
    const fit = Math.max(14, Math.min(34, Math.floor((window.innerHeight - 140) / 24)));
    const zoomed = Math.round(fit * (settings.boardZoom / 100));
    return Math.max(10, Math.min(44, zoomed));
  }

  private queueCell(): number {
    return queueCellOf(this.cellSize());
  }
  private queueColW(): string {
    return sideColWidth(this.cellSize());
  }

  destroy(): void {
    this.flushSession();
    cancelAnimationFrame(this.rafId);
    this.background.destroy();
    clearTimeout(this.retryTimer);
    this.unsubSettings();
    this.cc2?.destroy();
    this.opp?.bot?.destroy();
    document.removeEventListener("keydown", this.keydown);
    document.removeEventListener("keyup", this.keyup);
  }

  /** Is placement evaluation on for this drill? (quick/versus have none) */
  private evalOn(): boolean {
    const m = this.mode;
    return m === "lst" || m === "fourwide" || m === "free" || m === "allspin"
      ? settings.evalDrill[m]
      : false;
  }

  /** The paths dock only exists while evaluation is on. */
  private applyEvalVisibility(): void {
    this.pathsDock.style.display = this.evalOn() ? "" : "none";
  }

  /** Re-apply settings to a live drill (zoom, handling, binds, evaluation). */
  private applySettings(): void {
    // reset-to-defaults replaces the nested objects; re-point the references
    this.input.settings = settings.handling;
    this.input.binds = settings.binds;
    this.renderer.setCellSize(this.cellSize());
    this.leftCol.style.width = this.queueColW();
    this.rightCol.style.width = this.queueColW();
    this.rightCol.style.transform = `translateY(-${this.cellSize()}px)`; // queue rides one row high
    this.applyEvalVisibility();
    if (this.evalSel) {
      this.evalSel.value = this.evalOn() ? "on" : "off";
    }
    this.refreshPanes();
    this.refreshSession();
    // the "Quad loop" / "Unpooled seed" toggles switch the pool and goal -
    // re-deal, but only when one actually flips (applySettings fires on every
    // settings change); one resetDrill covers both
    const wantQ = this.wantQuad();
    const wantU = this.wantUnpooled();
    if (wantQ !== this.quadMode || wantU !== this.unpooled) {
      this.quadMode = wantQ;
      this.unpooled = wantU;
      if (wantQ && !this.quadPool) {
        this.ensureQuadPool(() => this.resetDrill());
      } else {
        this.resetDrill();
      }
    }
  }

  /** Quad mode is on when the "Quad loop" setting is enabled or ?quad=1 forces it. */
  private wantQuad(): boolean {
    return this.mode === "lst" && (settings.lstQuad || this.quadParam);
  }

  /** Unpooled testing is on when the setting is enabled or ?unpooled=1 forces it. */
  private wantUnpooled(): boolean {
    return this.mode === "lst" && (settings.lstUnpooled || this.unpooledParam);
  }

  /** Ensure the large, lazily-imported quad pool is loaded, then run cb. */
  private ensureQuadPool(cb: () => void): void {
    if (this.quadPool) {
      cb();
      return;
    }
    void import("../data/lst-quad-runs.json").then((m) => {
      this.quadPool = (m as { default: QuadPool }).default;
      cb();
    });
  }

  private build(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "game-wrap has-scene";
    // full-scene falling-particle backdrop behind every panel, tinted to match
    // this drill's stats colour and reactive to placement pace / clears
    this.background = new SceneBackground(wrap, MODE_HUE[this.mode] ?? 205);
    wrap.appendChild(this.background.el);
    // side columns grow with zoom so the scaled piece tiles fit; the left one
    // matches the (wider) queue column so stat labels and selects have room
    const left = document.createElement("div");
    left.className = "side-col";
    left.style.width = this.queueColW();
    this.leftCol = left;
    this.holdBox = panel("Hold");
    left.appendChild(this.holdBox);
    const sess = panel("Session");
    this.statStrip = document.createElement("div");
    this.statStrip.className = "sess-grid";
    sess.appendChild(this.statStrip);
    left.appendChild(sess);
    const controls = document.createElement("div");
    controls.className = "drill-controls";
    controls.style.flexDirection = "column";
    controls.append(
      btn("Retry (R)", () => this.resetDrill()),
      btn("Undo (Ctrl+Z)", () => this.undo()),
    );
    if (this.mode === "allspin") {
      controls.append(btn("▶ Watch bot (B)", () => void this.botPlay()));
    } else if (this.mode === "lst") {
      controls.append(btn("▶ Watch book (B)", () => this.bookPlay()));
      // which engine drives "watch book" once the position leaves the book:
      // the built-in heuristic loop player, or loop-tuned Cold Clear 2
      const assistSel = document.createElement("select");
      assistSel.className = "opp-select";
      for (const [v, label] of [
        ["engine", "assist: engine"],
        ["cc2", "assist: cold clear"],
      ] as const) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = label;
        assistSel.appendChild(o);
      }
      assistSel.value = settings.lstAssist;
      assistSel.addEventListener("change", () => {
        settings.lstAssist = assistSel.value as "engine" | "cc2";
        saveSettings();
        assistSel.blur();
        if (settings.lstAssist === "cc2" && !this.cc2) {
          this.cc2 = new ColdClearClient();
        }
      });
      controls.append(assistSel);
    }
    // drill opponent: nothing, quickplay-style garbage, or a hidden Cold
    // Clear bot trading attacks with you (tunables live in Settings)
    if (this.mode === "fourwide" || this.mode === "free" || this.mode === "allspin") {
      const drillMode = this.mode;
      const sel = document.createElement("select");
      sel.className = "opp-select";
      for (const [v, label] of [
        ["off", "no opponent"],
        ["garbage", "vs garbage"],
        ["bot", "vs cold clear"],
      ] as const) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = label;
        sel.appendChild(o);
      }
      sel.value = settings.versus.drill[drillMode];
      sel.addEventListener("change", () => {
        settings.versus.drill[drillMode] = sel.value as OpponentKind;
        saveSettings();
        sel.blur();
        this.resetDrill();
      });
      controls.append(sel);
    }
    // per-mode evaluation switch - same setting as in Settings → Trainer
    if (
      this.mode === "lst" ||
      this.mode === "fourwide" ||
      this.mode === "free" ||
      this.mode === "allspin"
    ) {
      const gm = this.mode;
      const evalSel = document.createElement("select");
      evalSel.className = "opp-select";
      for (const [v, label] of [
        ["on", "evaluation on"],
        ["off", "evaluation off"],
      ] as const) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = label;
        evalSel.appendChild(o);
      }
      evalSel.value = settings.evalDrill[gm] ? "on" : "off";
      this.evalSel = evalSel;
      evalSel.addEventListener("change", () => {
        settings.evalDrill[gm] = evalSel.value === "on";
        saveSettings(); // triggers applySettings → dock visibility + session refresh
        evalSel.blur();
        this.hideFeedback();
        this.clearDock();
      });
      controls.append(evalSel);
    }
    left.appendChild(controls);

    this.fieldPanel = document.createElement("div");
    this.fieldPanel.className = "field-panel";
    const row = document.createElement("div");
    row.className = "field-row";
    const strip = document.createElement("div");
    strip.className = "board-strip";
    this.b2bTag = new ChainBubble();
    // incoming-garbage meter (only fills when a drill opponent is on)
    const meter = document.createElement("div");
    meter.className = "gmeter";
    this.gmQueued = document.createElement("div");
    this.gmQueued.className = "gm-queued";
    this.gmActive = document.createElement("div");
    this.gmActive.className = "gm-active";
    meter.append(this.gmQueued, this.gmActive);
    strip.append(meter);
    row.append(strip, this.renderer.el);
    this.fieldPanel.appendChild(row);
    this.chip = document.createElement("div");
    this.chip.className = "grade-chip";
    this.toast = document.createElement("div");
    this.toast.className = "reason-toast";
    this.deathWarn = document.createElement("div");
    this.deathWarn.className = "death-warn";
    this.deathWarn.textContent = "!";
    this.overlay = document.createElement("div");
    this.overlay.className = "zenith-overlay";
    this.fieldPanel.append(this.chip, this.toast, this.overlay, this.deathWarn);

    const right = document.createElement("div");
    right.className = "side-col";
    right.style.width = this.queueColW();
    right.style.transform = `translateY(-${this.cellSize()}px)`; // queue rides one row high
    this.rightCol = right;
    this.queueBox = panel("Next");
    right.append(this.b2bTag.el, this.queueBox);

    // docked alternatives panel
    this.pathsDock = document.createElement("aside");
    this.pathsDock.className = "paths-dock";
    const dockHead = document.createElement("div");
    dockHead.className = "dock-head";
    dockHead.innerHTML = `<span class="label">Paths</span><span class="kbd">Tab</span>`;
    this.pathsBody = document.createElement("div");
    this.pathsBody.className = "dock-body";
    this.pathsBody.innerHTML = `<div class="dock-empty">place a piece -<br>alternatives appear here</div>`;
    this.pathsDock.append(dockHead, this.pathsBody);

    wrap.append(left, this.fieldPanel, right, this.pathsDock);
    return wrap;
  }

  /**
   * Fold the session into lifetime stats and the progress charts - runs on
   * retry, top out, and leaving the drill. Strict: a session touched by undo
   * or the bot is unranked and records nothing; short stubs (<5 graded
   * placements) are noise. Returns whether anything was recorded.
   */
  private flushSession(): boolean {
    const s = this.session;
    // with evaluation off there are no grades - piece count is the size gate
    if (s.tainted || (this.evalOn() ? s.graded < 5 : s.pieces < 5)) {
      return false;
    }
    const m = stats.modes[this.mode];
    m.pieces += s.pieces;
    m.tsds += s.tsds;
    m.tsses += s.tsses;
    m.drills++;
    for (const g of Object.keys(s.grades) as Grade[]) {
      m.grades[g] += s.grades[g];
    }
    saveStats();
    // active play window only - idle time before the first input doesn't count
    const activeMs = this.playStart
      ? Math.max(0, (this.lastLockAt || Date.now()) - this.playStart)
      : Date.now() - s.startedAt;
    const pps =
      s.pieces >= 2 && activeMs > 0
        ? Math.round((s.pieces / (activeMs / 1000)) * 100) / 100
        : undefined;
    recordSession({
      at: new Date().toISOString(),
      mode: this.mode,
      pieces: s.pieces,
      tsds: s.tsds,
      grades: { ...s.grades },
      durationMs: activeMs,
      ...(pps !== undefined ? { pps } : {}),
      ...(this.mode === "fourwide" ? { maxCombo: this.maxCombo } : {}),
      ...(this.mode === "allspin" ? { maxB2b: this.maxB2b } : {}),
      ...(this.mode === "free" && this.sprintMs !== null ? { sprintMs: this.sprintMs } : {}),
    });
    return true;
  }

  /** Undo or bot assistance makes the session unranked - it won't be recorded. */
  private taintSession(what: string): void {
    if (!this.session.tainted) {
      this.session.tainted = true;
      this.showToast(`${what} - session unranked, R for a fresh ranked run`);
    }
    this.refreshSession();
  }

  /**
   * 'restart' (retry / top out): the run is recorded - retry saves the
   * session to stats the same as topping out, unless it's unranked or a
   * <5-placement stub. 'continue' (all-spin cleared its setup): new board,
   * same session.
   */
  private resetDrill(end: "restart" | "continue" = "restart"): void {
    this.engine.cancel();
    let note = "";
    if (end === "restart") {
      if (this.flushSession()) {
        note = "Retry - session saved to stats";
      } else if (this.session.graded >= 5) {
        note = "Retry - unranked session discarded";
      }
    }
    // ?seed=N pins the bag order (practice/testing); all-spin picks a fresh
    // random board each drill unless a seed is pinned. The LST drill draws
    // its random seeds from the verified-run pool: the goal's volume math
    // makes some bag orders provably unable to fit 20 clean TSDs under the
    // spawn ceiling, so the demo only deals winnable hands.
    const params = new URLSearchParams(location.search);
    const seedParam = params.get("seed");
    const runPool = this.quadMode ? (this.quadPool?.runs ?? {}) : LST_RUNS.runs;
    let lstSeeds = this.mode === "lst" ? Object.keys(runPool) : [];
    // ?tier=<warmup|standard|long|showcase> narrows the quad drill to that
    // difficulty bucket (falls back to the whole pool if the tier is empty)
    const tierParam = params.get("tier");
    if (this.quadMode && this.quadPool && tierParam) {
      const stats = this.quadPool.stats as unknown as Record<string, { clears: number }>;
      const inTier = lstSeeds.filter((s) => lstTier(stats[s].clears).name === tierParam);
      if (inTier.length > 0) {
        lstSeeds = inTier;
      }
    }
    const seed = seedParam
      ? Number(seedParam)
      : this.mode === "allspin" || (this.unpooled && this.mode === "lst")
        ? (Math.random() * 2 ** 31) | 0 // unpooled testing: any random seed, not the pool
        : this.mode === "lst" && lstSeeds.length > 0
          ? Number(lstSeeds[(Math.random() * lstSeeds.length) | 0])
          : undefined;
    if (this.mode === "fourwide") {
      this.game.reset(buildFourwideStart(seed).board, seed);
    } else if (this.mode === "allspin") {
      const setup = genAllspin(seed ?? 1, ((seed ?? 1) & 1) === 1);
      this.game.reset(setup.board, seed, [setup.spinPiece]);
    } else {
      this.game.reset(undefined, seed);
    }
    this.loadLstPlan(seed);
    this.openerPhase = this.mode === "lst";
    this.combo = 0;
    this.maxCombo = 0;
    this.thunder.reset();
    this.comboHistory = [];
    this.comboRecord =
      this.mode === "fourwide"
        ? Math.max(
            0,
            ...stats.sessions.filter((s) => s.mode === "fourwide").map((s) => s.maxCombo ?? 0),
          )
        : 0;
    this.pbPlayed = false;
    if (end === "restart") {
      this.session = freshSession();
      this.maxB2b = 0;
      this.sprintStart = 0;
      this.sprintMs = null;
      this.playStart = 0;
      this.lastLockAt = 0;
    }
    this.b2b = 0;
    this.b2bTag.reset();
    this.background.reset();
    // all-spin is a keep-the-chain drill: start mid-B2B so every clear must be
    // a spin/quad, and warm the Cold Clear worker so the first grade is quick
    if (this.mode === "allspin") {
      this.b2b = 1;
      this.maxB2b = Math.max(this.maxB2b, 1);
      this.b2bTag.set("B2B", 1);
      if (!this.cc2) {
        this.cc2 = new ColdClearClient();
      }
    }
    this.setupOpponent(end === "restart");
    this.openerHistory = [];
    this.goalFail = null;
    this.goalDone = false;
    this.lstQuads = 0;
    this.resolving = false;
    this.resolveFromRows = null;
    this.engine.cancelSolve();
    this.lastLock = null;
    this.preview = null;
    this.paused = false;
    this.input.enabled = true;
    this.topOutHandled = false;
    this.hideDeathScreen();
    this.hideFeedback();
    this.clearDock();
    this.applyEvalVisibility();
    this.refreshPanes();
    this.refreshSession();
    if (note) {
      this.showToast(note);
    }
  }

  /** Index one past the last move of the current plan cycle: the next T in
   * the plan (exclusive). Only fills before the TSD commute - the clear
   * shifts every later move's coordinates. */
  private lstPlanSegEnd(): number {
    const plan = this.lstPlan!;
    let i = this.lstPlanCursor;
    while (i < plan.length && plan[i].piece !== "T") {
      i++;
    }
    return i;
  }

  /** Advance the cursor over moves already consumed out of order. */
  private lstPlanAdvance(): void {
    while (this.lstPlanConsumed.has(this.lstPlanCursor)) {
      this.lstPlanConsumed.delete(this.lstPlanCursor);
      this.lstPlanCursor++;
    }
  }

  /** Next plan move that can be played right now: the cursor move if its
   * cells fit the live board, else a later fill of the current cycle (the
   * user may have played the cursor's move early). The TSD itself never
   * plays out of order - it needs its cycle complete. Availability is
   * checked before touching the game so a miss has no side effects. */
  private lstPlanNextPlayable(): {
    piece: PieceType;
    cells: [number, number][];
    spin: SpinKind;
  } | null {
    const plan = this.lstPlan;
    const active = this.game.active;
    if (!plan || !active) {
      return null;
    }
    const board = this.game.board;
    const fits = (cells: [number, number][]): boolean => {
      let grounded = false;
      for (const [x, y] of cells) {
        if (board.filled(x, y)) {
          return false;
        }
        if (y === 0 || board.filled(x, y - 1)) {
          grounded = true;
        }
      }
      return grounded;
    };
    const available = (piece: PieceType): boolean =>
      piece === active.type ||
      (this.game.canHold &&
        (piece === this.game.hold || (this.game.hold === null && piece === this.game.preview()[0])));
    const end = this.lstPlanSegEnd();
    const last = Math.min(end, plan.length - 1); // include the cycle's TSD
    for (let i = this.lstPlanCursor; i <= last; i++) {
      if (this.lstPlanConsumed.has(i)) {
        continue;
      }
      const mv = plan[i];
      if (i > this.lstPlanCursor && mv.piece === "T") {
        break;
      }
      if (available(mv.piece) && fits(mv.cells)) {
        return mv;
      }
    }
    return null;
  }

  /** Per-lock plan bookkeeping: match the locked placement against the plan
   * (in order, or early within the current cycle) and remember whether this
   * lock was a plan move - the grader treats those as best by definition. */
  private trackLstPlan(ev: LockEvent): void {
    this.lastLockOnPlan = false;
    if (!this.lstPlan) {
      return;
    }
    this.lstPlanHist.push({
      cursor: this.lstPlanCursor,
      consumed: [...this.lstPlanConsumed],
    });
    this.lstPlanAdvance();
    const plan = this.lstPlan;
    if (this.lstPlanCursor >= plan.length) {
      return;
    }
    const k = placementKey(ev.piece, ev.cells);
    const foot = this.colFootprint(ev.cells);
    // Orientation-lenient match: a filler (non-T, no line clear) that lands
    // flush in the same columns as a plan move is the same building block
    // however it's turned, so we don't nag the player for flipping an
    // S/Z/L/J/I. "Flush" (no gap under its own cells) is required so a
    // hole-leaving placement that only shares columns isn't waved through.
    // The T spin still has to be placed exactly - that's the whole payoff.
    const lenient =
      ev.piece !== "T" && ev.linesCleared === 0 && ev.spin === "none" && this.isFlush(ev);
    const matches = (mv: { piece: PieceType; cells: [number, number][] }): boolean =>
      placementKey(mv.piece, mv.cells) === k ||
      (lenient && mv.piece === ev.piece && this.colFootprint(mv.cells) === foot);
    const at = plan[this.lstPlanCursor];
    if (matches(at)) {
      this.lstPlanCursor++;
      this.lstPlanAdvance();
      this.lastLockOnPlan = true;
      return;
    }
    // early play: any later non-T move of the current cycle is the same line
    const end = this.lstPlanSegEnd();
    for (let i = this.lstPlanCursor + 1; i < end; i++) {
      if (!this.lstPlanConsumed.has(i) && matches(plan[i])) {
        this.lstPlanConsumed.add(i);
        this.lastLockOnPlan = true;
        return;
      }
    }
  }

  /** After a lock that left the verified line, re-plan the road ahead from the
   * current position on the worker (the solver takes seconds). One at a time;
   * the fresh line is adopted in adoptResolvedPlan when it returns. This is why
   * deviating no longer strands the drill on the reactive fallback. */
  private maybeResolveOnDeviation(): void {
    if (this.mode !== "lst" || this.openerPhase || !this.lstPlan) {
      return;
    }
    if (this.lastLockOnPlan || this.resolving || this.goalDone || this.goalFail) {
      return;
    }
    if (!this.game.active) {
      return;
    }
    const remaining = this.lstGoalTarget - (this.session.tsds + this.lstQuads);
    if (remaining <= 0) {
      return;
    }
    // Solve a bounded rolling WINDOW, not the whole remaining line. A full
    // ~18-TSD solve can't finish in the budget, so it returned nothing and the
    // drill dropped to the lawless reactive beam. A short window solves reliably
    // (measured: ~10 TSDs in ~1s); when it depletes, the next off-plan lock
    // (cursor past the plan end) re-triggers this for the following window - so
    // live play stays on the solver's clean LST instead of the beam.
    const window = Math.min(remaining, 10);
    const rows = Array.from(this.game.board.rows);
    const queue = [this.game.active.type, ...this.game.peekQueue(window * 9 + 20)];
    this.resolving = true;
    this.resolveFromRows = rows;
    this.engine.solve(rows, queue, this.game.hold, window, 4000, this.quadMode);
  }

  /** Adopt a freshly re-solved continuation as the drill's plan, anchored at
   * the board it was solved from. Empty = no clean continuation exists (the
   * deviation may have hurt the loop); the health grader still guides moves. */
  private adoptResolvedPlan(moves: SolvedLineMove[]): void {
    this.resolving = false;
    const startRows = this.resolveFromRows;
    this.resolveFromRows = null;
    if (this.mode !== "lst" || !startRows || moves.length === 0) {
      return;
    }
    const scratch = new Board();
    for (let i = 0; i < startRows.length && i < scratch.rows.length; i++) {
      scratch.rows[i] = startRows[i];
    }
    this.lstPlan = moves.map((m) => ({
      piece: m.piece,
      cells: m.cells.map(([a, b]) => [a, b] as [number, number]),
      spin: m.spin,
    }));
    this.lstPlanKeys = [];
    this.lstPlanCursor = 0;
    this.lstPlanConsumed.clear();
    this.lstPlanHist = [];
    for (const mv of this.lstPlan) {
      this.lstPlanKeys.push(scratch.key());
      scratch.place(mv.cells);
      scratch.clearLines();
    }
    this.refreshAll();
  }

  /** Grader options that make the paths dock follow the verified run: the
   * plan's move for this decision leads the alternatives (both opener and
   * loop), with its continuation as the hovered path. `idx` is the decision
   * captured before trackLstPlan advanced the cursor. */
  private planGradeOpts(idx: number): {
    planActive: boolean;
    userOnPlan: boolean;
    planMove: { piece: PieceType; cells: [number, number][] } | null;
    planPv: { piece: PieceType; cells: [number, number][]; spin: SpinKind; lines: number }[] | undefined;
  } {
    const planMove =
      this.lstPlan && idx >= 0 && idx < this.lstPlan.length ? this.lstPlan[idx] : null;
    return {
      planActive: this.mode === "lst" && !!this.lstPlan,
      userOnPlan: this.lastLockOnPlan,
      planMove: planMove ? { piece: planMove.piece, cells: planMove.cells } : null,
      planPv: planMove ? this.lstPlanPvFrom(idx) : undefined,
    };
  }

  /** The plan cursor with already-consumed (out-of-order) moves skipped -
   * the index of the move the plan expects next, without mutating state
   * (mirrors lstPlanAdvance). This is the decision the current lock answers. */
  private effectivePlanCursor(): number {
    let c = this.lstPlanCursor;
    while (this.lstPlanConsumed.has(c)) {
      c++;
    }
    return c;
  }

  /** The verified line's continuation from move `idx`+1 up to and including
   * the next TSD - the plan card's principal variation, so hovering the top
   * path traces the engine's actual road to the next payoff. */
  private lstPlanPvFrom(idx: number): {
    piece: PieceType;
    cells: [number, number][];
    spin: SpinKind;
    lines: number;
  }[] {
    const plan = this.lstPlan;
    if (!plan) {
      return [];
    }
    const pv: { piece: PieceType; cells: [number, number][]; spin: SpinKind; lines: number }[] = [];
    for (let i = idx + 1; i < plan.length; i++) {
      const mv = plan[i];
      const isTsd = mv.piece === "T" && mv.spin === "full";
      pv.push({ piece: mv.piece, cells: mv.cells, spin: mv.spin, lines: isTsd ? 2 : 0 });
      if (isTsd) {
        break;
      }
    }
    return pv;
  }

  /** Columns a placement occupies, sorted - the orientation-independent
   * footprint used to accept a filler turned a different way. */
  private colFootprint(cells: readonly (readonly [number, number])[]): string {
    return [...new Set(cells.map(([x]) => x))].sort((a, b) => a - b).join(",");
  }

  /** True when every cell of the placement is supported (board below or a
   * cell of the piece itself) - i.e. it leaves no gap underneath. */
  private isFlush(ev: LockEvent): boolean {
    const own = new Set(ev.cells.map(([x, y]) => x * 32 + y));
    return ev.cells.every(
      ([x, y]) => y === 0 || own.has(x * 32 + (y - 1)) || ev.boardBefore.filled(x, y - 1),
    );
  }

  /** Load this seed's verified 20-TSD line (if one is shipped) and stamp
   * the board key expected before each move for playback matching. */
  private loadLstPlan(seed: number | undefined): void {
    this.lstPlan = null;
    this.lstPlanKeys = [];
    this.lstPlanCursor = 0;
    this.lstPlanConsumed.clear();
    this.lstPlanHist = [];
    this.lastLockOnPlan = false;
    this.lstGoalTarget = LST_GOAL_TSDS;
    if (this.mode !== "lst" || seed === undefined) {
      return;
    }
    if (this.unpooled) {
      // no shipped line - plan the TKI opener live so the engine can auto-play
      // into a loop; once the opener depletes, maybeResolveOnDeviation re-solves
      // the loop in bounded windows. planOpener finds an opener for ~70% of
      // seeds; when it can't, the drill just starts unassisted (still testable).
      const active = this.game.active?.type;
      const plan = active ? planOpener([active, ...this.game.peekQueue(9)]) : null;
      if (plan) {
        const scratch = new Board();
        this.lstPlan = plan.moves.map((m) => ({
          piece: m.piece as PieceType,
          cells: m.cells.map(([a, b]) => [a, b] as [number, number]),
          spin: m.spin as SpinKind,
        }));
        for (const mv of this.lstPlan) {
          this.lstPlanKeys.push(scratch.key());
          scratch.place(mv.cells);
          scratch.clearLines();
        }
      }
      return;
    }
    if (this.quadMode && !this.quadPool) {
      return; // pool still loading; resetDrill re-runs once it lands
    }
    const pool = this.quadMode ? this.quadPool! : LST_RUNS;
    const run = (
      pool.runs as unknown as Record<
        string,
        { piece: string; cells: [number, number][]; spin: string }[]
      >
    )[String(seed)];
    if (!run) {
      return;
    }
    if (this.quadMode) {
      // goal target is this seed's verified clear count (TSDs + quads)
      const stat = (
        this.quadPool!.stats as unknown as Record<string, { clears: number }>
      )[String(seed)];
      this.lstGoalTarget = stat?.clears ?? LST_GOAL_TSDS;
    }
    const scratch = new Board();
    this.lstPlan = run.map((m) => ({
      piece: m.piece as PieceType,
      cells: m.cells.map(([a, b]) => [a, b] as [number, number]),
      spin: m.spin as SpinKind,
    }));
    for (const mv of this.lstPlan) {
      this.lstPlanKeys.push(scratch.key());
      scratch.place(mv.cells);
      scratch.clearLines();
    }
  }

  private undo(): void {
    // a finished sprint is final - R restarts
    if (this.sprintMs !== null) {
      return;
    }
    if (this.game.undo()) {
      this.engine.cancel();
      // drop any in-flight re-solve: it was planned from a now-undone board
      this.engine.cancelSolve();
      this.resolving = false;
      this.resolveFromRows = null;
      // opener history entries correspond 1:1 to opener-phase piece indices;
      // only truncate when the undone piece was one of them
      while (this.openerHistory.length > this.game.pieceIndex) {
        this.openerHistory.pop();
      }
      if (this.mode === "lst") {
        this.openerPhase = !this.openerHistory.some((p) => p.wasTsd);
      }
      while (this.comboHistory.length > this.game.pieceIndex) {
        this.combo = this.comboHistory.pop() ?? 0;
      }
      while (this.lstPlanHist.length > this.game.pieceIndex) {
        const snap = this.lstPlanHist.pop();
        if (snap) {
          this.lstPlanCursor = snap.cursor;
          this.lstPlanConsumed = new Set(snap.consumed);
        }
      }
      if (this.mode === "fourwide") {
        this.b2bTag.set("COMBO", this.combo);
      }
      this.lastLock = null;
      this.preview = null;
      this.topOutHandled = false;
      this.hideDeathScreen();
      this.hideFeedback();
      this.clearDock();
      this.resume();
      this.refreshPanes();
      this.taintSession("Undo");
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
   * bot worker survives retries - it just gets a fresh board and retuned
   * pace/strength.
   */
  private setupOpponent(fresh: boolean): void {
    if (!fresh && this.opp) {
      return;
    }
    const kind: OpponentKind =
      this.mode === "fourwide" || this.mode === "free" || this.mode === "allspin"
        ? settings.versus.drill[this.mode]
        : "off";
    this.vsClock = 0;
    this.vsSent = 0;
    this.vsTaken = 0;
    this.vsKos = 0;
    this.vsLastPending = 0;
    this.warner.reset();
    this.deathWarn.classList.remove("show");
    this.gmActive.style.height = "0px";
    this.gmQueued.style.height = "0px";
    if (kind === "off") {
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
      holeMin: this.mode === "fourwide" ? WELL_X : 0,
      holeMax: this.mode === "fourwide" ? WELL_X + WELL_W - 1 : 9,
    };
    const queue = new GarbageQueue(cfg);
    if (kind === "bot") {
      let bot = this.opp?.bot ?? null;
      if (bot) {
        bot.configure({
          pps: v.botPps,
          nodes: botNodesOf(v),
          rules: v.rules,
          attackScale: v.botAttackScale,
        });
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
        if (settings.soundFx) {
          personalBestSound();
        }
        this.showToast(`KO! Cold Clear topped out ×${this.vsKos} - fresh bot board`);
        this.opp?.bot?.reset((Math.random() * 2 ** 31) | 0);
        this.refreshSession();
      };
      this.opp = { kind, queue, sched: null, bot };
    } else {
      this.opp?.bot?.destroy();
      this.opp = { kind, queue, sched: new ScheduledAttacker(v.pressure), bot: null };
    }
  }

  /** Stack height for pressure warnings - in 4-wide the infinite wall
   * columns don't count, only the well. */
  private stackHeight(): number {
    const b = this.game.board;
    if (this.mode !== "fourwide") {
      return b.maxHeight();
    }
    let h = 0;
    for (let x = WELL_X; x < WELL_X + WELL_W; x++) {
      h = Math.max(h, b.columnHeight(x));
    }
    return h;
  }

  /** The pressure clock only runs while the player is actually drilling. */
  private opponentLive(): boolean {
    if (!this.opp || this.paused || this.game.topOut) {
      return false;
    }
    if (this.mode === "free" && (this.sprintStart === 0 || this.sprintMs !== null)) {
      return false;
    }
    return true;
  }

  /** Per-frame: advance the opponent, collect its attacks, drive the meter. */
  private tickOpponent(dt: number): void {
    const o = this.opp;
    if (!o) {
      return;
    }
    if (!this.opponentLive()) {
      return;
    }
    this.vsClock += dt;
    if (o.sched) {
      for (const lines of o.sched.tick(dt)) {
        o.queue.queue(lines, this.vsClock);
      }
    }
    o.bot?.update(dt);
    const pending = o.queue.pending();
    if (pending > this.vsLastPending && settings.soundFx) {
      garbageQueuedSound(pending - this.vsLastPending);
    }
    this.vsLastPending = pending;
    // escalating incoming-garbage warnings + the death "!" (letting the whole
    // queue through would bury the stack past the top of the field)
    const lethal = this.warner.update(
      pending,
      this.stackHeight() + pending >= VISIBLE_H,
      settings.soundFx,
    );
    this.deathWarn.classList.toggle("show", lethal);
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
    if (!o || !this.opponentLive()) {
      return;
    }
    if (ev.linesCleared > 0) {
      const v = settings.versus;
      const atk = scaleAttack(
        versusAttack(
          ev.linesCleared,
          ev.spin,
          comboNow,
          b2bBefore,
          ev.boardAfter.isEmpty(),
          v.rules,
        ),
        v.attackScale,
      );
      const canceled = o.queue.cancel(atk);
      const sent = atk - canceled;
      if (sent > 0) {
        this.vsSent += sent;
        o.bot?.receiveAttack(sent);
      }
      if (canceled >= 4 && settings.soundFx) {
        clutchSound();
      }
      // big attack: spike slam + a shaking "+N" number and a scaling field kick
      if (sent >= BIG_SEND_MIN) {
        if (settings.soundFx) {
          bigSendSound(sent);
        }
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
        if (settings.soundFx) {
          garbageSound(rows.length);
        }
        this.renderer.fxGarbage(rows.length);
        this.renderer.fxGarbageIn(rows.length);
      }
    }
    this.vsLastPending = o.queue.pending();
  }

  /** Feed a lock to the rolling-thunder streak (8 lines cleared in one combo,
   * cashing out a long B2B, or an all clear crack the thunder). EVERY lock is
   * fed, not just clears: a non-clearing placement breaks the combo. Runs in
   * every mode - including solo. `b2bBefore` is the chain length going in. */
  private trackThunder(ev: LockEvent, b2bBefore: number): void {
    const keepsB2b = ev.linesCleared > 0 && (ev.spin !== "none" || ev.linesCleared === 4);
    const intensity = this.thunder.hit(
      ev.linesCleared,
      keepsB2b,
      ev.boardAfter.isEmpty(),
      b2bBefore,
    );
    if (intensity > 0 && settings.soundFx) {
      thunderSound(intensity);
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    const desc = keyDescriptor(e);
    const b: Keybinds = this.input.binds;
    const has = (codes: string[]) => codes.includes(desc);

    if ((this.mode === "allspin" || this.mode === "lst") && e.code === "KeyB" && desc === e.code) {
      e.preventDefault();
      if (this.mode === "lst") {
        this.bookPlay();
      } else {
        void this.botPlay();
      }
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
      this.pathsDock.classList.toggle("collapsed");
      return;
    }
    // a finished sprint stays frozen - only R starts the next run
    if (e.code === "Escape" && this.paused && this.sprintMs === null) {
      e.preventDefault();
      this.resume();
      return;
    }
    // combo chords are view-level only; never feed them to piece movement
    if (desc !== e.code) {
      return;
    }
    if (Object.values(b).some((codes) => codes.includes(desc))) {
      e.preventDefault();
      // sprint clock starts on the first game input, not on drill reset
      if (this.mode === "free" && this.sprintStart === 0 && this.input.enabled) {
        this.sprintStart = Date.now();
      }
      // PPS clock likewise - every mode
      if (this.playStart === 0 && this.input.enabled) {
        this.playStart = Date.now();
      }
    }
    this.input.keyDown(desc, performance.now());
    this.refreshPanes();
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.input.keyUp(e.code, performance.now());
  }

  /** Canvas + popup juice for a lock: drop impact, clear bursts, action text. */
  private fxOnLock(ev: LockEvent, b2b: number, combo: number): void {
    if (!settings.effects) {
      return;
    }
    const color = PIECE_COLORS[ev.piece];
    this.renderer.fxLock(ev.cells);
    this.renderer.fxDrop(ev.cells, color);
    if (ev.linesCleared === 0) {
      return;
    }
    if (ev.boardAfter.isEmpty()) {
      this.renderer.fxAllClear();
      this.background.pulse(8, 30);
      this.background.sweep(30); // an all-clear drops a bright boundary
    } else {
      this.renderer.fxClear(clearedRowsOf(ev), [color, "#ffffff"]);
      // whoosh scales with the clear: line count + any active chain
      this.background.pulse(
        ev.linesCleared + Math.max(b2b, combo) * 0.5,
        ev.spin !== "none" ? 16 : 0,
      );
    }
    const label = lockActionLabel(ev);
    if (label) {
      const sub = [b2b >= 2 ? `B2B ×${b2b}` : "", combo >= 2 ? `COMBO ×${combo}` : ""]
        .filter(Boolean)
        .join("   ");
      actionText(this.fieldPanel, label.main, sub, label.kind);
    }
  }

  private onLock(ev: LockEvent): void {
    // bot-first edge case: a bot move can lock before any player input
    if (this.playStart === 0) {
      this.playStart = Date.now();
    }
    this.lastLockAt = Date.now();
    // clutch: the just-spawned next piece had to climb into the buffer to fit -
    // a saved block-out, announced tetr.io style
    if (this.game.clutched && !this.game.topOut) {
      if (settings.effects) {
        actionText(this.fieldPanel, "CLUTCH", "", "surge");
      }
      if (settings.soundFx) {
        clutchSound();
      }
    }
    this.comboHistory.push(this.combo);
    const b2bBefore = this.b2b; // chain state going into this placement
    if (this.mode === "fourwide") {
      // combo = consecutive clearing locks; the wall columns are infinite
      this.combo = ev.linesCleared > 0 ? this.combo + 1 : 0;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      refillWalls(this.game.board);
      this.b2bTag.set("COMBO", this.combo, this.combo >= 10);
      if (ev.linesCleared > 0 && settings.soundFx) {
        clearSound(ev.linesCleared, false, this.combo, false);
        // escalating jingle from the second consecutive clear, like tetr.io
        if (this.combo >= 2) {
          comboSound(this.combo - 1, ev.spin !== "none" || ev.linesCleared === 4);
        }
        if (!this.pbPlayed && this.comboRecord >= 3 && this.combo > this.comboRecord) {
          this.pbPlayed = true;
          personalBestSound();
          this.showToast(`New combo record - ×${this.combo}`);
        }
      }
      this.fxOnLock(ev, 0, this.combo);
      this.lastLock = ev;
      this.session.pieces++;
      if (this.evalOn()) {
        this.engine.gradeLock(ev, { fourwide: true });
      }
      this.trackThunder(ev, 0); // 4-wide is a combo drill, no back-to-back
      this.versusLock(ev, 0, this.combo - 1);
      this.handleTopOut();
      this.refreshAll();
      return;
    }
    // consecutive-clear combo (feeds the versus attack table)
    this.combo = ev.linesCleared > 0 ? this.combo + 1 : 0;
    // B2B chain: spins and quads keep it, a plain clear breaks it
    if (ev.linesCleared > 0) {
      if (ev.spin !== "none" || ev.linesCleared === 4) {
        this.b2b++;
        this.maxB2b = Math.max(this.maxB2b, this.b2b);
      } else {
        if (this.b2b > 0 && settings.soundFx) {
          b2bBreakSound();
          // cashing out a big chain
          if (this.b2b >= BIG_SEND_MIN) {
            surgeSound(this.b2b);
          }
        }
        this.b2b = 0;
      }
      if (settings.soundFx) {
        clearSound(ev.linesCleared, ev.spin === "full", this.b2b, ev.boardAfter.isEmpty());
        b2bSound(this.b2b); // rising jingle, climbs with the chain
      }
    }
    this.b2bTag.set("B2B", this.b2b, this.b2b >= BIG_SEND_MIN);
    this.fxOnLock(ev, this.b2b, 0);
    this.lastLock = ev;
    this.session.pieces++;
    this.session.lines += ev.linesCleared;
    if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) {
      this.session.tsds++;
    } else if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared === 1) {
      this.session.tsses++;
    } else if (this.quadMode && ev.piece === "I" && ev.linesCleared === 4) {
      this.lstQuads++; // the well quad: real LST's volume drain, allowed in quad mode
    }
    // the plan's expected move for THIS decision - captured before
    // trackLstPlan advances the cursor past it, so the paths dock grades this
    // lock against the right plan move (not the next piece's)
    const planDecisionIdx = this.mode === "lst" && this.lstPlan ? this.effectivePlanCursor() : -1;
    if (this.mode === "lst") {
      this.trackLstGoal(ev);
      this.trackLstPlan(ev);
      this.maybeResolveOnDeviation();
    }

    if (this.openerPhase) {
      const openerDone = ev.spin === "full" && ev.linesCleared >= 2;
      this.openerHistory.push({
        piece: ev.piece,
        cells: ev.cells.map(([a, b]) => [a, b] as [number, number]),
        wasTsd: openerDone,
      });
      // dying during the opener must still reach the death screen - the
      // grading early-returns below would skip the shared handleTopOut call
      if (this.game.topOut) {
        this.handleTopOut();
        this.refreshAll();
        return;
      }
      // book playback: keep phase bookkeeping, skip grading the book's own move
      if (this.botMoving) {
        if (openerDone) {
          this.openerPhase = false;
        }
        this.botMoveFeedback(ev);
        this.refreshAll();
        return;
      }
      // evaluation off: still advance the opener → loop phase, no grading
      if (!this.evalOn()) {
        if (openerDone) {
          this.openerPhase = false;
        }
        this.refreshAll();
        return;
      }
      const match = matchOpener(this.openerHistory);
      if (openerDone) {
        this.openerPhase = false;
        this.showChip("best", "TSD! - into LST now");
        this.recordGrade("best");
        this.dockNote("TSD ✓ - LST loop grading from here");
        this.refreshAll();
        return;
      }
      if (match.ok) {
        this.showChip("best", `Book · ${match.matching[0].name}`);
        this.recordGrade("best");
        this.dockNote(`book move ✓ (${match.matching[0].name})`);
        this.refreshAll();
        return;
      }
      // off-book: fall through to engine grading, but still hand it the plan
      // so the paths show the verified opener move (what watch-book plays),
      // not a beam guess - the early stages have to match the engine too
      this.engine.gradeLock(ev, {
        lstBias: false,
        neural: settings.neuralEval,
        ...this.planGradeOpts(planDecisionIdx),
      });
      this.refreshAll();
      return;
    }

    if (this.mode === "allspin") {
      if (this.botMoving) {
        this.botMoveFeedback(ev);
      } else if (this.evalOn()) {
        void this.gradeAllspin(ev, b2bBefore);
      }
    } else if (this.botMoving) {
      this.botMoveFeedback(ev);
    } else if (this.evalOn()) {
      // LST loop and free play both go through the paths dock so the hoverable
      // alternatives always appear. When a verified run drives the LST drill,
      // hand the grader the plan so its verdict and hint follow the watch-book
      // (which the cover book, on its own, contradicts).
      this.engine.gradeLock(ev, {
        lstBias: this.mode === "lst",
        neural: settings.neuralEval,
        ...this.planGradeOpts(planDecisionIdx),
      });
    }
    this.trackThunder(ev, b2bBefore);
    this.versusLock(ev, b2bBefore, this.combo - 1);
    if (
      this.mode === "free" &&
      this.sprintMs === null &&
      this.session.lines >= 40 &&
      !this.game.topOut
    ) {
      this.finishSprint();
    }
    this.handleTopOut();
    this.refreshAll();
    // all-spin: a cleared board earns a fresh random setup (same session)
    if (this.mode === "allspin" && ev.boardAfter.isEmpty() && !this.game.topOut) {
      this.showToast("Board cleared - new setup");
      clearTimeout(this.retryTimer);
      this.retryTimer = window.setTimeout(() => this.resetDrill("continue"), 700);
    }
  }

  /**
   * 40 lines reached - freeze the clock and the field. The run is recorded
   * (with its time) when the session flushes on retry or leaving the drill,
   * so the last placement's async grade still lands first.
   */
  private finishSprint(): void {
    this.sprintMs = Date.now() - (this.sprintStart || this.session.startedAt);
    this.paused = true;
    this.input.enabled = false;
    const prev = stats.sessions
      .filter((s) => s.mode === "free" && s.sprintMs !== undefined)
      .reduce((best, s) => Math.min(best, s.sprintMs!), Infinity);
    const pb = !this.session.tainted && this.sprintMs < prev;
    if (pb && prev !== Infinity && settings.soundFx) {
      personalBestSound();
    }
    const tag = this.session.tainted
      ? " (unranked)"
      : pb && prev !== Infinity
        ? " - new record!"
        : "";
    this.showToast(`40 lines - ${fmtSprint(this.sprintMs)}${tag} · R to retry`);
  }

  private handleTopOut(): void {
    // bot-play paths call this twice
    if (!this.game.topOut || this.topOutHandled) {
      return;
    }
    this.topOutHandled = true;
    // dead board: bound keys must not act (or click their action sounds);
    // retry and undo re-enable input
    this.input.enabled = false;
    this.renderer.fxTopout(this.game.board, this.game.colors);
    if (settings.soundFx) {
      topoutSound();
    }
    if (settings.autoRetryTopOut) {
      this.showToast("Top out - retrying…");
      clearTimeout(this.retryTimer);
      this.retryTimer = window.setTimeout(() => {
        if (this.game.topOut) {
          this.resetDrill();
        }
      }, 900);
    } else {
      this.showDeathScreen();
    }
  }

  /** Quickplay-style death screen over the topped-out board: the run's
   * headline stat, the session numbers, and the ways out. */
  private showDeathScreen(): void {
    const s = this.session;
    this.overlay.replaceChildren();
    this.overlay.classList.add("show", "results");
    const box = document.createElement("div");
    box.className = "zenith-box";
    const bits: string[] = [];
    if (this.mode === "lst") {
      bits.push(
        this.quadMode
          ? `${s.tsds + this.lstQuads}/${this.lstGoalTarget} clears`
          : `${s.tsds}/${LST_GOAL_TSDS} TSDs`,
      );
    }
    if (this.mode === "free") {
      bits.push(`${Math.min(s.lines, 40)}/40 lines`);
    }
    if (this.mode === "fourwide") {
      bits.push(`combo ×${this.maxCombo}`);
    }
    if (this.mode === "allspin") {
      bits.push(`B2B ×${this.maxB2b}`);
    }
    bits.push(`${s.pieces} pieces`);
    const pps = this.livePps();
    if (pps !== "-") {
      bits.push(`${pps} PPS`);
    }
    const activeMs = this.playStart
      ? Math.max(0, (this.lastLockAt || Date.now()) - this.playStart)
      : 0;
    if (activeMs >= 1000) {
      bits.push(fmtSprint(activeMs, false));
    }
    if (this.opp) {
      bits.push(`${this.vsSent} sent`, `${this.vsTaken} taken`);
      if (this.opp.bot && this.vsKos > 0) {
        bits.push(`${this.vsKos} KO${this.vsKos > 1 ? "s" : ""}`);
      }
    }
    box.innerHTML = `<h2>Top out</h2>
      <p class="sub">${bits.join(" · ")}</p>`;
    const row = document.createElement("div");
    row.className = "zenith-opts";
    row.append(
      btn("Retry (R)", () => this.resetDrill()),
      btn("Undo (Ctrl+Z)", () => this.undo()),
    );
    box.appendChild(row);
    this.overlay.appendChild(box);
  }

  private hideDeathScreen(): void {
    this.overlay.classList.remove("show", "results");
    this.overlay.replaceChildren();
  }

  /**
   * The LST goal run: reach LST_GOAL_TSDS TSDs with back-to-back never broken,
   * no I piece spent on a clear, and every locked T a full TSD (a TSS, flat T,
   * or T burn wastes the run). No explicit "loop alive" check - a dead loop
   * can only show up as a wasted T or a broken chain, both caught here, and a
   * rigid col-2 template test just misfires on valid right-handed / freestyle
   * loops. The first violation ends the goal until R resets the run.
   */
  private trackLstGoal(ev: LockEvent): void {
    if (this.goalDone) {
      return;
    }
    if (this.goalFail === null) {
      if (ev.piece === "T" && !(ev.spin === "full" && ev.linesCleared >= 2)) {
        this.goalFail = "T wasted ✗";
        this.showToast(
          "Goal lost - wasted a T (every T must be a full TSD) · R for a fresh 20-TSD run",
        );
      } else if (ev.linesCleared > 0 && ev.linesCleared < 4 && ev.spin === "none") {
        this.goalFail = "B2B ✗";
        this.showToast("Goal lost - broke back-to-back · R for a fresh 20-TSD run");
      } else if (
        ev.piece === "I" &&
        ev.linesCleared > 0 &&
        // in quad mode the well quad (I clearing 4) is the volume drain, allowed;
        // a 1-3 line I clear is still a wasted I in both modes
        (!this.quadMode || ev.linesCleared < 4)
      ) {
        this.goalFail = "I spent ✗";
        this.showToast(
          this.quadMode
            ? "Goal lost - the I must clear a full quad (or stay filler) · R to restart"
            : "Goal lost - spent the I on a clear · R for a fresh 20-TSD run",
        );
      }
    }
    const clears = this.session.tsds + this.lstQuads;
    if (this.goalFail === null && clears >= this.lstGoalTarget) {
      this.goalDone = true;
      if (settings.soundFx) {
        personalBestSound();
      }
      this.showToast(
        this.quadMode
          ? `Goal reached - ${lstTier(clears).name}: ${clears} clears (${this.session.tsds} TSD + ${this.lstQuads} quad), B2B intact ✓`
          : `Goal reached - ${LST_GOAL_TSDS} TSDs, B2B intact, no T or I wasted ✓`,
      );
    }
  }

  private recordGrade(g: Grade): void {
    this.session.grades[g]++;
    this.session.graded++;
    if (g === "best") {
      this.session.best++;
    }
    if (g === "mistake" || g === "killer") {
      this.session.mistakes++;
    }
    this.refreshSession();
  }

  private onGrade(r: GradeResult): void {
    let grade = r.grade;
    const openerNote = this.openerPhase ? " · left the TKI book" : "";
    // engine grading during the opener phase only happens off-book:
    // never let it look like a clean placement
    if (this.openerPhase && (grade === "best" || grade === "good")) {
      grade = "inaccuracy";
    }
    this.recordGrade(grade);
    this.renderDock(r, grade);
    // the last grade of a finished sprint still counts, but must not clobber
    // the result toast or re-pause the frozen field
    if (this.sprintMs !== null) {
      return;
    }

    const fl = settings.feedbackLevel;
    const isBad = grade === "inaccuracy" || grade === "mistake" || grade === "killer";
    if (fl === "off" && !isBad) {
      return;
    }
    if (fl === "mistakes" && !isBad) {
      return;
    }

    let label = this.gradeLabel(grade);
    if (
      this.mode !== "allspin" &&
      this.lastLock?.spin === "full" &&
      this.lastLock.linesCleared >= 2
    ) {
      label = `TSD · ${label}`;
    } else if (
      this.mode === "allspin" &&
      this.lastLock &&
      this.lastLock.spin !== "none" &&
      this.lastLock.linesCleared > 0
    ) {
      label = `${this.lastLock.piece}-spin · ${label}`;
    }
    if (r.book?.userMatched) {
      label = `Book · ${r.book.solutions[0] ?? "LST"}`;
    }
    this.showChip(grade, label + (isBad ? openerNote : ""));

    if (isBad) {
      if (r.reasons.length > 0) {
        this.showToast(r.reasons[0]);
      }
      if (grade === "mistake" || grade === "killer") {
        this.fieldPanel.classList.remove("flash-bad");
        void this.fieldPanel.offsetWidth; // restart animation
        this.fieldPanel.classList.add("flash-bad");
        if (settings.soundOnMistake) {
          gradeSound(grade);
        }
        if (settings.stopOnMistake) {
          this.paused = true;
          this.input.enabled = false;
          this.showToast(
            `${r.reasons[0] ?? "Mistake"} - Esc to continue, Ctrl+Z to undo (unranks)`,
          );
        }
      }
    } else if (r.book && !r.book.sustainable) {
      // not the player's fault, but they should know why the chain is ending
      this.showToast(
        this.mode === "fourwide"
          ? "Book: this queue cannot keep the combo to the horizon - plan the break"
          : "Book: this queue cannot sustain the loop - burn and rebuild",
      );
    }
  }

  /** grade chip label, with mode-appropriate wording for the worst grade */
  private gradeLabel(g: Grade): string {
    if (g === "killer" && this.mode === "fourwide") {
      return "Combo breaker";
    }
    if (g === "killer" && this.mode === "allspin") {
      return "Blunder";
    }
    return GRADE_LABEL[g];
  }

  // ---- docked alternatives panel ----

  private clearDock(): void {
    this.pathsBody.innerHTML = `<div class="dock-empty">place a piece -<br>alternatives appear here</div>`;
  }

  private dockNote(text: string): void {
    this.pathsBody.innerHTML = `<div class="dock-empty">${text}</div>`;
  }

  private renderDock(r: GradeResult, grade: Grade): void {
    const lock = this.lastLock;
    if (!lock) {
      return;
    }
    const before = lock.boardBefore;
    this.pathsBody.replaceChildren();

    const head = document.createElement("div");
    head.className = `dock-grade ${GRADE_CLASS[grade]}`;
    // on the verified line the beam's own ranking isn't the authority - don't
    // show a "#9" that contradicts the Best chip
    const onPlan = r.reasons[0] === "On the verified line";
    const rankNote = onPlan
      ? "on the verified line"
      : r.userRank === 0 && grade !== "best" && grade !== "good"
        ? this.mode === "fourwide"
          ? "breaks the combo book"
          : "breaks LST structure"
        : `your move ranked #${Math.min(r.userRank + 1, r.alts.length)}`;
    head.textContent = `${this.gradeLabel(grade)} · ${rankNote}`;
    this.pathsBody.appendChild(head);

    // the header already says "on the verified line"; don't repeat it as a row
    for (const reason of onPlan ? [] : r.reasons) {
      const li = document.createElement("div");
      li.className = "dock-reason";
      li.textContent = reason;
      this.pathsBody.appendChild(li);
    }

    const boardH = Math.max(6, Math.min(12, before.maxHeight() + 4));
    r.alts.forEach((alt: AltInfo, i: number) => {
      const card = document.createElement("div");
      card.className =
        "alt-card dock-card" + (alt.isUser ? " was-yours" : "") + (alt.isBook ? " is-book" : "");
      card.appendChild(renderMiniBoard(before, alt.cells, alt.piece, boardH, 11));
      const meta = document.createElement("div");
      meta.className = "meta";
      const tag =
        this.mode === "allspin"
          ? alt.spin !== "none"
            ? `spin ×${alt.linesCleared}`
            : alt.linesCleared === 4
              ? "quad"
              : alt.linesCleared > 0
                ? `${alt.linesCleared} line${alt.linesCleared > 1 ? "s" : ""} · breaks B2B`
                : ""
          : alt.spin === "full"
            ? alt.linesCleared >= 2
              ? "TSD"
              : alt.linesCleared === 1
                ? "TSS"
                : "spin"
            : alt.linesCleared > 0
              ? `${alt.linesCleared} line${alt.linesCleared > 1 ? "s" : ""}`
              : "";
      meta.innerHTML =
        `<b style="color:${PIECE_COLORS[alt.piece]}">#${i + 1} ${alt.piece}${alt.usesHold ? " (hold)" : ""}</b>` +
        `<span>${[alt.isBook ? "book" : "", tag, alt.isUser ? "yours" : ""].filter(Boolean).join(" · ")}</span>`;
      card.appendChild(meta);
      card.addEventListener("mouseenter", () => {
        this.preview = {
          board: before,
          colors: lock.colorsBefore,
          cells: alt.cells,
          piece: alt.piece,
        };
        card.classList.add("selected");
      });
      card.addEventListener("mouseleave", () => {
        this.preview = null;
        card.classList.remove("selected");
      });
      this.pathsBody.appendChild(card);
    });
  }

  // ---- lst: book playback ("watch book") ----

  /** Play the book's move for the current position: TKI targets during the
   * opener, the LST cover book in the loop, the ready TSD as the payoff.
   * When the position is off-book the loop player keeps chasing the 20-TSD
   * goal (goal-legal moves only - never a wasted T); only when even that is
   * stuck does the plain engine take over, so the button always plays. */
  private bookPlay(): void {
    if (this.mode !== "lst" || !this.game.active) {
      return;
    }
    if (this.paused) {
      this.resume();
    }
    // verified 20-TSD line for this seed: play it move for move. An exact
    // board-key match re-anchors the cursor (e.g. across undo); when the
    // user played some of the cycle's fills early the boards differ until
    // the TSD reconverges them, so fall back to the first still-unplayed
    // move of the cycle that fits. A real deviation falls through to the
    // live assists below.
    if (this.lstPlan) {
      const exact = this.lstPlanKeys.indexOf(this.game.board.key());
      if (exact >= 0 && exact < this.lstPlan.length) {
        this.lstPlanCursor = exact;
        this.lstPlanConsumed.clear();
      } else {
        this.lstPlanAdvance();
      }
      const mv = this.lstPlanNextPlayable();
      if (mv) {
        this.assistWho = "Plan";
        this.taintSession("Plan assist");
        this.botMoving = true;
        const ev = this.game.applyMove(mv.piece, mv.cells, mv.spin);
        this.botMoving = false;
        if (ev) {
          this.handleTopOut();
          this.refreshAll();
          return;
        }
      }
    }
    const queue = [this.game.active.type, ...this.game.preview()];
    let found = this.lstBookMove();
    if (found) {
      this.assistWho = "Book";
    } else if (!this.openerPhase && settings.lstAssist === "cc2") {
      // off-book loop, Cold Clear selected: let the loop-tuned bot drive
      // (async - it thinks on a worker); the rest of this method is skipped
      void this.cc2LoopPlay(queue);
      return;
    } else if (!this.openerPhase) {
      // off-book loop: hunt for a goal-legal continuation before anything
      // that would waste the T
      const loop = lstLoopMove(this.game.board, queue, this.game.hold);
      if (loop) {
        this.assistWho = "Loop";
        found = { piece: loop.piece, cells: loop.cells, spin: loop.spin };
      } else if (this.game.hold === null || this.game.hold !== "T") {
        // no legal loop move: park the T so it survives for a later TSD
        // rather than being forced onto the stack
        if (this.game.active.type === "T") {
          found = { piece: "T", cells: [], spin: "none", park: true };
          this.assistWho = "Loop";
        }
      }
    }
    if (!found) {
      // genuinely off-plan (opener miss, or the loop is unrecoverable): the
      // plain engine keeps the demo moving even if it can't stay clean
      this.assistWho = "Engine";
      const mv = bestMove(Array.from(this.game.board.rows), queue, this.game.hold, true);
      if (mv) {
        found = { piece: mv.piece, cells: mv.cells, spin: mv.spin };
      }
    }
    if (!found) {
      this.showToast("No move available - the board is jammed");
      return;
    }
    this.taintSession(`${this.assistWho} assist`);
    if (found.park) {
      if (this.game.holdPiece()) {
        this.showToast(
          this.assistWho === "Loop"
            ? `Loop: park the ${found.piece} - keep it for the next TSD`
            : `Book: park ${found.piece} in hold`,
        );
      }
      this.refreshAll();
      return;
    }
    this.botMoving = true;
    const ev = this.game.applyMove(found.piece, found.cells, found.spin);
    this.botMoving = false;
    if (!ev) {
      this.showToast(`${this.assistWho} move is not reachable here`);
    } else {
      this.handleTopOut();
    }
    this.refreshAll();
  }

  /** Off-book loop playback driven by Cold Clear 2 with the loop-tuned
   * weights (settings.lstAssist === 'cc2'). Async: the bot thinks on its
   * worker, so a later lock/undo/reset supersedes a stale result. */
  private async cc2LoopPlay(queue: PieceType[]): Promise<void> {
    if (!this.cc2) {
      this.cc2 = new ColdClearClient();
    }
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
    if (q !== this.cc2Query || this.mode !== "lst" || !this.game.active) {
      return;
    }
    const best = moves[0];
    if (!best) {
      this.showToast("Cold Clear found no move here");
      return;
    }
    const spin: SpinKind = best.spin === "f" ? "full" : best.spin === "m" ? "mini" : "none";
    this.assistWho = "Cold Clear";
    this.taintSession("Cold Clear assist");
    this.botMoving = true;
    const ev = this.game.applyMove(best.piece as PieceType, pairsOf(best.cells), spin);
    this.botMoving = false;
    if (!ev) {
      this.showToast("Cold Clear move is not reachable here");
    } else {
      this.handleTopOut();
    }
    this.refreshAll();
  }

  private lstBookMove(): {
    piece: PieceType;
    cells: [number, number][];
    spin: SpinKind;
    park?: boolean;
  } | null {
    const board = this.game.board;
    const active = this.game.active!.type;
    const holdP = this.game.hold ?? this.game.preview()[0] ?? null;
    const canHold = holdP !== null && holdP !== active;
    // a ready full T-spin double is the goal in both phases; prefer the one
    // whose result is still a book state so the loop keeps going
    const tsd = () => {
      const opts = enumeratePlacements(board, "T").filter(
        (p) => p.spin === "full" && p.linesCleared >= 2,
      );
      return opts.find((p) => bookAdvice(p.after, [], null).onBook) ?? opts[0];
    };

    if (this.openerPhase) {
      const match = matchOpener(this.openerHistory);
      // build toward a target that flows into the LST loop book when possible
      const targets = [...match.matching].sort(
        (a, b) => Number(chainsToLoop(b)) - Number(chainsToLoop(a)),
      );
      const placed = new Set(this.openerHistory.map((h) => h.piece));
      const tryPiece = (
        piece: PieceType,
      ): { piece: PieceType; cells: [number, number][]; spin: SpinKind } | null => {
        if (piece === "T") {
          // the T is always the TSD payoff - a flat drop into the notch
          // matches a target's T cells but ruins the opener
          const p = tsd();
          return p
            ? {
                piece: "T",
                cells: p.cells.map(([a, b]) => [a, b] as [number, number]),
                spin: p.spin,
              }
            : null;
        }
        for (const t of targets) {
          const want = t.pieces[piece];
          if (!want || placed.has(piece)) {
            continue;
          }
          const p = enumeratePlacements(board, piece).find((pl) => sameCells(pl.cells, want));
          if (p) {
            return {
              piece,
              cells: p.cells.map(([a, b]) => [a, b] as [number, number]),
              spin: p.spin,
            };
          }
        }
        return null;
      };
      const mv = tryPiece(active) ?? (canHold ? tryPiece(holdP) : null);
      // no spot yet (needs support, or the T came early): stash the active piece
      if (!mv && this.game.hold === null) {
        return { piece: active, cells: [], spin: "none", park: true };
      }
      return mv;
    }

    const adv = bookAdvice(board, [active, ...this.game.preview()], this.game.hold);
    if (adv.onBook) {
      // prefer keeping the hold slot free, like the book planner does
      const ordered = [...adv.moves].sort((a, b) => Number(a.usesHold) - Number(b.usesHold));
      for (const mv of ordered) {
        const p = enumeratePlacements(board, mv.piece).find((pl) => sameCells(pl.cells, mv.cells));
        if (p) {
          return {
            piece: mv.piece,
            cells: p.cells.map(([a, b]) => [a, b] as [number, number]),
            spin: p.spin,
          };
        }
      }
    }
    if (active === "T" || (canHold && holdP === "T")) {
      const p = tsd();
      if (p) {
        return {
          piece: "T",
          cells: p.cells.map(([a, b]) => [a, b] as [number, number]),
          spin: p.spin,
        };
      }
    }
    if (adv.onBook && adv.holdIsBook && this.game.hold !== active) {
      return { piece: active, cells: [], spin: "none", park: true };
    }
    return null;
  }

  // ---- all-spin: Cold Clear 2 (real bot) grading ----

  /** Let Cold Clear play its own best move on the current board (watch it). */
  private async botPlay(): Promise<void> {
    if (this.mode !== "allspin" || this.paused || !this.game.active) {
      return;
    }
    this.taintSession("Bot assist");
    if (!this.cc2) {
      this.cc2 = new ColdClearClient();
    }
    const q = ++this.cc2Query;
    const moves = await this.cc2.analyze(
      Array.from(this.game.board.rows),
      [this.game.active.type, ...this.game.preview()],
      this.game.hold,
      this.b2b > 0,
      0,
    );
    if (q !== this.cc2Query || this.mode !== "allspin" || !this.game.active) {
      return;
    }
    const best = moves[0];
    if (!best) {
      return;
    }
    const spin: SpinKind = best.spin === "f" ? "full" : best.spin === "m" ? "mini" : "none";
    this.botMoving = true;
    const ev = this.game.applyMove(best.piece as PieceType, pairsOf(best.cells), spin);
    this.botMoving = false;
    if (!ev) {
      this.showToast("Bot could not reproduce that placement");
    } else {
      this.handleTopOut();
    }
    this.refreshAll();
  }

  private botMoveFeedback(ev: LockEvent): void {
    const who = this.mode === "lst" ? this.assistWho : "Cold Clear";
    const tag =
      ev.spin !== "none" && ev.linesCleared > 0
        ? `${ev.piece}-spin ×${ev.linesCleared}`
        : ev.linesCleared === 4
          ? "quad"
          : ev.linesCleared > 0
            ? `${ev.linesCleared} line${ev.linesCleared > 1 ? "s" : ""}`
            : "build";
    this.showChip("best", `${who} · ${tag}`);
    this.dockNote(`${who} played ${ev.piece}${ev.usedHold ? " (hold)" : ""} - ${tag}`);
  }

  private async gradeAllspin(ev: LockEvent, b2bBefore: number): Promise<void> {
    if (!this.cc2) {
      this.cc2 = new ColdClearClient();
    }
    const q = ++this.cc2Query;
    const moves = await this.cc2.analyze(
      Array.from(ev.boardBefore.rows),
      ev.queueBefore,
      ev.holdBefore,
      b2bBefore > 0,
      0,
    );
    // a newer lock / undo / reset superseded this query
    if (q !== this.cc2Query || this.lastLock !== ev) {
      return;
    }
    const best = moves[0] ?? null;

    const playerKeptB2b = ev.spin !== "none" || ev.linesCleared === 4 || ev.linesCleared === 0;
    const botKeptB2b = !best || best.spin !== "n" || best.lines === 4 || best.lines === 0;
    // where does the player's move rank in Cold Clear's ordered candidates?
    const rank = moves.findIndex((m) => sameCells(ev.cells, pairsOf(m.cells)));

    let grade: Grade;
    const reasons: string[] = [];
    if (!playerKeptB2b && botKeptB2b) {
      grade = "mistake";
      reasons.push(
        `Broke back-to-back - cleared ${ev.linesCleared} line${ev.linesCleared > 1 ? "s" : ""} without a spin`,
      );
    } else if (!playerKeptB2b) {
      grade = "good"; // the chain was unavoidably lost - even the bot breaks it
    } else if (rank === 0) {
      grade = "best";
    } else if (rank >= 1 && rank <= 3) {
      grade = "good";
    } else if (rank >= 4) {
      grade = "inaccuracy"; // kept B2B but Cold Clear had clearly better lines
    } else {
      grade = "mistake"; // not even among Cold Clear's top candidates
    }
    if (rank >= 1) {
      reasons.push(`Your move was Cold Clear's #${rank + 1} choice`);
    } else if (rank < 0) {
      reasons.push(`Your move was outside Cold Clear's top ${moves.length} lines`);
    }
    if (best && grade !== "best") {
      reasons.push(`Cold Clear: ${describeMove(best)}`);
    }

    this.recordGrade(grade);
    this.renderAllspinDock(ev, moves, grade, reasons);

    const fl = settings.feedbackLevel;
    const isBad = grade === "inaccuracy" || grade === "mistake";
    if ((fl === "off" || fl === "mistakes") && !isBad) {
      return;
    }

    let label = this.gradeLabel(grade);
    if (ev.spin !== "none" && ev.linesCleared > 0) {
      label = `${ev.piece}-spin · ${label}`;
    }
    this.showChip(grade, label);
    if (isBad && reasons.length) {
      this.showToast(reasons[0]);
    }
    // a broken chain is the sharp cue - flash / stop only for real mistakes
    if (grade === "mistake") {
      this.fieldPanel.classList.remove("flash-bad");
      void this.fieldPanel.offsetWidth; // restart animation
      this.fieldPanel.classList.add("flash-bad");
      if (settings.soundOnMistake) {
        gradeSound("mistake");
      }
      if (settings.stopOnMistake) {
        this.paused = true;
        this.input.enabled = false;
        this.showToast(`${reasons[0] ?? "Mistake"} - Esc to continue, Ctrl+Z to undo (unranks)`);
      }
    } else if (!isBad && best && reasons.length) {
      this.showToast(reasons[0]); // show Cold Clear's line even on a fine move
    }
  }

  private renderAllspinDock(
    ev: LockEvent,
    moves: CC2Move[],
    grade: Grade,
    reasons: string[],
  ): void {
    const before = ev.boardBefore;
    this.pathsBody.replaceChildren();
    const head = document.createElement("div");
    head.className = `dock-grade ${GRADE_CLASS[grade]}`;
    head.textContent = `${this.gradeLabel(grade)} · Cold Clear 2`;
    this.pathsBody.appendChild(head);
    for (const reason of reasons) {
      const li = document.createElement("div");
      li.className = "dock-reason";
      li.textContent = reason;
      this.pathsBody.appendChild(li);
    }
    const boardH = Math.max(6, Math.min(12, before.maxHeight() + 4));
    const addCard = (
      cells: [number, number][],
      piece: PieceType,
      top: string,
      bot: string,
      cls: string,
    ) => {
      const card = document.createElement("div");
      card.className = "alt-card dock-card" + cls;
      card.appendChild(renderMiniBoard(before, cells, piece, boardH, 11));
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.innerHTML = `<b style="color:${PIECE_COLORS[piece]}">${top}</b><span>${bot}</span>`;
      card.appendChild(meta);
      card.addEventListener("mouseenter", () => {
        this.preview = { board: before, colors: ev.colorsBefore, cells, piece };
        card.classList.add("selected");
      });
      card.addEventListener("mouseleave", () => {
        this.preview = null;
        card.classList.remove("selected");
      });
      this.pathsBody.appendChild(card);
    };
    // Cold Clear's ranked options - an "easy" (hard-drop) tag on each move that
    // needs no tuck, so you can pick a low-effort line that still keeps B2B
    moves.slice(0, 6).forEach((m, i) => {
      const ease = m.soft ? "tuck" : "easy";
      addCard(
        pairsOf(m.cells),
        m.piece as PieceType,
        `#${i + 1} ${m.piece}${m.usesHold ? " (hold)" : ""} · ${ease}`,
        describeMove(m),
        i === 0 ? " is-book" : "",
      );
    });
    const yourTag =
      ev.spin !== "none" && ev.linesCleared > 0
        ? `spin ×${ev.linesCleared}`
        : ev.linesCleared > 0
          ? `${ev.linesCleared} line${ev.linesCleared > 1 ? "s" : ""}`
          : "no clear";
    addCard(
      ev.cells.map(([a, b]) => [a, b] as [number, number]),
      ev.piece,
      `Yours · ${ev.piece}`,
      yourTag,
      " was-yours",
    );
  }

  // ---- feedback chrome ----

  private showChip(grade: Grade, text: string): void {
    this.chip.textContent = text;
    this.chip.className = `grade-chip show ${GRADE_CLASS[grade]}`;
    clearTimeout(this.chipTimer);
    this.chipTimer = window.setTimeout(() => this.chip.classList.remove("show"), 1800);
  }

  private showToast(text: string): void {
    this.toast.textContent = text;
    this.toast.classList.add("show");
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove("show"), 3200);
  }

  private hideFeedback(): void {
    this.chip.classList.remove("show");
    this.toast.classList.remove("show");
  }

  private refreshAll(): void {
    this.refreshPanes();
    this.refreshSession();
  }

  private refreshPanes(): void {
    // hold/next tiles scale with the board zoom, like tetr.io
    const cell = this.cellSize();
    const holdCell = holdCellOf(cell);
    const queueCell = this.queueCell(); // 1.5× larger next pieces
    this.holdBox.querySelector("canvas")?.remove();
    this.holdBox.appendChild(renderPieceTile(this.game.hold, holdCell));
    for (const c of [...this.queueBox.querySelectorAll("canvas")]) {
      c.remove();
    }
    for (const t of this.game.preview()) {
      this.queueBox.appendChild(renderPieceTile(t, queueCell));
    }
  }

  /** Live PPS over the active window (first input → last lock). */
  private livePps(): string {
    if (this.playStart === 0 || this.session.pieces < 2) {
      return "-";
    }
    const ms = (this.lastLockAt || Date.now()) - this.playStart;
    if (ms < 500) {
      return "-";
    }
    return (this.session.pieces / (ms / 1000)).toFixed(2);
  }

  private refreshSession(): void {
    const s = this.session;
    const evalOn = this.evalOn();
    // this session's accuracy (resets on retry), not the lifetime number
    const acc = gradeAccuracy(s.grades);
    // third slot tints the value like the quick-play HUD: 'good' green,
    // 'warn' amber, 'bad' red, 'accent' purple for the live figures
    const cells: [string, string, ("good" | "warn" | "bad" | "accent")?][] = [];
    if (this.mode === "lst") {
      cells.push(
        ["phase", this.openerPhase ? "TKI" : "LST loop", "accent"],
        this.quadMode
          ? ["clears", `${s.tsds + this.lstQuads}/${this.lstGoalTarget}`]
          : ["TSDs", `${s.tsds}/${LST_GOAL_TSDS}`],
        [
          "goal",
          this.goalDone ? "done ✓" : (this.goalFail ?? "on track"),
          this.goalDone ? "good" : this.goalFail ? "warn" : undefined,
        ],
      );
    }
    if (this.mode === "free") {
      const clock = this.sprintMs ?? (this.sprintStart ? Date.now() - this.sprintStart : 0);
      cells.push(["time", fmtSprint(clock)], ["lines", `${Math.min(s.lines, 40)}/40`]);
    }
    if (this.mode === "fourwide") {
      cells.push(["combo", `×${this.combo}`, "accent"], ["best", `×${this.maxCombo}`, "good"]);
    }
    if (this.mode === "allspin") {
      cells.push(["B2B", `×${this.b2b}`, "accent"], ["best", `×${this.maxB2b}`, "good"]);
    }
    cells.push(["pieces", String(s.pieces)], ["PPS", this.livePps()]);
    // opponent traffic (and KOs when a real bot is on the other side)
    if (this.opp) {
      cells.push(["sent", String(this.vsSent), "good"], ["taken", String(this.vsTaken), "warn"]);
      if (this.opp.bot) {
        cells.push(["KOs", String(this.vsKos), "accent"]);
      }
    }
    if (evalOn) {
      cells.push(
        ["errors", String(s.mistakes), s.mistakes > 0 ? "bad" : undefined],
        ["acc", `${(acc * 100).toFixed(0)}%`, "warn"],
      );
    }
    const body = cells
      .map(
        ([k, v, tint]) =>
          `<div class="sc"><span class="k">${k}</span><span class="v${tint ? ` ${tint}` : ""}">${v}</span></div>`,
      )
      .join("");
    const ranked = s.tainted
      ? `<div class="sc wide rank-no"><span class="k">session</span><span class="v">unranked</span></div>`
      : `<div class="sc wide rank-ok"><span class="k">session</span><span class="v">ranked ✓</span></div>`;
    this.statStrip.innerHTML = body + ranked;
  }

  private loop(t: number): void {
    this.rafId = requestAnimationFrame((tt) => this.loop(tt));
    const dt = this.lastT ? Math.min(t - this.lastT, 100) : 0;
    this.lastT = t;
    if (!this.paused) {
      this.input.update(t);
    }
    this.tickOpponent(dt);
    // live clock/PPS repaint while a run is underway - the sprint clock ticks
    // fast; the other modes only need the PPS cell to feel alive
    const sprintLive = this.mode === "free" && this.sprintStart !== 0 && this.sprintMs === null;
    const interval = sprintLive ? 100 : 500;
    if (this.playStart !== 0 && !this.paused && !this.game.topOut && t - this.clockAt > interval) {
      this.clockAt = t;
      this.refreshSession();
    }
    // backdrop: fall speed off placement pace, colour off the live chain -
    // a long B2B / combo visibly reddens the shaft, cooling back down when broken
    const live = this.playStart !== 0 && !this.paused && !this.game.topOut;
    let pps = 0;
    if (live && this.session.pieces >= 2) {
      const ms = (this.lastLockAt || Date.now()) - this.playStart;
      if (ms > 500) {
        pps = this.session.pieces / (ms / 1000);
      }
    }
    const chain = Math.max(0, this.b2b, this.combo);
    this.background.setEnergy(live ? Math.min(1, pps / 4) : 0);
    this.background.setPush(live ? Math.min(120, chain * 8) : 0);
    this.background.setHue(hotHue(MODE_HUE[this.mode] ?? 205, chain / 10));
    this.background.frame(dt);

    if (this.preview) {
      // render preview: boardBefore with its real skins + the alternative
      // placement as its own piece skin, outlined
      this.renderer.highlight = {
        cells: this.preview.cells,
        color: "#e8b34c",
        piece: this.preview.piece,
      };
      this.renderer.renderStatic(this.preview.board, this.preview.colors);
    } else {
      this.renderer.highlight = null;
      // 40 Lines: show the tetr.io-style finish marker descending toward the
      // floor as lines clear (only once the run has started and isn't done)
      this.renderer.finishLine =
        this.mode === "free" && this.sprintMs === null ? 40 - this.session.lines : null;
      this.renderer.render(this.game);
    }
  }
}

function freshSession() {
  return {
    pieces: 0,
    tsds: 0,
    tsses: 0,
    lines: 0,
    mistakes: 0,
    best: 0,
    graded: 0,
    grades: emptyGrades(),
    startedAt: Date.now(),
    tainted: false,
  };
}

function sameCells(
  a: readonly (readonly [number, number])[],
  b: readonly (readonly [number, number])[],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const key = (c: readonly [number, number]) => c[0] * 64 + c[1];
  const sa = a.map(key).sort((x, y) => x - y);
  const sb = b.map(key).sort((x, y) => x - y);
  return sa.every((v, i) => v === sb[i]);
}

/** "T (hold) on cols 4–6 spin - clears 2" */
function describeMove(m: CC2Move): string {
  const xs = m.cells.filter((_, i) => i % 2 === 0);
  const lo = Math.min(...xs) + 1;
  const hi = Math.max(...xs) + 1;
  const cols = lo === hi ? `col ${lo}` : `cols ${lo}–${hi}`;
  const spin =
    m.spin === "f"
      ? ` ${m.lines >= 2 ? `${m.lines}-line ` : ""}spin`
      : m.spin === "m"
        ? " mini-spin"
        : m.lines === 4
          ? " quad"
          : "";
  const act = m.lines > 0 ? ` - clears ${m.lines}` : " - build";
  return `${m.piece}${m.usesHold ? " (hold)" : ""} on ${cols}${spin}${act}`;
}
