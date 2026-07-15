// Center 4-wide combo book + grading.
//
// The book (src/data/fourwide.json, see tools/gen-fourwide-db.ts) is the
// closed set of 28 canonical 3-residual states with every SRS-reachable
// continuation between them. Advice ranks continuations by how many pieces of
// the visible queue can keep comboing afterwards (hold-aware, parking in an
// empty hold is a free non-lock), mirroring how book.ts decides LST queue
// viability with the engine's own reachability. Off-book residuals (after a
// mistake) fall back to live enumeration so recovery is graded too.

import { Board } from '../core/board';
import type { PieceType, Rot } from '../core/pieces';
import type { SpinKind } from '../core/spin';
import { enumeratePlacements } from './enumerate';
import { residualKey, stateToBoard, wellCellCount } from './fourwide-core';
import type { GradeRequest, GradeResult, AltInfo, Grade } from './grade';
import bookData from '../data/fourwide.json';

export { WELL_X, WELL_W, WALL_H, refillWalls, residualKey } from './fourwide-core';

interface BookPlacement {
  piece: PieceType;
  rot: Rot;
  x: number;
  y: number;
  cells: [number, number][];
  spin: SpinKind;
  next: number;
}

interface BookState {
  key: number;
  pattern: string[];
  placements: Partial<Record<PieceType, BookPlacement[]>>;
}

const STATES = bookData.states as unknown as BookState[];
const KEY_TO_STATE = new Map(STATES.map((s, i) => [s.key, i]));

function cellKey(piece: string, cells: readonly (readonly [number, number])[]): string {
  return piece + ':' + cells.map(([x, y]) => x * 32 + y).sort((a, b) => a - b).join(',');
}

/** States that continue with the most piece types — fair drill starts. */
const START_STATES: number[] = (() => {
  const counts = STATES.map((s) => Object.keys(s.placements).length);
  const top = Math.max(...counts);
  const picks: number[] = [];
  for (let i = 0; i < STATES.length; i++) if (counts[i] >= top - 1) picks.push(i);
  return picks;
})();

/** Fresh drill board: walls + a random well-connected residual state. */
export function buildFourwideStart(seed?: number): { board: Board; stateIndex: number } {
  const r = seed === undefined
    ? Math.random()
    : (((seed * 1103515245 + 12345) >>> 8) % 10007) / 10007;
  const stateIndex = START_STATES[Math.floor(r * START_STATES.length) % START_STATES.length];
  return { board: stateToBoard(STATES[stateIndex].key), stateIndex };
}

// ---- bag accounting --------------------------------------------------------

const PIECE_BIT: Record<PieceType, number> = { I: 1, O: 2, T: 4, S: 8, Z: 16, J: 32, L: 64 };
const HOLD_IDX: Record<PieceType, number> = { I: 1, O: 2, T: 3, S: 4, Z: 5, J: 6, L: 7 };
const ALL_PIECES: PieceType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

/**
 * Multiset of the current 7-bag still undealt past the visible queue, as a
 * bitmask (0 = the bag is exactly finished; the next deal opens a fresh one).
 * Derivable exactly: dealt = pieceIndex + queue.length, and the dealt-so-far
 * part of the current bag is always a tail of the visible queue.
 */
export function bagRemainder(queue: PieceType[], pieceIndex: number): number {
  const k = (pieceIndex + queue.length) % 7;
  if (k === 0) return 0;
  if (k > queue.length) return 0; // short test queues: fall back to a fresh bag
  let mask = 127;
  for (const p of queue.slice(queue.length - k)) mask &= ~PIECE_BIT[p];
  return mask;
}

// ---- guaranteed depth ------------------------------------------------------
//
// guaranteedDepth(state, hold, bagRemainder) = how many more pieces the combo
// survives in the WORST bag order (player options per deal: place the dealt
// piece, swap-place the held piece, or park into an empty hold — no preview
// knowledge). A boolean "safe forever" version of this DP comes out empty —
// zero-lookahead 4-wide always dies to an adversarial dealer (two dead pieces
// back to back beat the single hold) — so the useful signal is the depth
// itself: it ranks horizon-reaching lines by how bag-proof their endpoint is,
// the exact role DDRKirby's genericScore plays, but bag-exact. Computed by
// value iteration over all 28 x 8 x 128 x 2 (state, hold, remainder, canHold)
// nodes — the canHold flag models the real rule that parking (a hold press
// without a lock) blocks hold until the next piece locks.

