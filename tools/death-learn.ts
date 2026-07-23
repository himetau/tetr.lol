// Death-learning diagnostic. Drives the reactive LST loop player (lstLoopMove,
// the fallback the live drill uses off-plan) from a healthy LST state until it
// dies, then uses the SOLVER ORACLE (the Rust/wasm port, fast enough to run
// many times per death) to back-trace to the EXACT move that flipped the
// position from "clean K-cycle continuation exists" to "none" -- that move is
// the mistake. It then classifies which LST law the move broke (residue,
// single-mountain profile, well volume, stack-side parity, the col-2 site, a
// buried hole, an O in the notch) by comparing the player's move to the move
// the solver would have played, and appends the lesson to a growing dataset
// (tools/data/lst-lessons.json) so decision-making signal accumulates run over
// run. This is the coach's differential diagnosis: the primitive only NAMES a
// verdict the solver already reached.
//
//   npx tsx tools/death-learn.ts [seeds] [K] [horizon]
//
// Small by default (no big CPU); each death costs ~log2(moves) oracle solves.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Board, BOARD_W } from "../src/core/board";
import type { PieceType } from "../src/core/pieces";
import { enumeratePlacements } from "../src/engine/enumerate";
import { lstLoopMove } from "../src/engine/lst-loop";
import {
  findLstSite,
  lstHoles,
  hasStartResidue,
  profileValley,
  stackSideImbalance,
  volumeGap,
  oFlanksWell,
  LST_SPIN_COL,
} from "../src/engine/eval";
import coverData from "../src/data/lst-cover.json";
import { initSync, solve as wasmSolve } from "../wasm/lst_solver.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
initSync({ module: readFileSync(join(root, "wasm/lst_solver_bg.wasm")) });

const SEEDS = Number(process.argv[2] ?? 6);
const K = Number(process.argv[3] ?? 3); // oracle horizon: "can the loop continue K clean TSDs"
const HORIZON = Number(process.argv[4] ?? 7); // reactive beam depth (matches the live fallback)
const ORACLE_BUDGET = 2000;

// ---- deterministic 7-bag queue ----
const PIECES: PieceType[] = ["I", "O", "T", "S", "Z", "J", "L"];
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function bag(rng: () => number): PieceType[] {
  const b = [...PIECES];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}
function startBoard(): Board {
  const g = coverData.groups.find((x) => x.name === "flattop LST bag 2")!;
  return Board.fromStrings(g.start.map((r) => r.replace(/[^X]/g, ".")));
}
const cellKey = (cs: readonly (readonly [number, number])[]) =>
  cs.map(([x, y]) => x * 32 + y).sort((a, b) => a - b).join(",");
const cols = (cs: readonly (readonly [number, number])[]) =>
  [...new Set(cs.map(([x]) => x))].sort((a, b) => a - b);

// ---- the solver oracle (wasm) ----
interface WMove {
  piece: string;
  cells: [number, number][];
  spin: string;
}
function oracle(board: Board, queue: PieceType[], hold: PieceType | null): { solved: boolean; first: WMove | null } {
  const out = wasmSolve(
    JSON.stringify({
      rows: Array.from(board.rows),
      queue,
      hold,
      target: K,
      opts: { budgetMs: ORACLE_BUDGET, nodeBudget: 50_000_000, tailFree: 3, allowQuad: false },
    }),
  );
  const res = JSON.parse(out) as { solved: boolean; moves: WMove[] } | null;
  if (!res) return { solved: false, first: null };
  return { solved: res.solved, first: res.moves.length ? res.moves[0] : null };
}

// ---- reactive play, recording the full trajectory ----
interface Step {
  board: Board;
  qi: number;
  hold: PieceType | null;
  tsds: number;
}
interface PlayerMove {
  piece: PieceType;
  cells: [number, number][];
  spin: string;
}
function playToDeath(seed: number): { steps: Step[]; moves: PlayerMove[]; queue: PieceType[]; death: string } {
  const rng = mulberry32(seed);
  const Q: PieceType[] = [];
  while (Q.length < 700) Q.push(...bag(rng));
  let board = startBoard();
  let hold: PieceType | null = null;
  let qi = 0;
  let tsds = 0;
  const steps: Step[] = [{ board, qi, hold, tsds }];
  const moves: PlayerMove[] = [];
  let death = "survived cap";
  for (let step = 0; step < 250; step++) {
    const upcoming = Q.slice(qi, qi + 20);
    const mv = lstLoopMove(board, upcoming, hold, HORIZON, 24, false, false, false);
    if (!mv) {
      death = "stuck (no legal continuation)";
      break;
    }
    const placed = enumeratePlacements(board, mv.piece).find((p) => cellKey(p.cells) === cellKey(mv.cells));
    if (!placed) {
      death = "internal";
      break;
    }
    // advance (qi, hold) exactly as the game applies a hold/no-hold move
    if (!mv.usesHold) qi += 1;
    else if (hold !== null) {
      const nh = Q[qi];
      qi += 1;
      hold = nh;
    } else {
      hold = Q[qi];
      qi += 2;
    }
    board = placed.after;
    if (placed.type === "T" && placed.spin === "full" && placed.linesCleared >= 2) tsds++;
    moves.push({ piece: mv.piece, cells: mv.cells.map(([a, b]) => [a, b] as [number, number]), spin: placed.spin });
    steps.push({ board, qi, hold, tsds });
    if (board.maxHeight() >= 20) {
      death = "topout (overstack)";
      break;
    }
  }
  return { steps, moves, queue: Q, death };
}

