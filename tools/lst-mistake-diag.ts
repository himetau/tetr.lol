// Rust(wasm)-solver-powered MISTAKE DIAGNOSTICIAN for the unpooled live loop.
//
// Drives the faithful unpooled drill loop (opener -> bounded solver windows ->
// play the plan -> re-solve), tracing every move. When the run dies, the death
// ("window returned no line") only names the SYMPTOM — the board was killed by
// some earlier committed move. This tool finds that move: it binary-searches
// backward over the recorded states using the Rust solver as an ORACLE ("does a
// clean deep continuation still exist here?") and pinpoints the last-good /
// first-dead boundary. The fatal move is then classified through every theory
// lens with piece + rotation + region attribution:
//   - parity destruction: stackSideImbalance leaving the good band (|SSI|>=2)
//   - LST shape break (isLstState), residue break (hasStartResidue)
//   - volume: volumeGap crossing the overstack line (>=2)
//   - region: cols 0-4 ("left", well+overhang, user's 1st-5th) vs cols 4-9
//     ("right", fill side, user's 5th-9th) vs spanning both
//   - window attribution: was the killer committed by a SOLVED window or the
//     tail of a PARTIAL one (the "play less of partial windows" lever)
// The same lenses run over every move (not just the fatal one) so recurring
// bad habits aggregate into a piece·rot·region table across seeds.
//
//   npx tsx tools/lst-mistake-diag.ts [nSeeds] [target]
//   env: SEEDBASE   seed stream base (default 987654321, matches lst-live-sim)
//        WINNODES   window solve node budget (default 1e6, deterministic)
//        ORACLENODES oracle node budget (default 2e6)
//        ORACLET    oracle continuation depth in TSDs (default 8)
//        SZFILL     szReserve for the live windows (default 150, live value)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Board } from "../src/core/board";
import { Game } from "../src/core/game";
import { planOpener } from "../src/engine/opener";
import { enumeratePlacements } from "../src/engine/enumerate";
import {
  findLstSite, volumeGap, stackSideImbalance, isLstState, hasStartResidue, lstHoles,
  quadWellDepth,
} from "../src/engine/eval";
import type { PieceType } from "../src/core/pieces";
import { initSync, solve } from "../wasm/lst_solver.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
initSync({ module: readFileSync(join(root, "wasm/lst_solver_bg.wasm")) });

const N = Number(process.argv[2] ?? 4);
const TARGET = Number(process.argv[3] ?? 20);
const WINDOW = 10;
const WINNODES = Number(process.env.WINNODES ?? 1_000_000);
const ORACLENODES = Number(process.env.ORACLENODES ?? 2_000_000);
const ORACLET = Number(process.env.ORACLET ?? 8);
const SZFILL = Number(process.env.SZFILL ?? 150);
const PHEALTH = Number(process.env.PHEALTH ?? 1) > 0; // matches live LST_WINDOW_PARTIAL_HEALTH
// Phase 1 targets the UNPOOLED QUAD loop, so the diagnostic is quad-aware by
// default: both the live windows AND the oracle allow well-quads, so the oracle
// judges the quad loop on the quad loop's own terms (a "clear" = TSD or quad).
const ALLOWQUAD = Number(process.env.QUAD ?? 1) > 0;

interface WasmMove {
  piece: string; cells: [number, number][]; spin: string;
  linesCleared: number; beforeKey: string; isTsd: boolean;
}
interface WasmResult { moves: WasmMove[]; tsds: number; solved: boolean; mirrored: boolean; nodes: number }

function wasmSolve(rows: number[], queue: PieceType[], hold: PieceType | null, target: number, opts: object): WasmResult | null {
  return JSON.parse(solve(JSON.stringify({ rows, queue, hold, target, opts }))) as WasmResult | null;
}