let DEPTH: Uint8Array | null = null;
const nodeIdx = (s: number, h: number, r: number, c: number) => ((s * 8 + h) * 128 + r) * 2 + c;
const DEPTH_CAP = 63;

function computeGuaranteedDepth(): Uint8Array {
  // placement next-states per (state, piece), deduped
  const nexts: number[][][] = STATES.map((s) =>
    ALL_PIECES.map((p) => [...new Set((s.placements[p] ?? []).map((m) => m.next))]),
  );
  const depth = new Uint8Array(STATES.length * 8 * 128 * 2);
  let changed = true;
  while (changed) {
    changed = false;
    for (let s = 0; s < STATES.length; s++) {
      for (let h = 0; h < 8; h++) {
        for (let r = 0; r < 128; r++) {
          for (let c = 0; c < 2; c++) {
            let worst = DEPTH_CAP;
            for (let pi = 0; pi < 7 && worst > 0; pi++) {
              const bit = 1 << pi;
              if (r !== 0 && !(r & bit)) continue; // piece not in this bag's rest
              const nr = (r === 0 ? 127 : r) & ~bit;
              let best = -1;
              for (const ns of nexts[s][pi]) {
                best = Math.max(best, depth[nodeIdx(ns, h, nr, 1)]); // lock resets hold
              }
              if (c === 1 && h !== 0 && h !== pi + 1) {
                for (const ns of nexts[s][h - 1]) {
                  best = Math.max(best, depth[nodeIdx(ns, pi + 1, nr, 1)]);
                }
              }
              if (c === 1 && h === 0) {
                best = Math.max(best, depth[nodeIdx(s, pi + 1, nr, 0)]); // park: hold locks
              }
              worst = Math.min(worst, best < 0 ? 0 : Math.min(1 + best, DEPTH_CAP));
            }
            const idx = nodeIdx(s, h, r, c);
            if (depth[idx] !== worst) { depth[idx] = worst; changed = true; }
          }
        }
      }
    }
  }
  return depth;
}

/** Worst-case pieces survivable from here with no preview knowledge. */
export function guaranteedDepth(state: number, hold: PieceType | null, remainder: number, canHold = true): number {
  DEPTH ??= computeGuaranteedDepth();
  return DEPTH[nodeIdx(state, hold === null ? 0 : HOLD_IDX[hold], remainder & 127, canHold ? 1 : 0)];
}

// ---- queue-depth chain search over the book ------------------------------

/**
 * Max queue slots consumable from `state` before a forced non-clearing lock:
 * place the active piece, place the held piece (swap), or park the active
 * piece when hold is empty (consumes a slot without locking). Past the end
 * of the visible queue the score keeps counting with guaranteedDepth — the
 * worst-case bag continuation from the horizon position — so lines that
 * survive the preview are ranked by how bag-proof their endpoint is.
 */
function chain(state: number, queue: PieceType[], qi: number, hold: PieceType | null, canHold: boolean, horizonBag: number, memo: Map<string, number>): number {
  if (qi >= queue.length) return guaranteedDepth(state, hold, horizonBag, canHold);
  const mk = `${state}|${qi}|${hold ?? '-'}|${canHold ? 1 : 0}`;
  const hit = memo.get(mk);
  if (hit !== undefined) return hit;
  const active = queue[qi];
  let best = -1;
  for (const p of STATES[state].placements[active] ?? []) {
    best = Math.max(best, 1 + chain(p.next, queue, qi + 1, hold, true, horizonBag, memo));
  }
  if (canHold && hold && hold !== active) {
    for (const p of STATES[state].placements[hold] ?? []) {
      best = Math.max(best, 1 + chain(p.next, queue, qi + 1, active, true, horizonBag, memo));
    }
  }
  if (canHold && hold === null) {
    // park: no lock happens, so hold stays blocked for the next piece
    best = Math.max(best, 1 + chain(state, queue, qi + 1, active, false, horizonBag, memo));
  }
  const out = best < 0 ? 0 : best;
  memo.set(mk, out);
  return out;
}