/** Deepest self-inflicted 1-wide I-dependency (well excluded), mirrors the
 * solver's canyon term. */
function canyon(board: Board): number {
  const h: number[] = [];
  for (let x = 0; x < BOARD_W; x++) h.push(board.columnHeight(x));
  let worst = 0;
  for (let i = 0; i < BOARD_W; i++) {
    if (i === LST_SPIN_COL) continue;
    const l = i === 0 || i - 1 === LST_SPIN_COL ? 99 : h[i - 1];
    const r = i === BOARD_W - 1 || i + 1 === LST_SPIN_COL ? 99 : h[i + 1];
    worst = Math.max(worst, Math.min(l, r) - h[i]);
  }
  return worst;
}

// ---- classify the culprit: what LST law did the player's move break? ----
function diagnose(before: Board, afterP: Board, player: PlayerMove, solver: WMove) {
  const afterS = before.clone();
  afterS.place(solver.cells);
  afterS.clearLines();

  const siteP = findLstSite(afterP);
  const siteS = findLstSite(afterS);
  const holesBefore = lstHoles(before);
  const holesP = lstHoles(afterP);
  const resP = hasStartResidue(afterP);
  const resS = hasStartResidue(afterS);
  const valP = profileValley(afterP);
  const valS = profileValley(afterS);
  const ciP = stackSideImbalance(afterP);
  const ciS = stackSideImbalance(afterS);
  const volP = siteP ? volumeGap(afterP, siteP.y) : volumeGap(afterP, 0);
  const hP = afterP.maxHeight();
  const hS = afterS.maxHeight();
  const canP = canyon(afterP);
  const canS = canyon(afterS);
  const pCols = cols(player.cells);
  const sCols = cols(solver.cells);
  const playerFillSide = pCols.every((c) => c > LST_SPIN_COL + 1);
  const solverStructSide = sCols.some((c) => c <= LST_SPIN_COL + 1);

  let axis = "off-line placement";
  let detail = `played ${player.piece} at cols [${pCols}]; solver plays ${solver.piece} at cols [${sCols}]`;

  if (!siteP && siteS) {
    axis = "killed the col-2 TSD site";
    detail = `no col-2 site survives your ${player.piece}; the solver's ${solver.piece} keeps one alive`;
  } else if (holesP > holesBefore && lstHoles(afterS) <= holesBefore) {
    axis = "buried a cell (permanent hole)";
    detail = `your ${player.piece} left ${holesP - holesBefore} hole(s) outside the notch; solver's ${solver.piece} stays clean`;
  } else if (resS && !resP) {
    axis = "broke the cols-0&4 residue base";
    detail = `your ${player.piece} left the residue base broken; solver's ${solver.piece} preserves it`;
  } else if (valP - valS >= 2) {
    axis = "split the stack into two mountains";
    detail = `your ${player.piece} makes an interior valley of depth ${valP} (solver keeps ${valS})`;
  } else if (canP - canS >= 2) {
    axis = "dug a 1-wide canyon (I-dependency)";
    detail = `your ${player.piece} leaves a ${canP}-deep 1-wide well beside the fill (solver keeps ${canS})`;
  } else if (volP >= 2 && hP > hS) {
    axis = "overstacked the well (no double-up)";
    detail = `your ${player.piece} pushes the fill ${volP.toFixed(1)} over the well (h ${hP} vs solver ${hS})`;
  } else if (Math.abs(ciP) >= 2 && Math.abs(ciS) < 2) {
    axis = "shifted stack-side parity to ±2";
    detail = `your ${player.piece} drives stack-side CI to ${ciP} (solver keeps ${ciS})`;
  } else if (oFlanksWell(player.cells)) {
    axis = "spent an O beside the well (notch)";
    detail = `an O flanking the well rigidly flat-tops the spin flank; solver plays ${solver.piece} on the fill side`;
  } else if (playerFillSide && solverStructSide) {
    axis = "built the fill side, starved the well structure";
    detail = `you put ${player.piece} on the fill side (cols [${pCols}]) while the solver builds the well-side structure with ${solver.piece} (cols [${sCols}])`;
  }

  return {
    axis,
    detail,
    features: {
      residueP: resP,
      valleyP: valP,
      valleyS: valS,
      ciP,
      ciS,
      volGapP: Number(volP.toFixed(1)),
      holesDelta: holesP - holesBefore,
      heightP: hP,
      heightS: hS,
      siteLost: !siteP && !!siteS,
    },
  };
}