// Region split (swng's "1st-5th vs 5th-9th"): LEFT = cols 0-4 (the well col 2 +
// its overhang lid + outer wall), RIGHT = cols 5-9 (the flat fill side).
const LEFT_COLS = [0, 1, 2, 3, 4];
const RIGHT_COLS = [5, 6, 7, 8, 9];
// overhang-side cols exclude the (empty, deep) well col 2, so their average is a
// true lid height rather than one dragged toward 0 by the quad well.
const OVERHANG_COLS = [0, 1, 3, 4];

const avgH = (b: Board, cols: number[]) => cols.reduce((s, x) => s + b.columnHeight(x), 0) / cols.length;
const maxH = (b: Board, cols: number[]) => Math.max(...cols.map((x) => b.columnHeight(x)));
const bumpOf = (b: Board, cols: number[]) => {
  let s = 0;
  for (let i = 0; i < cols.length - 1; i++) s += Math.abs(b.columnHeight(cols[i]) - b.columnHeight(cols[i + 1]));
  return s;
};

interface Metrics {
  ssi: number; lst: boolean; res: boolean; gap: number;
  qwd: number;         // quad-well depth (rows a well I would clear; >=4 = quad ready)
  leftMax: number; rightMax: number;
  rightBump: number;   // fill-side jaggedness (the LST loop wants this flat)
  // recalibrated volume: fill-side avg minus overhang-lid avg. Scale-invariant,
  // so it stays meaningful on a tall rising quad loop where the old
  // volumeGap(b, site.y||0) read a spurious ~8-10 whenever no site existed.
  fillExcess: number;
}
function metrics(b: Board): Metrics {
  const site = findLstSite(b);
  return {
    ssi: stackSideImbalance(b),
    lst: isLstState(b),
    res: hasStartResidue(b),
    gap: volumeGap(b, site ? site.y : 0),
    qwd: quadWellDepth(b),
    leftMax: maxH(b, LEFT_COLS),
    rightMax: maxH(b, RIGHT_COLS),
    rightBump: bumpOf(b, RIGHT_COLS),
    fillExcess: avgH(b, RIGHT_COLS) - avgH(b, OVERHANG_COLS),
  };
}

interface Step {
  rowsBefore: Uint32Array;
  queueBefore: PieceType[];
  holdBefore: PieceType | null;
  tsdsBefore: number;
  piece: PieceType; cells: [number, number][]; spin: string;
  window: number; windowSolved: boolean; moveInWindow: number; windowLen: number;
  before: Metrics; after: Metrics;
}

interface RunTrace {
  seed: number; tsds: number; note: string; steps: Step[]; openerEnd: number;
  finalRows: Uint32Array; finalQueue: PieceType[]; finalHold: PieceType | null;
}

const snapQ = (game: Game) => [game.active!.type, ...game.peekQueue(ORACLET * 9 + 20)] as PieceType[];