// ---- advice ---------------------------------------------------------------

export interface FourwideMove {
  piece: PieceType;
  rot: Rot;
  x: number;
  y: number;
  cells: [number, number][];
  spin: SpinKind;
  usesHold: boolean;
  /** post-clear canonical state (null: clears but leaves an off-book residual) */
  next: number | null;
  /** 1 + further queue slots sustainable after this placement */
  score: number;
  key: string;
}

export interface FourwideAdvice {
  /** the well is a clean canonical 3-residual */
  onBook: boolean;
  stateIndex: number | null;
  /** the visible queue can keep the combo to the horizon */
  sustainable: boolean;
  /** worst-case pieces guaranteed past the horizon on the best line */
  guaranteedBeyond: number;
  /** score of parking the active piece into an empty hold (-1: hold occupied) */
  parkScore: number;
  /** clearing placements for the active (or held) piece, best first */
  moves: FourwideMove[];
}

/** DDRKirby's genericScore: piece types with a continuation from a state. */
const STATE_NPIECES = STATES.map((s) => Object.keys(s.placements).length);

// off-book boards recur during recovery; cache their clearing placements
const dynCache = new Map<string, FourwideMove[]>();

function dynamicClears(board: Board, piece: PieceType, usesHold: boolean): FourwideMove[] {
  const k = board.key() + '|' + piece;
  let base = dynCache.get(k);
  if (!base) {
    base = [];
    for (const p of enumeratePlacements(board, piece)) {
      if (p.linesCleared === 0) continue;
      const nk = residualKey(p.after);
      base.push({
        piece,
        rot: p.rot,
        x: p.x,
        y: p.y,
        cells: p.cells.map(([a, b]) => [a, b] as [number, number]),
        spin: p.spin,
        usesHold: false,
        next: nk === null ? null : (KEY_TO_STATE.get(nk) ?? null),
        score: 0,
        key: cellKey(p.type, p.cells),
      });
    }
    if (dynCache.size > 400) dynCache.clear();
    dynCache.set(k, base);
  }
  return base.map((m) => ({ ...m, usesHold }));
}

/** Advice for a decision point. `queue` is [active, ...preview]; pieceIndex
 * (locked-piece count) pins where the 7-bag boundary falls past the queue. */
export function fourwideAdvice(board: Board, queue: PieceType[], hold: PieceType | null, pieceIndex = 0): FourwideAdvice {
  const key = residualKey(board);
  const state = key === null ? undefined : KEY_TO_STATE.get(key);
  const memo = new Map<string, number>();
  const horizonBag = bagRemainder(queue, pieceIndex);
  const active = queue[0];
  const moves: FourwideMove[] = [];
  const seen = new Set<string>();

  const holdPiece = hold ?? queue[1] ?? null;   // piece obtained by pressing hold
  const holdRest = hold ? 1 : 2;                // queue index after a hold placement
  const holdNext = queue[0];                    // what ends up held

  if (state !== undefined) {
    for (const p of STATES[state].placements[active] ?? []) {
      const score = 1 + chain(p.next, queue, 1, hold, true, horizonBag, memo);
      moves.push({ ...p, cells: p.cells.map((c) => [...c] as [number, number]), usesHold: false, next: p.next, score, key: cellKey(p.piece, p.cells) });
      seen.add(cellKey(p.piece, p.cells));
    }
    if (holdPiece && holdPiece !== active) {
      for (const p of STATES[state].placements[holdPiece] ?? []) {
        const k = cellKey(p.piece, p.cells);
        if (seen.has(k)) continue;
        const score = 1 + chain(p.next, queue, holdRest, holdNext, true, horizonBag, memo);
        moves.push({ ...p, cells: p.cells.map((c) => [...c] as [number, number]), usesHold: true, next: p.next, score, key: k });
      }
    }
  } else {
    // recovery: live enumeration; canonical landings get the book lookahead
    for (const m of dynamicClears(board, active, false)) {
      if (seen.has(m.key)) continue;
      seen.add(m.key);
      m.score = m.next !== null ? 1 + chain(m.next, queue, 1, hold, true, horizonBag, memo) : 1;
      moves.push(m);
    }
    if (holdPiece && holdPiece !== active) {
      for (const m of dynamicClears(board, holdPiece, true)) {
        if (seen.has(m.key)) continue;
        seen.add(m.key);
        m.score = m.next !== null ? 1 + chain(m.next, queue, holdRest, holdNext, true, horizonBag, memo) : 1;
        moves.push(m);
      }
    }
  }
  // score, then DDRKirby's genericScore of the landing state (continuability
  // beyond the horizon), then book landings before off-book clears
  moves.sort((a, b) =>
    b.score - a.score ||
    (b.next !== null ? STATE_NPIECES[b.next] : 0) - (a.next !== null ? STATE_NPIECES[a.next] : 0) ||
    (b.next !== null ? 1 : 0) - (a.next !== null ? 1 : 0));

  const rootScore = state === undefined ? 0 : chain(state, queue, 0, hold, true, horizonBag, memo);
  const parkScore = state !== undefined && hold === null && queue.length > 1
    ? 1 + chain(state, queue, 1, queue[0], false, horizonBag, memo)
    : -1;
  return {
    onBook: state !== undefined,
    stateIndex: state ?? null,
    sustainable: rootScore >= queue.length,
    guaranteedBeyond: Math.max(0, rootScore - queue.length),
    parkScore,
    moves,
  };
}

