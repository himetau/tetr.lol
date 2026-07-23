// Grade the placement the user just made against every alternative the
// engine can find, with lookahead over the real queue. Produces a grade,
// human-readable reasons, and the ranked alternative list for the paths view.

import { Board } from "../core/board";
import type { PieceType, Rot } from "../core/pieces";
import type { SpinKind } from "../core/spin";
import { enumeratePlacements, placementKey, type Placement } from "./enumerate";
import {
  evaluateBoard,
  clearReward,
  findTSlots,
  findLstSite,
  LST_SPIN_COL,
  lstHoles,
  isLstState,
  hasStartResidue,
  profileValley,
  type EvalBreakdown,
} from "./eval";
import {
  searchBestLine,
  LOOP_DEATH_TOLL,
  WASTED_T_TOLL,
  B2B_BREAK_TOLL,
  I_USE_TOLL,
  breaksB2b,
  type SearchOptions,
  DEFAULT_SEARCH,
} from "./search";
import { bookAdvice, matchesBookMove, OFF_BOOK } from "./book";

export type Grade = "best" | "good" | "inaccuracy" | "mistake" | "killer";

export interface GradeRequest {
  rows: number[]; // boardBefore
  queue: PieceType[]; // [activePiece, ...preview] at decision time
  hold: PieceType | null; // hold at decision time
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
  /** a verified solver run is driving this drill: it, not the cover book, is
   * the authority, so the cover book is silenced to stop it contradicting the
   * line the watch-book actually plays. */
  planActive?: boolean;
  /** the placement matched the verified plan (exact, or an orientation-lenient
   * fill of the same cycle) - graded best with no scolding. */
  userOnPlan?: boolean;
  /** the plan's move at this decision, for the "Better:" hint and to flag its
   * card in the paths view. */
  planMovePiece?: PieceType;
  planMoveCells?: [number, number][];
  /** the verified line's continuation from here (this decision's move first),
   * shown as the plan card's principal variation so the hovered path is the
   * engine's actual road to the next TSD, not a beam guess. */
  planPv?: { piece: PieceType; cells: [number, number][]; spin: SpinKind; lines: number }[];
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
  total: number; // immediate reward + lookahead score
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
  alts: AltInfo[]; // ranked best-first, includes the user's move
  userRank: number; // 0-based rank of the user's placement
  pieceIndex: number;
  elapsedMs: number;
  book?: BookInfo;
}

const PRUNE_TOP = 14;
const RETURN_TOP = 8;

interface Candidate {
  placement: Placement;
  usesHold: boolean;
  queueAfter: PieceType[]; // remaining queue for lookahead
  holdAfter: PieceType | null;
  immediateReward: number;
  immediateScore: number;
  breakdown: EvalBreakdown;
  total?: number;
  pv?: Placement[];
}

/** "flattop LST bag 2: D (66.7%) (mirrored)" -> "flattop LST bag 2: D" */
function shortSolutionName(label: string | undefined): string {
  return (label ?? "cover book").replace(/ \(mirrored\)$/, "").replace(/ \(\d+(\.\d+)?%.*?\)/, "");
}

/**
 * Enumerate every placement of the active piece and (via hold) the hold piece,
 * scored by immediate reward + board evaluation. Shared by `bestMove` and
 * `gradePlacement`.
 */