/** Faithful unpooled loop (lst-live-sim), wasm-driven, with a full per-move trace. */
function run(seed: number): RunTrace | null {
  const game = new Game(seed);
  const plan = planOpener([game.active!.type, ...game.peekQueue(9)]);
  if (!plan) return null; // opener miss: nothing to diagnose
  const steps: Step[] = [];
  let tsds = 0;
  let m0 = metrics(game.board);

  const record = (mv: { piece: PieceType; cells: [number, number][]; spin: string }, win: number, winSolved: boolean, mi: number, wl: number): string | null => {
    const st: Step = {
      rowsBefore: game.board.rows.slice(), queueBefore: snapQ(game), holdBefore: game.hold,
      tsdsBefore: tsds, piece: mv.piece, cells: mv.cells, spin: mv.spin,
      window: win, windowSolved: winSolved, moveInWindow: mi, windowLen: wl,
      before: m0, after: m0,
    };
    const ev = game.applyMove(mv.piece, mv.cells, mv.spin as "none" | "mini" | "full");
    if (!ev) return "unreachable placement";
    // a "clear" is a full TSD or (in quad mode) a well-quad; tsds counts both so
    // it matches the solver's target semantics (res.tsds = total loop clears).
    if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) tsds++;
    else if (ALLOWQUAD && ev.linesCleared === 4) tsds++;
    st.after = m0 = metrics(game.board);
    steps.push(st); // push even on violation so the boundary search can blame this move
    // goal rules apply to window replay only — the opener legally builds transient covered voids
    if (win > 0) {
      if (ev.piece === "T" && !(ev.spin === "full" && ev.linesCleared >= 2)) return "wasted T";
      if (lstHoles(game.board) > 0) return "hole";
    }
    return null;
  };

  for (const mv of plan.moves) {
    const err = record({ piece: mv.piece, cells: mv.cells as [number, number][], spin: mv.spin }, 0, true, 0, plan.moves.length);
    if (err) return { seed, tsds, note: `opener ${err}`, steps, openerEnd: steps.length, finalRows: game.board.rows.slice(), finalQueue: snapQ(game), finalHold: game.hold };
  }
  const openerEnd = steps.length;

  let win = 0;
  let note = "reached target";
  while (tsds < TARGET) {
    const wTarget = Math.min(TARGET - tsds, WINDOW);
    const queue = [game.active!.type, ...game.peekQueue(wTarget * 9 + 20)] as PieceType[];
    const res = wasmSolve(Array.from(game.board.rows), queue, game.hold, wTarget, { nodeBudget: WINNODES, budgetMs: 60_000, szReserve: SZFILL, partialHealth: PHEALTH, allowQuad: ALLOWQUAD });
    win++;
    if (!res || res.moves.length === 0) { note = `window ${win} returned no line`; break; }
    let broke = "";
    for (let i = 0; i < res.moves.length && tsds < TARGET; i++) {
      const m = res.moves[i];
      if (game.board.key() !== m.beforeKey) { broke = "replay desync"; break; }
      const err = record({ piece: m.piece as PieceType, cells: m.cells, spin: m.spin }, win, res.solved, i, res.moves.length);
      if (err) { broke = err; break; }
    }
    if (broke) { note = broke; break; }
    if (game.board.maxHeight() >= 20) { note = "topped out"; break; }
  }
  return { seed, tsds, note, steps, openerEnd, finalRows: game.board.rows.slice(), finalQueue: snapQ(game), finalHold: game.hold };
}

// ---- oracle: does a clean ORACLET-deep continuation still exist from state j? ----

let oracleCalls = 0;
function oracleAt(t: RunTrace, j: number): WasmResult | null {
  const [rows, queue, hold, tsds] = j < t.steps.length
    ? [t.steps[j].rowsBefore, t.steps[j].queueBefore, t.steps[j].holdBefore, t.steps[j].tsdsBefore]
    : [t.finalRows, t.finalQueue, t.finalHold, t.tsds];
  const target = Math.min(TARGET - tsds, ORACLET);
  if (target <= 0) return null;
  oracleCalls++;
  const res = wasmSolve(Array.from(rows), queue, hold, target, { nodeBudget: ORACLENODES, budgetMs: 60_000, allowQuad: ALLOWQUAD });
  return res && res.solved ? res : null;
}

/** Largest j with oracle alive, given oracle(bad0) is dead: backoff + binary search. */
function findBoundary(t: RunTrace, bad0: number): { good: number; goodLine: WasmResult } | null {
  let bad = bad0;
  let good = -1;
  let goodLine: WasmResult | null = null;
  for (let back = 1; ; back *= 2) {
    const j = Math.max(t.openerEnd, bad0 - back);
    const r = oracleAt(t, j);
    if (r) { good = j; goodLine = r; break; }
    bad = Math.min(bad, j);
    if (j === t.openerEnd) return null; // dead on arrival post-opener
  }
  while (bad - good > 1) {
    const mid = (good + bad) >> 1;
    const r = oracleAt(t, mid);
    if (r) { good = mid; goodLine = r; } else bad = mid;
  }
  return { good, goodLine: goodLine! };
}