// ---- grading ---------------------------------------------------------------

/** How many piece types could keep the combo from this (off-book) board. */
function continuationTypes(board: Board): number {
  let n = 0;
  for (const piece of ['I', 'O', 'T', 'S', 'Z', 'J', 'L'] as PieceType[]) {
    if (dynamicClears(board, piece, false).length > 0) n++;
  }
  return n;
}

export function gradeFourwide(req: GradeRequest): GradeResult {
  const t0 = performance.now();
  const board = new Board(Uint32Array.from(req.rows));
  const advice = fourwideAdvice(board, req.queue, req.hold, req.pieceIndex);

  const userAfter = board.clone();
  userAfter.place(req.userCells);
  userAfter.clearLines();
  const userKey = cellKey(req.userPiece, req.userCells);
  const userCleared = req.userLines > 0;
  const userMove = advice.moves.find((m) => m.key === userKey);
  const bestScore = advice.moves[0]?.score ?? 0;

  let grade: Grade;
  const reasons: string[] = [];
  const bestMove = advice.moves[0];
  const betterHint = () => {
    if (!bestMove) return;
    const cols = [...new Set(bestMove.cells.map(([x]) => x))].sort((a, b) => a - b);
    reasons.push(`Better: ${bestMove.piece}${bestMove.usesHold ? ' (hold)' : ''} on columns ${cols[0] + 1}–${cols[cols.length - 1] + 1}`);
  };

  if (userMove) {
    const previewLen = req.queue.length;
    const bestAny = Math.max(bestScore, advice.parkScore); // best placement OR park
    const diff = bestScore - userMove.score;
    const userSurvivesPreview = userMove.score >= previewLen;
    // "combo will be lost": the user's line runs out within the pieces they can
    // see, while a placement (or a hold-park) existed that carries it all the
    // way through the preview. If everything dies in-preview it's a doomed
    // queue, not the player's fault — that stays out of this branch.
    const parkSaves = advice.parkScore >= previewLen && advice.parkScore > bestScore;
    if (!userSurvivesPreview && bestAny >= previewLen) {
      grade = 'mistake';
      const diesIn = userMove.score;
      reasons.push(`Combo will be lost — this line runs out in ${diesIn} piece${diesIn === 1 ? '' : 's'}; a continuation existed that survives your whole preview`);
      if (parkSaves) reasons.push(`Hold ${req.queue[0]} first — parking keeps the combo going`);
      else betterHint();
    } else if (diff <= 0) {
      grade = 'best';
      if (advice.parkScore > bestScore) {
        // placing was fine, but parking into the empty hold was strictly longer
        grade = 'good';
        reasons.push(`Book: hold ${req.queue[0]} first — parking keeps the combo ${advice.parkScore - bestScore} piece${advice.parkScore - bestScore === 1 ? '' : 's'} longer`);
      }
    } else if (userSurvivesPreview) {
      // both survive the whole preview; rank by worst-case bag continuation
      grade = 'good';
      const userBeyond = userMove.score - previewLen;
      const bestBeyond = bestScore - previewLen;
      reasons.push(`Book: survives the preview, but the best line guarantees ${bestBeyond} more piece${bestBeyond === 1 ? '' : 's'} past it whatever the bag deals (yours ${userBeyond})`);
      betterHint();
    } else if (diff === 1) {
      // combo dies within the preview whatever you do (bad queue); 1 piece short
      grade = 'good';
      reasons.push(`Book: a better continuation keeps the combo ${diff} piece longer`);
      betterHint();
    } else {
      grade = 'inaccuracy';
      reasons.push(`Book: this line dies ${diff} pieces sooner than the best continuation`);
      betterHint();
    }
  } else if (userCleared) {
    const nk = residualKey(userAfter);
    if (nk !== null && KEY_TO_STATE.has(nk)) {
      // canonical landing the book search didn't propose (e.g. via hold quirk)
      grade = advice.onBook ? 'good' : 'best';
      if (!advice.onBook) reasons.push('Recovered a book residual — combo is back on track');
    } else if (advice.onBook) {
      const types = continuationTypes(userAfter);
      if (types >= 3) {
        grade = 'inaccuracy';
        reasons.push(`Left the book: only ${types} piece types continue from this residual`);
      } else if (types >= 1) {
        grade = 'mistake';
        reasons.push(`Risky residual — only ${types} piece type${types > 1 ? 's' : ''} can continue`);
      } else {
        grade = 'killer';
        reasons.push('Dead residual — nothing continues the combo from here');
      }
      betterHint();
    } else {
      grade = 'good'; // off-book but kept the combo alive
    }
  } else if (advice.moves.length > 0) {
    grade = 'killer';
    reasons.push(`Broke the combo — ${advice.moves[0].piece}${advice.moves[0].usesHold ? ' (hold)' : ''} kept it going`);
    betterHint();
  } else if (advice.onBook) {
    grade = 'good';
    reasons.push('Forced break — this queue had no continuation');
  } else {
    grade = 'good'; // rebuilding after a break: no book judgement
  }

  // ---- alternatives list for the paths dock ----
  const alts: AltInfo[] = [];
  const toAlt = (m: FourwideMove, isUser: boolean): AltInfo => {
    const after = board.clone();
    after.place(m.cells);
    const lines = after.clearLines().length;
    return {
      piece: m.piece, rot: m.rot, x: m.x, y: m.y,
      cells: m.cells, spin: m.spin, linesCleared: lines,
      usesHold: m.usesHold, isBook: m.next !== null, total: m.score,
      afterRows: Array.from(after.rows), pv: [], isUser, path: [],
    };
  };
  for (const m of advice.moves.slice(0, 8)) alts.push(toAlt(m, m.key === userKey));
  if (userMove && !alts.some((a) => a.isUser)) alts.push(toAlt(userMove, true));
  let userRank = alts.findIndex((a) => a.isUser);
  if (userRank === -1) {
    const nk = residualKey(userAfter);
    const userScore = !userCleared ? 0 : nk !== null && KEY_TO_STATE.has(nk) ? 1 : 0.5;
    alts.push(toAlt({
      piece: req.userPiece, rot: req.userRot, x: req.userX, y: req.userY,
      cells: req.userCells, spin: req.userSpin, usesHold: req.usedHold,
      next: null, score: userScore, key: userKey,
    }, true));
    alts.sort((a, b) => b.total - a.total || (a.isUser ? 1 : 0) - (b.isUser ? 1 : 0));
    userRank = alts.findIndex((a) => a.isUser);
  }

  return {
    grade,
    gap: bestScore - (userMove?.score ?? 0),
    reasons,
    alts,
    userRank,
    pieceIndex: req.pieceIndex,
    elapsedMs: performance.now() - t0,
    book: {
      onBook: advice.onBook,
      sustainable: advice.sustainable,
      userMatched: userMove !== undefined && userMove.score >= bestScore,
      solutions: advice.onBook ? ['4-wide'] : [],
    },
  };
}

/** Off-book well cell count — the view uses it for the recovery hint. */
export function wellCells(board: Board): number {
  return wellCellCount(board);
}
