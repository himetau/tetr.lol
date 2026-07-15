// Grade the placement the user just made against every alternative the
// engine can find, with lookahead over the real queue. Produces a grade,
// human-readable reasons, and the ranked alternative list for the paths view.

import { Board } from '../core/board';
import type { PieceType, Rot } from '../core/pieces';
import type { SpinKind } from '../core/spin';
import { enumeratePlacements, type Placement } from './enumerate';
import { evaluateBoard, clearReward, findTSlots, findLstSite, LST_SPIN_COL, type EvalBreakdown } from './eval';
import { searchBestLine, LOOP_DEATH_TOLL, WASTED_T_TOLL, B2B_BREAK_TOLL, breaksB2b, type SearchOptions, DEFAULT_SEARCH } from './search';
import { bookAdvice, matchesBookMove, OFF_BOOK } from './book';

export type Grade = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'killer';

export interface GradeRequest {
  rows: number[];             // boardBefore
  queue: PieceType[];         // [activePiece, ...preview] at decision time
  hold: PieceType | null;     // hold at decision time
  userCells: [number, number][];
  userPiece: PieceType;
  userRot: Rot;
  userX: number;
  userY: number;
  userSpin: SpinKind;
  userLines: number;
  usedHold: boolean;
  pieceIndex: number;
  /** bias evaluation toward the canonical LST structure (spin column 2) */
  lstBias?: boolean;
  /** learned evaluator on top of the heuristic (default on) */
  neural?: boolean;
  /** grade against the center 4-wide combo book instead (engine/fourwide.ts) */
  fourwide?: boolean;
}

export interface AltInfo {
  piece: PieceType;
  rot: Rot;
  x: number;
  y: number;
  cells: [number, number][];
  spin: SpinKind;
  linesCleared: number;
  usesHold: boolean;
  isBook: boolean;
  total: number;              // immediate reward + lookahead score
  afterRows: number[];
  /** principal variation after this placement: cells of each future piece */
  pv: { piece: PieceType; cells: [number, number][]; spin: SpinKind; lines: number }[];
  isUser: boolean;
  path: string[];
}

export interface BookInfo {
  onBook: boolean;
  /** some book build is completable with the visible queue (+hold) */
  sustainable: boolean;
  /** the user's placement was a book move */
  userMatched: boolean;
  /** consistent book solutions, e.g. "flattop LST bag 2: D" */
  solutions: string[];
}

export interface GradeResult {
  grade: Grade;
  gap: number;
  reasons: string[];
  alts: AltInfo[];            // ranked best-first, includes the user's move
  userRank: number;           // 0-based rank of the user's placement
  pieceIndex: number;
  elapsedMs: number;
  book?: BookInfo;
}

const PRUNE_TOP = 14;
const RETURN_TOP = 8;

interface Candidate {
  placement: Placement;
  usesHold: boolean;
  queueAfter: PieceType[];    // remaining queue for lookahead
  holdAfter: PieceType | null;
  immediateReward: number;
  immediateScore: number;
  breakdown: EvalBreakdown;
  total?: number;
  pv?: Placement[];
}

/** "flattop LST bag 2: D (66.7%) (mirrored)" -> "flattop LST bag 2: D" */
function shortSolutionName(label: string | undefined): string {
  return (label ?? 'cover book').replace(/ \(mirrored\)$/, '').replace(/ \(\d+(\.\d+)?%.*?\)/, '');
}

function cellKey(cells: readonly (readonly [number, number])[]): string {
  return cells
    .map(([a, b]) => a * 32 + b)
    .sort((x, y) => x - y)
    .join(',');
}