// ---- lesson store (accumulates across runs) ----
interface Lesson {
  seed: number;
  moveIndex: number;
  tsdsAtMistake: number;
  piece: PieceType;
  playerCols: number[];
  solverPiece: string;
  solverCols: number[];
  axis: string;
  detail: string;
  boardKey: string;
  features: Record<string, unknown>;
}
const STORE = join(root, "tools/data/lst-lessons.json");
function loadLessons(): Lesson[] {
  if (!existsSync(STORE)) return [];
  try {
    return (JSON.parse(readFileSync(STORE, "utf8")).lessons ?? []) as Lesson[];
  } catch {
    return [];
  }
}
function saveLessons(all: Lesson[]) {
  mkdirSync(dirname(STORE), { recursive: true });
  writeFileSync(STORE, JSON.stringify({ generatedAt: new Date().toISOString(), lessons: all }, null, 0));
}

// ---- main: play each seed, back-trace, diagnose, accumulate ----
const fresh: Lesson[] = [];
const results: { seed: number; tsds: number; death: string; verdict: string }[] = [];

for (let s = 0; s < SEEDS; s++) {
  const seed = 5000 + s;
  const { steps, moves, queue: Q, death } = playToDeath(seed);
  const finalTsds = steps[steps.length - 1].tsds;

  const cache = new Map<number, { solved: boolean; first: WMove | null }>();
  const solvable = (i: number) => {
    if (!cache.has(i)) {
      const st = steps[i];
      const q = Q.slice(st.qi, st.qi + K * 9 + 20);
      cache.set(i, oracle(st.board, q, st.hold));
    }
    return cache.get(i)!;
  };

  const N = steps.length;
  let verdict: string;
  if (!solvable(0).solved) {
    verdict = `start not ${K}-continuable (seed/queue limit, not a player mistake)`;
    results.push({ seed, tsds: finalTsds, death, verdict });
    console.log(`seed ${seed}: ${finalTsds} TSD, ${death} — ${verdict}`);
    continue;
  }
  let culprit: number;
  if (solvable(N - 1).solved) {
    // never lost K-continuability; a slow drift topped it out. Blame the last move.
    culprit = N - 2;
  } else {
    // binary search: largest index still solvable (monotonic: broken stays broken)
    let lo = 0,
      hi = N - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (solvable(mid).solved) lo = mid;
      else hi = mid - 1;
    }
    culprit = lo;
  }

  const before = steps[culprit].board;
  const afterP = steps[culprit + 1].board;
  const player = moves[culprit];
  const solverFirst = solvable(culprit).first;
  if (!player || !solverFirst) {
    verdict = "could not localize (no solver move at boundary)";
    results.push({ seed, tsds: finalTsds, death, verdict });
    console.log(`seed ${seed}: ${finalTsds} TSD, ${death} — ${verdict}`);
    continue;
  }
  const dx = diagnose(before, afterP, player, solverFirst);
  const lesson: Lesson = {
    seed,
    moveIndex: culprit,
    tsdsAtMistake: steps[culprit].tsds,
    piece: player.piece,
    playerCols: cols(player.cells),
    solverPiece: solverFirst.piece,
    solverCols: cols(solverFirst.cells),
    axis: dx.axis,
    detail: dx.detail,
    boardKey: before.key(),
    features: dx.features,
  };
  fresh.push(lesson);
  verdict = `MISTAKE @ move ${culprit} (after ${lesson.tsdsAtMistake} TSD): ${dx.axis}`;
  results.push({ seed, tsds: finalTsds, death, verdict });
  console.log(`seed ${seed}: ${finalTsds} TSD, ${death}`);
  console.log(`   ${verdict}`);
  console.log(`   ${dx.detail}`);
}

// ---- persist + aggregate the accumulated learning ----
const all = [...loadLessons(), ...fresh];
saveLessons(all);

console.log(`\n==== LESSONS (this run: ${fresh.length}, total accumulated: ${all.length}) ====`);
const byAxis = new Map<string, number>();
for (const l of all) byAxis.set(l.axis, (byAxis.get(l.axis) ?? 0) + 1);
for (const [a, n] of [...byAxis.entries()].sort((x, y) => y[1] - x[1])) {
  console.log(`  ${String(Math.round((100 * n) / all.length)).padStart(3)}%  ${a}  (${n})`);
}
const depths = fresh.map((l) => l.tsdsAtMistake).sort((a, b) => a - b);
if (depths.length)
  console.log(
    `  mistakes this run fired at TSD depth: min ${depths[0]}, median ${depths[depths.length >> 1]}, max ${depths[depths.length - 1]}`,
  );
console.log(`  dataset -> ${STORE.replace(root + "/", "")} (grows each run; the training signal for a learned ranker)`);