// ---- classification ----

const ROT = ["0", "R", "2", "L"];
const cellKey = (cs: readonly (readonly [number, number])[]) =>
  cs.map(([x, y]) => x * 32 + y).sort((a, b) => a - b).join(",");

function rotOf(rows: Uint32Array, piece: PieceType, cells: [number, number][]): string {
  const p = enumeratePlacements(new Board(rows.slice()), piece).find((q) => cellKey(q.cells) === cellKey(cells));
  return p ? ROT[p.rot] : "?";
}

function regionOf(cells: [number, number][]): string {
  const xs = cells.map(([x]) => x);
  if (Math.max(...xs) <= 4) return "left(1-5)";
  if (Math.min(...xs) >= 4) return "right(5-9)";
  return "span";
}

interface Lens { tag: string; detail: string }
function lenses(s: Step): Lens[] {
  const out: Lens[] = [];
  if (Math.abs(s.before.ssi) < 2 && Math.abs(s.after.ssi) >= 2)
    out.push({ tag: "parity-destroyed", detail: `SSI ${s.before.ssi}→${s.after.ssi}` });
  if (s.before.lst && !s.after.lst) out.push({ tag: "shape-broken", detail: "isLstState true→false" });
  if (s.before.res && !s.after.res) out.push({ tag: "residue-broken", detail: "start residue lost" });
  // recalibrated overstack: the fill side crossing ~2 rows above the overhang lid
  // is a real volume imbalance (double-up/quad overdue) - not the tall-board
  // artifact the old volumeGap(b, site.y||0) reported whenever no site existed.
  if (s.before.fillExcess < 2 && s.after.fillExcess >= 2)
    out.push({ tag: "fill-overstacked", detail: `fillExcess ${s.before.fillExcess.toFixed(1)}→${s.after.fillExcess.toFixed(1)}` });
  // fill-side jaggedness: the loop needs a flat right side for the next lid, so a
  // move that ratchets right-side bumpiness up is a fill-placement defect
  if (s.after.rightBump - s.before.rightBump >= 3)
    out.push({ tag: "fill-jagged", detail: `rightBump ${s.before.rightBump}→${s.after.rightBump}` });
  return out;
}

/** Build the board after a candidate placement (place + clear), for comparing
 * the engine's fatal move against the oracle's chosen alternative. */
function simAfter(rows: Uint32Array, cells: [number, number][]): Board {
  const b = new Board(rows.slice());
  b.place(cells);
  b.clearLines();
  return b;
}

/** THE key upgrade: name what actually differs between the engine's fatal move
 * and the oracle's survivor from the same board - region, builder spent, quad
 * progress, overhang handedness. Turns "no lens fired" into a concrete habit. */
function structuralDiff(rowsBefore: Uint32Array, engPiece: PieceType, engCells: [number, number][], alt: WasmMove): Lens[] {
  const out: Lens[] = [];
  const engReg = regionOf(engCells), altReg = regionOf(alt.cells);
  if (engReg !== altReg)
    out.push({ tag: `region-diff (oracle→${altReg})`, detail: `engine filled ${engReg}, oracle ${altReg}` });
  if (engPiece !== alt.piece)
    out.push({ tag: "builder-diff", detail: `engine spent ${engPiece}, oracle reserved it & spent ${alt.piece}` });
  const eq = quadWellDepth(simAfter(rowsBefore, engCells));
  const oq = quadWellDepth(simAfter(rowsBefore, alt.cells));
  if (eq < oq)
    out.push({ tag: "quad-progress-lost", detail: `well depth ${eq} vs oracle ${oq} (${eq - oq})` });
  // overhang handedness (memory: prefer flat L/J over the 2-high S/Z diagonal):
  // an S/Z laid into the well-side region builds the discouraged diagonal lid.
  const engDiag = (engPiece === "S" || engPiece === "Z") && engReg !== "right(5-9)";
  const altDiag = (alt.piece === "S" || alt.piece === "Z") && altReg !== "right(5-9)";
  if (engDiag && !altDiag)
    out.push({ tag: "diagonal-overhang", detail: `engine used the S/Z diagonal lid; oracle kept a flat lid` });
  return out;
}