function collectCandidates(
  board: Board,
  active: PieceType,
  preview: PieceType[],
  hold: PieceType | null,
  bias: boolean,
  hadReadySlot: boolean,
): Candidate[] {
  const candidates: Candidate[] = [];

  const add = (
    piece: PieceType,
    usesHold: boolean,
    queueAfter: PieceType[],
    holdAfter: PieceType | null,
  ) => {
    for (const p of enumeratePlacements(board, piece)) {
      let immediateReward = clearReward(
        { linesCleared: p.linesCleared, spin: p.spin },
        p.type,
        bias,
      );

      // in LST every T is TSD fuel: spending it without a full spin is a
      // waste (worse still when the TSD was sitting there ready)
      if (piece === "T" && p.spin !== "full") {
        if (hadReadySlot) {
          immediateReward -= 320;
        } else if (bias) {
          immediateReward += WASTED_T_TOLL;
        }
      }

      // the goal never spends I pieces: prefer lines that park the I
      if (bias && piece === "I") {
        immediateReward += I_USE_TOLL;
      }

      // entering a loop-dead state is a permanent toll on the line
      if (bias && !findLstSite(p.after)) {
        immediateReward += LOOP_DEATH_TOLL;
      }

      // breaking back-to-back is a permanent toll too - a burn that tidies
      // the stack must not outrank the move that keeps the chain
      if (bias && breaksB2b(p.linesCleared, p.spin)) {
        immediateReward += B2B_BREAK_TOLL;
      }

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

  add(active, false, preview, hold);

  const holdPiece = hold ?? preview[0];
  if (holdPiece && holdPiece !== active) {
    add(holdPiece, true, hold ? preview : preview.slice(1), active);
  }

  return candidates;
}

/**
 * The engine's preferred placement for a position - the drill's "watch"
 * playback falls back to this when the book has nothing. Shallow search so
 * it is safe to run synchronously on the UI thread.
 */
export function bestMove(
  rows: number[],
  queue: PieceType[],
  hold: PieceType | null,
  lstBias: boolean,
  search: SearchOptions = { depth: 2, beamWidth: 8 },
): {
  piece: PieceType;
  cells: [number, number][];
  spin: SpinKind;
  linesCleared: number;
  usesHold: boolean;
} | null {
  const opts: SearchOptions = { ...search, lstBias };
  const board = new Board(Uint32Array.from(rows));
  const active = queue[0];
  if (!active) {
    return null;
  }
  const preview = queue.slice(1);
  const hadReadySlot = findTSlots(board).some((s) => s.clears2);

  const candidates = collectCandidates(board, active, preview, hold, lstBias, hadReadySlot);
  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => b.immediateScore - a.immediateScore);
  let best: Candidate | null = null;
  let bestTotal = -Infinity;
  for (const c of candidates.slice(0, 10)) {
    const total =
      c.immediateReward +
      searchBestLine(c.placement.after, c.queueAfter, 0, c.holdAfter, true, opts).score;
    if (total > bestTotal) {
      bestTotal = total;
      best = c;
    }
  }
  if (!best) {
    return null;
  }
  return {
    piece: best.placement.type,
    cells: best.placement.cells.map(([a, b]) => [a, b] as [number, number]),
    spin: best.placement.spin,
    linesCleared: best.placement.linesCleared,
    usesHold: best.usesHold,
  };
}

export function gradePlacement(
  req: GradeRequest,
  search: SearchOptions = DEFAULT_SEARCH,
): GradeResult {
  const t0 = performance.now();
  const bias = req.lstBias ?? false;
  const opts: SearchOptions = { ...search, lstBias: bias };
  const board = new Board(Uint32Array.from(req.rows));
  const active = req.queue[0];
  const preview = req.queue.slice(1);

  const hadReadySlot = findTSlots(board).some((s) => s.clears2);
  const userTsd = req.userPiece === "T" && req.userSpin === "full" && req.userLines >= 2;
  // When a verified run drives the drill it is the sole authority: silence the
  // cover book so it can't second-guess the line the watch-book plays.
  const planActive = req.planActive ?? false;
  const book = bias && !planActive ? bookAdvice(board, req.queue, req.hold) : OFF_BOOK;
  const userOnBookMove = book.onBook && matchesBookMove(book, req.userPiece, req.userCells);
  const planKey =
    planActive && req.planMovePiece && req.planMoveCells
      ? placementKey(req.planMovePiece, req.planMoveCells)
      : null;

  const candidates = collectCandidates(board, active, preview, req.hold, bias, hadReadySlot);

  // locate the user's move
  const userKey = placementKey(req.userPiece, req.userCells);
  let userCand = candidates.find(
    (c) =>
      c.usesHold === req.usedHold && placementKey(c.placement.type, c.placement.cells) === userKey,
  );
  // fallback: match by piece + cells only (hold bookkeeping edge cases)
  userCand ??= candidates.find(
    (c) => placementKey(c.placement.type, c.placement.cells) === userKey,
  );

  // the plan's move for this piece - the verified line's placement. It leads
  // the paths list so the top path is always what the engine plays here.
  const planCand =
    planKey !== null
      ? candidates.find((c) => placementKey(c.placement.type, c.placement.cells) === planKey)
      : null;

  // prune, always keeping the user's move (and the plan's)
  candidates.sort((a, b) => b.immediateScore - a.immediateScore);
  const pruned = candidates.slice(0, PRUNE_TOP);
  if (userCand && !pruned.includes(userCand)) {
    pruned.push(userCand);
  }
  if (planCand && !pruned.includes(planCand)) {
    pruned.push(planCand);
  }

  // Free-play grading only: nudge ranking + verdict toward the validated LST
  // laws the base eval is blind to - the 2-tall residue on cols 0/5 and a
  // single-mountain profile (no interior valley). Skipped when a verified plan
  // drives the drill (the plan is the authority there). Self-correcting: when
  // every candidate breaks the residue (opener / double-up rebuild) the toll is
  // uniform and does not distort the ranking; a residue-preserving move only
  // outranks when one actually exists.
  const RESIDUE_TOLL = 180;
  const VALLEY_TOLL = 120;
  const structuralToll = (after: Board): number => {
    if (!bias || planActive) return 0;
    let t = 0;
    if (!hasStartResidue(after)) t += RESIDUE_TOLL;
    const v = profileValley(after);
    if (v >= 2) t += VALLEY_TOLL * (v - 1);
    return t;
  };

  for (const c of pruned) {
    const line = searchBestLine(c.placement.after, c.queueAfter, 0, c.holdAfter, true, opts);
    c.total = c.immediateReward + line.score - structuralToll(c.placement.after);
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
  if (userCand) {
    verify.add(userCand);
  }
  if (planCand) {
    verify.add(planCand);
  }
  if (verify.size > 1) {
    const deeper: SearchOptions = { ...opts, depth: opts.depth + 2, beamWidth: opts.beamWidth + 4 };
    for (const c of verify) {
      const line = searchBestLine(c.placement.after, c.queueAfter, 0, c.holdAfter, true, deeper);
      c.total = c.immediateReward + line.score - structuralToll(c.placement.after);
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
  if (!userCand) {
    grade = "mistake";
  } else if (gap <= 1) {
    grade = "best";
  } else if (gap <= 100) {
    grade = "good";
  } else if (gap <= 240) {
    grade = "inaccuracy";
  } else if (gap <= 520) {
    grade = "mistake";
  } else {
    grade = "killer";
  }

  const GRADE_RANK: Record<Grade, number> = {
    best: 0,
    good: 1,
    inaccuracy: 2,
    mistake: 3,
    killer: 4,
  };
  const atLeast = (g: Grade) => {
    if (GRADE_RANK[grade] < GRADE_RANK[g]) {
      grade = g;
    }
  };

  // ---- reasons + structural grade floors ----
  // The gap alone can look small right after a clear (everything recovers in
  // the lookahead), so structural violations force a minimum severity: they
  // are what "wrong feedback" feels like when they slip through as "Good".
  const reasons: string[] = [];
  if (userCand && best && userCand !== best) {
    const u = userCand.breakdown;
    const b = best.breakdown;

    // in LST mode only deep burials floor the grade - shallow depth-1
    // overhangs are how the book builds the next spin space
    const newHoles = u.holes - b.holes;
    const newDeep = u.deepHoles - b.deepHoles;
    if (bias) {
      if (newDeep >= 1) {
        reasons.push(
          newDeep === 1
            ? "Buried a cell deep in the stack"
            : `Buried ${newDeep} cells deep in the stack`,
        );
        atLeast(newDeep >= 2 ? "killer" : "mistake");
      } else if (newHoles >= 2) {
        reasons.push(`Created ${newHoles} covered cells`);
        atLeast("inaccuracy");
      }
    } else if (newHoles >= 1) {
      reasons.push(
        newHoles === 1 ? "Created a hole in the stack" : `Created ${newHoles} holes in the stack`,
      );
      atLeast(newHoles >= 2 ? "killer" : "mistake");
    }
    // spending the slot on a full TSD is not "destroying" it
    if (u.tslots < b.tslots && !userTsd) {
      const boardHadSlot = findTSlots(board).length > 0;
      reasons.push(
        boardHadSlot ? "Destroyed your T-spin slot" : "Gave up the T-spin slot the best move keeps",
      );
      atLeast("inaccuracy");
    }
    // (spin-column check happens below, outside this block - it must fire
    // even when the engine ranked the user's move #1)
    if (req.userPiece === "T" && req.userSpin !== "full" && hadReadySlot) {
      reasons.push("Wasted the T piece - a full T-spin was available");
      atLeast("mistake");
    } else if (
      req.userPiece === "T" &&
      req.userSpin !== "full" &&
      best.placement.type === "T" &&
      best.placement.spin === "full"
    ) {
      reasons.push("Wasted the T piece - a full T-spin was available");
      atLeast("inaccuracy");
    }
    if (u.badOverhangs > b.badOverhangs) {
      reasons.push("Left an overhang that is not a T-spin roof");
    }
    if (u.bumpiness > b.bumpiness + 3) {
      reasons.push("Made the surface much bumpier than needed");
    }
    if (u.maxHeight > b.maxHeight + 2) {
      reasons.push("Stacked higher than necessary");
    }
  }
  if (!userCand) {
    reasons.push("Unexpected placement - engine could not match it");
  }

  // LST loop-viability check: absolute, against the pre-placement board and
  // independent of ranking - even a #1-ranked move that kills the loop is a
  // canon violation. "Killed" = there was a buildable col-2 TSD site before
  // this placement and there is none after it. When the cover book proves the
  // visible queue cannot sustain the loop anyway, losing it is not the
  // player's fault - inform, don't punish.
  // a stage-finishing TSD is not in the build books (their T placements are
  // implied); it is canon when the cleared result is itself a book state -
  // the col-2 heuristic otherwise mis-grades mirrored loops here
  const tsdBook =
    bias &&
    !planActive &&
    !userOnBookMove &&
    userCand &&
    req.userPiece === "T" &&
    req.userSpin === "full" &&
    req.userLines >= 2
      ? bookAdvice(userCand.placement.after, userCand.queueAfter, userCand.holdAfter)
      : OFF_BOOK;
  const userOnBook = userOnBookMove || tsdBook.onBook;
  const bookSaysForced = book.onBook && !book.sustainable;
  if (bias && userCand && !userOnBook) {
    const siteBefore = findLstSite(board);
    const siteAfter = findLstSite(userCand.placement.after);
    if (siteBefore && !siteAfter) {
      const pluggedCol =
        userCand.placement.cells.some(([cx]) => cx === LST_SPIN_COL) &&
        userCand.placement.after.columnHeight(LST_SPIN_COL) > 0;
      reasons.unshift(
        pluggedCol
          ? "Plugged the LST spin column (3rd column) - the loop is dead"
          : "Killed the LST loop - the next TSD can no longer be built",
      );
      if (!bookSaysForced) {
        // if any decent alternative kept the loop alive, this was avoidable
        const avoidable = pruned.some(
          (c) => c !== userCand && findLstSite(c.placement.after) !== null,
        );
        atLeast(avoidable ? "killer" : "mistake");
      }
    } else if (!userTsd && siteBefore && siteAfter && siteAfter.missing > siteBefore.missing + 4) {
      // right after a TSD the next site always starts from scratch - only
      // non-TSD moves can genuinely "move away" from it
      reasons.push("Moved away from the next TSD - extra cells now needed to rebuild");
      atLeast("inaccuracy");
    }
  }

  // LST residue + profile canon (free play only). Both are avoidability-gated:
  // a residue drop or a valley is only the player's fault when a shown
  // alternative avoided it - during an opener / double-up rebuild every move
  // legitimately drops the residue, and those must not be punished.
  if (bias && !planActive && !userOnBook && userCand && best && userCand !== best) {
    if (!hasStartResidue(userCand.placement.after) && hasStartResidue(best.placement.after)) {
      const avoidable = pruned.some(
        (c) => c !== userCand && hasStartResidue(c.placement.after),
      );
      if (avoidable) {
        reasons.push("Left the LST residue broken - rebuild the 2-tall base on the 1st/5th columns");
        atLeast("mistake");
      }
    }
    const userValley = profileValley(userCand.placement.after);
    if (userValley >= 2 && userValley > profileValley(best.placement.after)) {
      reasons.push("Split the stack into two mountains - keep one contiguous slope");
      atLeast("inaccuracy");
    }
    // The measured death signature: an L/J piece dropped as an overhang while
    // the residue is broken - papering over a deficit instead of rebuilding it.
    // Only flag when a shown alternative actually rebuilt the residue.
    if (
      (req.userPiece === "L" || req.userPiece === "J") &&
      !hasStartResidue(board) &&
      !hasStartResidue(userCand.placement.after) &&
      userCand.placement.cells.some(([x, y]) => y > 0 && !userCand.placement.after.filled(x, y - 1)) &&
      pruned.some((c) => c !== userCand && hasStartResidue(c.placement.after))
    ) {
      reasons.push("Masked the broken residue with an L/J overhang - rebuild the base instead");
      atLeast("mistake");
    }
  }

  // Back-to-back is canon: a plain burn breaks the chain. Only when the
  // loop is genuinely lost anyway (book proves the queue cannot sustain it,
  // it was already dead, or every alternative also burns/dies) is burning
  // the correct recovery play - then it is not flagged at all.
  if (userCand && breaksB2b(req.userLines, req.userSpin)) {
    if (!bias) {
      if (best && best !== userCand) {
        reasons.push(
          `Burned ${req.userLines} line${req.userLines > 1 ? "s" : ""} without a T-spin`,
        );
        atLeast("inaccuracy");
      }
    } else if (findLstSite(board) && !bookSaysForced) {
      const avoidable = pruned.some(
        (c) =>
          c !== userCand &&
          !breaksB2b(c.placement.linesCleared, c.placement.spin) &&
          findLstSite(c.placement.after) !== null,
      );
      if (avoidable) {
        reasons.unshift(
          `Broke back-to-back - burned ${req.userLines} line${req.userLines > 1 ? "s" : ""} without a spin`,
        );
        atLeast("mistake");
      }
    }
  }

  // A quad keeps B2B but is off the 20-TSD plan: the I belongs in hold or
  // placed as neutral filler, never spent on a clear.
  if (bias && userCand && req.userPiece === "I" && req.userLines === 4) {
    reasons.push("Quad - off the LST plan: every clear should be a T-spin, keep the I as filler");
    atLeast("inaccuracy");
  }

  // A TSS keeps B2B too, but it spends the T for half the payoff - the
  // 20-TSD goal counts it as a wasted T.
  if (bias && userCand && req.userPiece === "T" && req.userSpin === "full" && req.userLines === 1) {
    reasons.push("TSS - spent the T for one line; the goal takes full TSDs only");
    atLeast("inaccuracy");
  }

  // a full TSD that leaves the loop alive is the loop doing exactly what it
  // is for - whatever the lookahead gap says, never flag it as bad play
  if (
    bias &&
    userTsd &&
    userCand &&
    findLstSite(userCand.placement.after) &&
    GRADE_RANK[grade] > GRADE_RANK.good
  ) {
    grade = "good";
  }

  // ---- cover-book verdicts (canon beats the heuristic in both directions) ----
  if (tsdBook.onBook && userCand) {
    grade = "best";
    reasons.length = 0;
    reasons.push(`Book TSD - into ${shortSolutionName(tsdBook.solutions[0])}`);
  } else if (book.onBook && userCand) {
    if (userOnBook) {
      // canon move: whatever the heuristic thought, this is the book line
      grade = "best";
      reasons.length = 0;
      reasons.push(`Book move - ${shortSolutionName(book.solutions[0])}`);
    } else if (bookSaysForced) {
      reasons.push(
        "Book: no continuation covers this queue - the loop cannot be sustained this bag",
      );
    } else if (book.moves.length > 0) {
      const m = book.moves.find((mv) => !mv.usesHold) ?? book.moves[0];
      const xs = m.cells.map(([cx]) => cx);
      const lo = Math.min(...xs) + 1;
      const hi = Math.max(...xs) + 1;
      reasons.push(
        `Book keeps the loop: ${m.piece}${m.usesHold ? " after holding" : ""} on column${lo === hi ? "" : "s"} ${lo}${lo === hi ? "" : `–${hi}`}`,
      );
      // a loop-keeping TSD off the book is a different valid line
      if (!userTsd) {
        atLeast("inaccuracy");
      }
    } else if (book.holdIsBook) {
      reasons.push(`Book: hold the ${req.userPiece} - it is needed later in this build`);
      if (!userTsd) {
        atLeast("inaccuracy");
      }
    }
  }

  // concrete improvement hint: name the engine's preferred move (unless the
  // book already named its own - two competing suggestions is how the old
  // engine talked the player out of the loop)
  const bookHinted = book.onBook && !userOnBook && (book.moves.length > 0 || book.holdIsBook);
  if (
    userCand &&
    best &&
    best !== userCand &&
    GRADE_RANK[grade] >= GRADE_RANK.inaccuracy &&
    !bookHinted
  ) {
    // With a verified plan loaded the hint names what the plan plays here, not
    // the beam's pick - so the tip always points back to the watch-book line.
    const hintPiece = planActive && req.planMoveCells ? req.planMovePiece! : best.placement.type;
    const hintCells = planActive && req.planMoveCells ? req.planMoveCells : best.placement.cells;
    const hintSpin = planActive && req.planMoveCells ? "none" : best.placement.spin;
    const hintLines = planActive && req.planMoveCells ? 0 : best.placement.linesCleared;
    const hintHold = planActive && req.planMoveCells ? false : best.usesHold;
    const xs = hintCells.map(([cx]) => cx);
    const lo = Math.min(...xs) + 1;
    const hi = Math.max(...xs) + 1;
    const spinNote = hintSpin === "full" ? (hintLines >= 2 ? " (TSD)" : " (T-spin)") : "";
    const holdNote = hintHold ? " after holding" : "";
    reasons.push(
      `${planActive ? "Book plays" : "Better:"} ${hintPiece}${holdNote} on column${lo === hi ? "" : "s"} ${lo}${lo === hi ? "" : `–${hi}`}${spinNote}`,
    );
  }

  // a clean verdict never carries scolding - when the final grade is
  // best/good, advisory negatives would contradict the chip; keep only
  // book context
  if (GRADE_RANK[grade] <= GRADE_RANK.good) {
    const kept = reasons.filter((r) => r.startsWith("Book"));
    reasons.length = 0;
    reasons.push(...kept);
  }

  // The verified run overrides the heuristic in both directions: the watch-book
  // plays this exact line, so a move on it is best and carries no scolding.
  if (planActive && req.userOnPlan && userCand) {
    grade = "best";
    reasons.length = 0;
    reasons.push("On the verified line");
  }

  // Health-based grading for alternative paths: an LST run has many valid lines,
  // not one. A move OFF the verified line that still keeps a clean, continuable
  // LST state - no buried cell, the loop still buildable (a live TSD site, a
  // valid double-up shape, or a loop clear that resets it), the T not wasted,
  // back-to-back intact - is a legitimate alternative, NOT a mistake. So it gets
  // floored to at least "good" (a loop clear to "best"), and the "you should
  // have played X" nagging is dropped - only genuine structural damage
  // (holes, killed well, wasted T) is still scolded, above, on unhealthy moves.
  if (bias && userCand && !req.userOnPlan) {
    const after = userCand.placement.after;
    const loopClear =
      (req.userSpin === "full" && req.userLines >= 2) || req.userLines === 4;
    const wastedT = req.userPiece === "T" && !(req.userSpin === "full" && req.userLines >= 2);
    const wastedI = req.userPiece === "I" && req.userLines > 0 && req.userLines < 4;
    const healthy =
      !wastedT &&
      !wastedI &&
      !breaksB2b(req.userLines, req.userSpin) &&
      lstHoles(after) <= lstHoles(board) &&
      // loop stays alive: a clear resets it, else a live col-2 TSD site, else a
      // valid double-up shape with the spin column (col 2) still open - never a
      // shape that only "works" by treating some other column as the well.
      (loopClear ||
        findLstSite(after) !== null ||
        (after.columnHeight(LST_SPIN_COL) === 0 && isLstState(after)));
    if (healthy) {
      if (loopClear) {
        grade = "best";
      } else if (GRADE_RANK[grade] > GRADE_RANK.good) {
        grade = "good";
      }
      // keep genuine book context; drop the alternative-nagging hints
      const kept = reasons.filter((r) => r.startsWith("Book") && !r.startsWith("Book plays"));
      reasons.length = 0;
      reasons.push(...kept);
      if (reasons.length === 0) {
        reasons.push(
          req.userSpin === "full" && req.userLines >= 2
            ? "TSD on a valid alternative line - the loop stays alive"
            : req.userLines === 4
              ? "Quad - drains the well, the LST loop stays healthy"
              : "Valid alternative - clean stack, the next TSD is still buildable",
        );
      }
    }
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
    isBook:
      (book.onBook && matchesBookMove(book, c.placement.type, c.placement.cells)) ||
      (planKey !== null && placementKey(c.placement.type, c.placement.cells) === planKey),
    total: c.total ?? 0,
    afterRows: Array.from(c.placement.after.rows),
    // the plan card shows the verified continuation (the road to the next
    // TSD), not the beam's lookahead - so the hovered path is the engine's
    pv:
      c === planCand && req.planPv
        ? req.planPv.map((p) => ({
            piece: p.piece,
            cells: p.cells.map(([a, b]) => [a, b] as [number, number]),
            spin: p.spin,
            lines: p.lines,
          }))
        : (c.pv ?? []).map((p) => ({
            piece: p.type,
            cells: p.cells.map(([a, b]) => [a, b] as [number, number]),
            spin: p.spin,
            lines: p.linesCleared,
          })),
    isUser: c === userCand,
    path: c.placement.path,
  });

  const shown = pruned.slice(0, RETURN_TOP);
  if (userCand && !shown.includes(userCand)) {
    shown.push(userCand);
  }
  if (planCand && !shown.includes(planCand)) {
    shown.push(planCand);
  }
  // the engine's move leads the list: the #1 path is always what the verified
  // run plays here, whatever the beam's own ranking said
  const ordered = planCand ? [planCand, ...shown.filter((c) => c !== planCand)] : shown;
  // report the rank as shown (the plan lead may have shifted the user's card)
  const shownUserRank = userCand ? ordered.indexOf(userCand) : ordered.length;

  return {
    grade,
    gap,
    reasons,
    alts: ordered.map(toAlt),
    userRank: shownUserRank >= 0 ? shownUserRank : userRank,
    pieceIndex: req.pieceIndex,
    elapsedMs: performance.now() - t0,
    book:
      book.onBook || tsdBook.onBook
        ? {
            onBook: true,
            sustainable: tsdBook.onBook ? tsdBook.sustainable : book.sustainable,
            userMatched: userOnBook,
            solutions: (tsdBook.onBook ? tsdBook : book).solutions.map(shortSolutionName),
          }
        : undefined,
  };
}