export function gradePlacement(req: GradeRequest, search: SearchOptions = DEFAULT_SEARCH): GradeResult {
  const t0 = performance.now();
  const bias = req.lstBias ?? false;
  const opts: SearchOptions = { ...search, lstBias: bias };
  const board = new Board(Uint32Array.from(req.rows));
  const active = req.queue[0];
  const preview = req.queue.slice(1);

  const candidates: Candidate[] = [];
  const hadReadySlot = findTSlots(board).some((s) => s.clears2);
  const userTsd = req.userPiece === 'T' && req.userSpin === 'full' && req.userLines >= 2;
  const book = bias ? bookAdvice(board, req.queue, req.hold) : OFF_BOOK;
  const userOnBookMove = book.onBook && matchesBookMove(book, req.userPiece, req.userCells);

  const addCandidates = (piece: PieceType, usesHold: boolean, queueAfter: PieceType[], holdAfter: PieceType | null) => {
    for (const p of enumeratePlacements(board, piece)) {
      let immediateReward = clearReward({ linesCleared: p.linesCleared, spin: p.spin }, p.type);
      // in LST every T is TSD fuel: spending it without a full spin is a
      // waste (worse still when the TSD was sitting there ready)
      if (piece === 'T' && p.spin !== 'full') {
        if (hadReadySlot) immediateReward -= 320;
        else if (bias) immediateReward += WASTED_T_TOLL;
      }
      // entering a loop-dead state is a permanent toll on the line
      if (bias && !findLstSite(p.after)) immediateReward += LOOP_DEATH_TOLL;
      // breaking back-to-back is a permanent toll too — a burn that tidies
      // the stack must not outrank the move that keeps the chain
      if (bias && breaksB2b(p.linesCleared, p.spin)) immediateReward += B2B_BREAK_TOLL;
      const ev = evaluateBoard(p.after, bias);
      candidates.push({
        placement: p,
        usesHold,
        queueAfter,
        holdAfter,
        immediateReward,
        immediateScore: immediateReward + ev.score,
        breakdown: ev.b,
      });
    }
  };

  addCandidates(active, false, preview, req.hold);
  const holdPiece = req.hold ?? preview[0];
  if (holdPiece && holdPiece !== active) {
    addCandidates(holdPiece, true, req.hold ? preview : preview.slice(1), active);
  } else if (holdPiece === active && req.hold) {
    // same piece via hold: identical placements, skip
  }

  // locate the user's move
  const userKey = cellKey(req.userCells);
  let userCand = candidates.find(
    (c) => c.usesHold === req.usedHold && c.placement.type === req.userPiece && cellKey(c.placement.cells) === userKey,
  );
  // fallback: match by cells only (hold bookkeeping edge cases)
  userCand ??= candidates.find((c) => c.placement.type === req.userPiece && cellKey(c.placement.cells) === userKey);

  // prune, always keeping the user's move
  candidates.sort((a, b) => b.immediateScore - a.immediateScore);
  const pruned = candidates.slice(0, PRUNE_TOP);
  if (userCand && !pruned.includes(userCand)) pruned.push(userCand);

  for (const c of pruned) {
    const line = searchBestLine(c.placement.after, c.queueAfter, 0, c.holdAfter, true, opts);
    c.total = c.immediateReward + line.score;
    c.pv = line.placements;
  }

  pruned.sort((a, b) => (b.total ?? -1e9) - (a.total ?? -1e9));

  // Second opinion: re-search everything we are about to show (and the
  // user's move) deeper before committing to a verdict. Shallow-lookahead
  // flip-flops between near-equal candidates are where wrong hints come
  // from; the verdict and the "Better:" hint must come from the same,
  // deeper ranking.
  const VERIFY_TOP = 5;
  const verify = new Set(pruned.slice(0, VERIFY_TOP));
  if (userCand) verify.add(userCand);
  if (verify.size > 1) {
    const deeper: SearchOptions = { ...opts, depth: opts.depth + 2, beamWidth: opts.beamWidth + 4 };
    for (const c of verify) {
      const line = searchBestLine(c.placement.after, c.queueAfter, 0, c.holdAfter, true, deeper);
      c.total = c.immediateReward + line.score;
      c.pv = line.placements;
    }
    pruned.sort((a, b) => (b.total ?? -1e9) - (a.total ?? -1e9));
  }
  const best = pruned[0];
  const userTotal = userCand?.total ?? -1e9;
  const gap = (best?.total ?? 0) - userTotal;
  const userRank = userCand ? pruned.indexOf(userCand) : pruned.length;

  // ---- grade thresholds ----
  let grade: Grade;
  if (!userCand) grade = 'mistake';
  else if (gap <= 1) grade = 'best';
  else if (gap <= 100) grade = 'good';
  else if (gap <= 240) grade = 'inaccuracy';
  else if (gap <= 520) grade = 'mistake';
  else grade = 'killer';

  const GRADE_RANK: Record<Grade, number> = { best: 0, good: 1, inaccuracy: 2, mistake: 3, killer: 4 };
  const atLeast = (g: Grade) => {
    if (GRADE_RANK[grade] < GRADE_RANK[g]) grade = g;
  };

  // ---- reasons + structural grade floors ----
  // The gap alone can look small right after a clear (everything recovers in
  // the lookahead), so structural violations force a minimum severity: they
  // are what "wrong feedback" feels like when they slip through as "Good".
  const reasons: string[] = [];
  if (userCand && best && userCand !== best) {
    const u = userCand.breakdown;
    const b = best.breakdown;

    // in LST mode only deep burials floor the grade — shallow depth-1
    // overhangs are how the book builds the next spin space
    const newHoles = u.holes - b.holes;
    const newDeep = u.deepHoles - b.deepHoles;
    if (bias) {
      if (newDeep >= 1) {
        reasons.push(newDeep === 1 ? 'Buried a cell deep in the stack' : `Buried ${newDeep} cells deep in the stack`);
        atLeast(newDeep >= 2 ? 'killer' : 'mistake');
      } else if (newHoles >= 2) {
        reasons.push(`Created ${newHoles} covered cells`);
        atLeast('inaccuracy');
      }
    } else if (newHoles >= 1) {
      reasons.push(newHoles === 1 ? 'Created a hole in the stack' : `Created ${newHoles} holes in the stack`);
      atLeast(newHoles >= 2 ? 'killer' : 'mistake');
    }
    // spending the slot on a full TSD is not "destroying" it
    if (u.tslots < b.tslots && !userTsd) {
      const boardHadSlot = findTSlots(board).length > 0;
      reasons.push(boardHadSlot ? 'Destroyed your T-spin slot' : 'Gave up the T-spin slot the best move keeps');
      atLeast('inaccuracy');
    }
    // (spin-column check happens below, outside this block — it must fire
    // even when the engine ranked the user's move #1)
    if (req.userPiece === 'T' && req.userSpin !== 'full' && hadReadySlot) {
      reasons.push('Wasted the T piece — a full T-spin was available');
      atLeast('mistake');
    } else if (req.userPiece === 'T' && req.userSpin !== 'full' && best.placement.type === 'T' && best.placement.spin === 'full') {
      reasons.push('Wasted the T piece — a full T-spin was available');
      atLeast('inaccuracy');
    }
    if (u.badOverhangs > b.badOverhangs) {
      reasons.push('Left an overhang that is not a T-spin roof');
    }
    if (u.bumpiness > b.bumpiness + 3) {
      reasons.push('Made the surface much bumpier than needed');
    }
    if (u.maxHeight > b.maxHeight + 2) {
      reasons.push('Stacked higher than necessary');
    }
  }
  if (!userCand) reasons.push('Unexpected placement — engine could not match it');

  // LST loop-viability check: absolute, against the pre-placement board and
  // independent of ranking — even a #1-ranked move that kills the loop is a
  // canon violation. "Killed" = there was a buildable col-2 TSD site before
  // this placement and there is none after it. When the cover book proves the
  // visible queue cannot sustain the loop anyway, losing it is not the
  // player's fault — inform, don't punish.
  // a stage-finishing TSD is not in the build books (their T placements are
  // implied); it is canon when the cleared result is itself a book state —
  // the col-2 heuristic otherwise mis-grades mirrored loops here
  const tsdBook =
    bias && !userOnBookMove && userCand && req.userPiece === 'T' && req.userSpin === 'full' && req.userLines >= 2
      ? bookAdvice(userCand.placement.after, userCand.queueAfter, userCand.holdAfter)
      : OFF_BOOK;
  const userOnBook = userOnBookMove || tsdBook.onBook;
  const bookSaysForced = book.onBook && !book.sustainable;
  if (bias && userCand && !userOnBook) {
    const siteBefore = findLstSite(board);
    const siteAfter = findLstSite(userCand.placement.after);
    if (siteBefore && !siteAfter) {
      const pluggedCol = userCand.placement.cells.some(([cx]) => cx === LST_SPIN_COL) &&
        userCand.placement.after.columnHeight(LST_SPIN_COL) > 0;
      reasons.unshift(pluggedCol
        ? 'Plugged the LST spin column (3rd column) — the loop is dead'
        : 'Killed the LST loop — the next TSD can no longer be built');
      if (!bookSaysForced) {
        // if any decent alternative kept the loop alive, this was avoidable
        const avoidable = pruned.some((c) => c !== userCand && findLstSite(c.placement.after) !== null);
        atLeast(avoidable ? 'killer' : 'mistake');
      }
    } else if (!userTsd && siteBefore && siteAfter && siteAfter.missing > siteBefore.missing + 4) {
      // right after a TSD the next site always starts from scratch — only
      // non-TSD moves can genuinely "move away" from it
      reasons.push('Moved away from the next TSD — extra cells now needed to rebuild');
      atLeast('inaccuracy');
    }
  }

  // Back-to-back is canon: a plain burn breaks the chain. Only when the
  // loop is genuinely lost anyway (book proves the queue cannot sustain it,
  // it was already dead, or every alternative also burns/dies) is burning
  // the correct recovery play — then it is not flagged at all.
  if (userCand && breaksB2b(req.userLines, req.userSpin)) {
    if (!bias) {
      if (best && best !== userCand) {
        reasons.push(`Burned ${req.userLines} line${req.userLines > 1 ? 's' : ''} without a T-spin`);
        atLeast('inaccuracy');
      }
    } else if (findLstSite(board) && !bookSaysForced) {
      const avoidable = pruned.some((c) => c !== userCand &&
        !breaksB2b(c.placement.linesCleared, c.placement.spin) &&
        findLstSite(c.placement.after) !== null);
      if (avoidable) {
        reasons.unshift(`Broke back-to-back — burned ${req.userLines} line${req.userLines > 1 ? 's' : ''} without a spin`);
        atLeast('mistake');
      }
    }
  }

  // a full TSD that leaves the loop alive is the loop doing exactly what it
  // is for — whatever the lookahead gap says, never flag it as bad play
  if (bias && userTsd && userCand && findLstSite(userCand.placement.after) && GRADE_RANK[grade] > GRADE_RANK.good) {
    grade = 'good';
  }

  // ---- cover-book verdicts (canon beats the heuristic in both directions) ----
  if (tsdBook.onBook && userCand) {
    grade = 'best';
    reasons.length = 0;
    reasons.push(`Book TSD — into ${shortSolutionName(tsdBook.solutions[0])}`);
  } else if (book.onBook && userCand) {
    if (userOnBook) {
      // canon move: whatever the heuristic thought, this is the book line
      grade = 'best';
      reasons.length = 0;
      reasons.push(`Book move — ${shortSolutionName(book.solutions[0])}`);
    } else if (bookSaysForced) {
      reasons.push('Book: no continuation covers this queue — the loop cannot be sustained this bag');
    } else if (book.moves.length > 0) {
      const m = book.moves.find((mv) => !mv.usesHold) ?? book.moves[0];
      const xs = m.cells.map(([cx]) => cx);
      const lo = Math.min(...xs) + 1;
      const hi = Math.max(...xs) + 1;
      reasons.push(`Book keeps the loop: ${m.piece}${m.usesHold ? ' after holding' : ''} on column${lo === hi ? '' : 's'} ${lo}${lo === hi ? '' : `–${hi}`}`);
      if (!userTsd) atLeast('inaccuracy'); // a loop-keeping TSD off the book is a different valid line
    } else if (book.holdIsBook) {
      reasons.push(`Book: hold the ${req.userPiece} — it is needed later in this build`);
      if (!userTsd) atLeast('inaccuracy');
    }
  }

  // concrete improvement hint: name the engine's preferred move (unless the
  // book already named its own — two competing suggestions is how the old
  // engine talked the player out of the loop)
  const bookHinted = book.onBook && !userOnBook && (book.moves.length > 0 || book.holdIsBook);
  if (userCand && best && best !== userCand && GRADE_RANK[grade] >= GRADE_RANK.inaccuracy && !bookHinted) {
    const xs = best.placement.cells.map(([cx]) => cx);
    const lo = Math.min(...xs) + 1;
    const hi = Math.max(...xs) + 1;
    const spinNote = best.placement.spin === 'full' ? (best.placement.linesCleared >= 2 ? ' (TSD)' : ' (T-spin)') : '';
    const holdNote = best.usesHold ? ' after holding' : '';
    reasons.push(`Better: ${best.placement.type}${holdNote} on column${lo === hi ? '' : 's'} ${lo}${lo === hi ? '' : `–${hi}`}${spinNote}`);
  }

  // a clean verdict never carries scolding — when the final grade is
  // best/good, advisory negatives would contradict the chip; keep only
  // book context
  if (GRADE_RANK[grade] <= GRADE_RANK.good) {
    const kept = reasons.filter((r) => r.startsWith('Book'));
    reasons.length = 0;
    reasons.push(...kept);
  }

  const toAlt = (c: Candidate): AltInfo => ({
    piece: c.placement.type,
    rot: c.placement.rot,
    x: c.placement.x,
    y: c.placement.y,
    cells: c.placement.cells.map(([a, b]) => [a, b] as [number, number]),
    spin: c.placement.spin,
    linesCleared: c.placement.linesCleared,
    usesHold: c.usesHold,
    isBook: book.onBook && matchesBookMove(book, c.placement.type, c.placement.cells),
    total: c.total ?? 0,
    afterRows: Array.from(c.placement.after.rows),
    pv: (c.pv ?? []).map((p) => ({
      piece: p.type,
      cells: p.cells.map(([a, b]) => [a, b] as [number, number]),
      spin: p.spin,
      lines: p.linesCleared,
    })),
    isUser: c === userCand,
    path: c.placement.path,
  });

  const shown = pruned.slice(0, RETURN_TOP);
  if (userCand && !shown.includes(userCand)) shown.push(userCand);

  return {
    grade,
    gap,
    reasons,
    alts: shown.map(toAlt),
    userRank,
    pieceIndex: req.pieceIndex,
    elapsedMs: performance.now() - t0,
    book: book.onBook || tsdBook.onBook
      ? {
          onBook: true,
          sustainable: tsdBook.onBook ? tsdBook.sustainable : book.sustainable,
          userMatched: userOnBook,
          solutions: (tsdBook.onBook ? tsdBook : book).solutions.map(shortSolutionName),
        }
      : undefined,
  };
}