function render(rows: Uint32Array, eng: [number, number][], alt: [number, number][] | null): string[] {
  const b = new Board(rows.slice());
  const ys = [...eng, ...(alt ?? [])].map(([, y]) => y);
  const h = Math.max(b.maxHeight(), Math.max(...ys) + 1);
  const ek = new Set(eng.map(([x, y]) => x * 32 + y));
  const ak = new Set((alt ?? []).map(([x, y]) => x * 32 + y));
  const lines: string[] = [];
  for (let y = h - 1; y >= 0; y--) {
    let line = "";
    for (let x = 0; x < 10; x++) {
      const k = x * 32 + y;
      line += ek.has(k) && ak.has(k) ? "*" : ek.has(k) ? "E" : ak.has(k) ? "o" : b.filled(x, y) ? "█" : "·";
    }
    lines.push(line);
  }
  return lines;
}

const winTag = (s: Step) =>
  s.window === 0 ? "opener" : `window ${s.window} ${s.windowSolved ? "SOLVED" : `PARTIAL (move ${s.moveInWindow + 1}/${s.windowLen})`}`;

// ---- main ----

const rng = (() => {
  let a = Number(process.env.SEEDBASE ?? 987654321);
  return () => ((a = (a * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
})();

console.log(`lst-mistake-diag: ${N} unpooled seeds, ${ALLOWQUAD ? "QUAD" : "TSD"} loop, target ${TARGET} clears, window nodes ${WINNODES}, oracle ${ORACLET}-clear @ ${ORACLENODES} nodes, szReserve ${SZFILL}\n`);

const fatalAgg = new Map<string, number>();
const habitAgg = new Map<string, number>();
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
let diagnosed = 0;
// periodicity (feeds Phase 2): fraction of a run's states that stayed in a
// canonical LST band (valid shape + stack-side parity in [-1,1]). High = the
// loop is converging to a repeatable state; low = it is drifting, the deep
// reason reactive play can't sustain.
let bandSum = 0, bandRuns = 0;

for (let i = 0, attempts = 0; i < N && attempts < N * 3; attempts++) {
  const seed = (rng() * 2 ** 31) | 0;
  const t0 = Date.now();
  const t = run(seed);
  if (!t) { console.log(`seed ${seed}: opener miss, skipped`); continue; }
  i++;

  // whole-run bad-habit lenses (every move, fatal or not)
  for (const s of t.steps) {
    for (const l of lenses(s)) bump(habitAgg, `${l.tag}  ${s.piece}·${rotOf(s.rowsBefore, s.piece, s.cells)}  ${regionOf(s.cells)}`);
  }

  // periodicity band residency for this run
  const inBand = t.steps.filter((s) => s.after.lst && Math.abs(s.after.ssi) < 2).length;
  const band = t.steps.length ? (100 * inBand) / t.steps.length : 0;
  bandSum += band; bandRuns++;

  if (t.tsds >= TARGET) {
    console.log(`seed ${seed}: reached ${t.tsds} clears — no mistake to find  (band ${band.toFixed(0)}%)  [${((Date.now() - t0) / 1000).toFixed(1)}s]`);
    continue;
  }

  console.log(`seed ${seed}: died @ ${t.tsds} clears — ${t.note} (${t.steps.length} moves, band ${band.toFixed(0)}%)`);
  oracleCalls = 0;
  const finalAlive = oracleAt(t, t.steps.length);
  if (finalAlive) {
    console.log(`  ⚠ final board is STILL oracle-alive (${finalAlive.tsds}-TSD line exists) — death is a WINDOW-BUDGET artifact, not a board mistake`);
    bump(fatalAgg, "window-budget-artifact (board still alive)");
    console.log(`  [${oracleCalls} oracle solves, ${((Date.now() - t0) / 1000).toFixed(1)}s]\n`);
    diagnosed++;
    continue;
  }
  const b = findBoundary(t, t.steps.length);
  if (!b) {
    console.log(`  board was already oracle-dead right after the opener — seed too hard for a ${ORACLET}-TSD continuation, no move to blame`);
    bump(fatalAgg, "dead-on-arrival post-opener");
    console.log(`  [${oracleCalls} oracle solves, ${((Date.now() - t0) / 1000).toFixed(1)}s]\n`);
    diagnosed++;
    continue;
  }

  const s = t.steps[b.good];
  const rot = rotOf(s.rowsBefore, s.piece, s.cells);
  const region = regionOf(s.cells);
  const ls = lenses(s);
  const alt = b.goodLine.moves[0];
  const diff = structuralDiff(s.rowsBefore, s.piece, s.cells, alt);
  // fatal lens = the state-transition lenses, else the engine-vs-oracle diff -
  // so the histogram names a concrete habit instead of a bare "planning".
  const fatal = [...ls, ...diff];
  const lensStr = fatal.length ? fatal.map((l) => `${l.tag} (${l.detail})`).join(" | ") : "no lens fired — planning/piece-balance mistake";
  console.log(`  FATAL move #${b.good + 1}/${t.steps.length} [${winTag(s)}]: ${s.piece}·${rot} ${s.spin !== "none" ? s.spin + " " : ""}at ${region}, cols ${Math.min(...s.cells.map(([x]) => x))}-${Math.max(...s.cells.map(([x]) => x))}`);
  console.log(`    lens: ${lensStr}`);
  console.log(`    state: SSI ${s.before.ssi}→${s.after.ssi}  lstState ${s.before.lst}→${s.after.lst}  residue ${s.before.res}→${s.after.res}  fillExcess ${s.before.fillExcess.toFixed(1)}→${s.after.fillExcess.toFixed(1)}  qwd ${s.before.qwd}→${s.after.qwd}  L/R max ${s.after.leftMax}/${s.after.rightMax}`);
  const altRot = rotOf(s.rowsBefore, alt.piece as PieceType, alt.cells);
  console.log(`    oracle keeps a clean ${b.goodLine.tsds}-clear line by playing instead: ${alt.piece}·${altRot} at ${regionOf(alt.cells)} (E = engine's fatal move, o = oracle's move)`);
  for (const line of render(s.rowsBefore, s.cells, alt.cells)) console.log(`      ${line}`);
  bump(fatalAgg, `${s.piece}·${rot} ${region}  ${fatal[0]?.tag ?? "planning"}  [${s.window === 0 ? "opener" : s.windowSolved ? "solved-window" : "partial-window"}]`);
  console.log(`  [${oracleCalls} oracle solves, ${((Date.now() - t0) / 1000).toFixed(1)}s]\n`);
  diagnosed++;
}

console.log(`\n=== periodicity: mean canonical-band residency ${bandRuns ? (bandSum / bandRuns).toFixed(0) : "0"}% over ${bandRuns} runs ===`);
console.log("  (high = loop converging to a repeatable LST state; low = drifting — Phase 2 signal)");
console.log(`\n=== fatal mistakes (oracle-verified board-killers) over ${diagnosed} deaths ===`);
for (const [k, v] of [...fatalAgg].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(2)}×  ${k}`);
console.log(`\n=== bad-habit lens events (every move, all runs) ===`);
for (const [k, v] of [...habitAgg].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(2)}×  ${k}`);
if (habitAgg.size === 0) console.log("  (none — every committed move kept parity/shape/residue/volume clean)");
