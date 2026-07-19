// A Cold Clear 2 opponent: plays its own real Game at a configurable pace
// and strength, takes garbage into its board, and emits the garbage its
// clears send. Used hidden (drill-mode pressure) or visible (the 1v1 mode).
//
// The bot's board only ever mutates inside its own lock handler, so a
// position sent to the analysis worker is still valid when the answer
// comes back — applyMove cannot race with incoming garbage.

import { Game, type LockEvent } from '../core/game';
import type { PieceType } from '../core/pieces';
import type { SpinKind } from '../core/spin';
import { GarbageQueue, versusAttack, scaleAttack, DEFAULT_RULES, type AttackRules, type GarbageConfig } from '../core/versus';
import { ColdClearClient } from './cc2-client';

export interface BotOptions {
  pps: number;    // pieces per second (mean; each move jitters a little)
  nodes: number;  // CC2 search budget per move — the strength knob
  garbage: GarbageConfig;
  rules?: AttackRules;   // damage table for the bot's clears
  attackScale?: number;  // percent handicap on the bot's outgoing attack
  seed?: number;
}

export class BotPlayer {
  readonly game: Game;
  /** garbage aimed at the bot, waiting to rise into its board */
  readonly incoming: GarbageQueue;
  b2b = 0;
  combo = -1;
  pieces = 0;
  linesSent = 0;
  garbageTaken = 0;
  dead = false;
  /** lines the bot's clear sent through (after canceling its own queue) */
  onAttack: ((lines: number) => void) | null = null;
  onTopOut: (() => void) | null = null;
  /** every bot lock (for sounds/fx on the visible 1v1 board) */
  onLockEvent: ((ev: LockEvent) => void) | null = null;

  private cc = new ColdClearClient();
  private nowMs = 0;
  private nextMoveAtMs: number;
  private thinking = false;
  private destroyed = false;

  constructor(private opts: BotOptions) {
    // match the human board: pieces float 2 rows above the field
    this.game = new Game(opts.seed, { spawnLift: 3, clutchRows: 1 });
    this.incoming = new GarbageQueue(opts.garbage);
    this.game.onLock = (ev) => this.onLock(ev);
    // grace period before the first move so the countdown feels fair
    this.nextMoveAtMs = this.moveGapMs();
  }

  private moveGapMs(): number {
    return (1000 / this.opts.pps) * (0.85 + 0.3 * Math.random());
  }

  /** Retune pace/strength/rules without rebuilding the worker. */
  configure(opts: Partial<Omit<BotOptions, 'garbage' | 'seed'>>): void {
    Object.assign(this.opts, opts);
  }

  /** Opponent (the player) sent lines at the bot. */
  receiveAttack(lines: number): void {
    if (lines > 0) this.incoming.queue(lines, this.nowMs);
  }

  pendingLines(): number {
    return this.incoming.pending();
  }

  /** lines whose telegraph elapsed on the bot's own clock */
  activeLines(): number {
    return this.incoming.active(this.nowMs);
  }

  /** Fresh board for a new round; keeps the worker warm. */
  reset(seed?: number): void {
    this.game.reset(undefined, seed);
    this.incoming.clear();
    this.b2b = 0;
    this.combo = -1;
    this.pieces = 0;
    this.linesSent = 0;
    this.garbageTaken = 0;
    this.dead = false;
    this.nowMs = 0;
    this.nextMoveAtMs = this.moveGapMs();
  }

  /** Advance the bot's clock; fires a move when one is due. */
  update(dtMs: number): void {
    this.nowMs += dtMs;
    if (this.dead || this.destroyed || this.thinking) return;
    if (this.nowMs < this.nextMoveAtMs) return;
    void this.makeMove();
  }

  private async makeMove(): Promise<void> {
    const g = this.game;
    const a = g.active;
    if (!a) return;
    this.thinking = true;
    const moves = await this.cc.analyze(
      Array.from(g.board.rows),
      [a.type, ...g.preview()],
      g.hold,
      this.b2b > 0,
      Math.max(0, this.combo),
      this.opts.nodes,
    );
    this.thinking = false;
    if (this.dead || this.destroyed || !g.active) return;
    const best = moves[0];
    if (best) {
      const spin: SpinKind = best.spin === 'f' ? 'full' : best.spin === 'm' ? 'mini' : 'none';
      const cells: [number, number][] = [];
      for (let i = 0; i + 1 < best.cells.length; i += 2) cells.push([best.cells[i], best.cells[i + 1]]);
      if (!g.applyMove(best.piece as PieceType, cells, spin)) g.hardDrop();
    } else {
      // no suggestion (position too dire / worker hiccup): drop and move on
      g.hardDrop();
    }
    this.nextMoveAtMs = this.nowMs + this.moveGapMs();
  }

  private onLock(ev: LockEvent): void {
    this.pieces++;
    if (ev.linesCleared > 0) {
      this.combo++;
      const keepsB2b = ev.spin !== 'none' || ev.linesCleared === 4;
      const atk = scaleAttack(
        versusAttack(ev.linesCleared, ev.spin, this.combo, this.b2b, ev.boardAfter.isEmpty(), this.opts.rules ?? DEFAULT_RULES),
        this.opts.attackScale ?? 100,
      );
      this.b2b = keepsB2b ? this.b2b + 1 : 0;
      const sent = atk - this.incoming.cancel(atk);
      if (sent > 0) {
        this.linesSent += sent;
        this.onAttack?.(sent);
      }
    } else {
      this.combo = -1;
      const rows = this.incoming.rise(this.nowMs);
      if (rows.length > 0) {
        this.game.addGarbage(rows);
        this.garbageTaken += rows.length;
      }
    }
    this.onLockEvent?.(ev);
    if (this.game.topOut) {
      this.dead = true;
      this.onTopOut?.();
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.cc.destroy();
  }
}
