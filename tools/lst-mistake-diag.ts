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

interface WasmMove {
  piece: string; cells: [number, number][]; spin: string;
  linesCleared: number; beforeKey: string; isTsd: boolean;
}
interface WasmResult { moves: WasmMove[]; tsds: number; solved: boolean; mirrored: boolean; nodes: number }

function wasmSolve(rows: number[], queue: PieceType[], hold: PieceType | null, target: number, opts: object): WasmResult | null {
  return JSON.parse(solve(JSON.stringify({ rows, queue, hold, target, opts }))) as WasmResult | null;
}

interface Metrics { ssi: number; lst: boolean; res: boolean; gap: number }
function metrics(b: Board): Metrics {
  const site = findLstSite(b);
  return {
    ssi: stackSideImbalance(b),
    lst: isLstState(b),
    res: hasStartResidue(b),
    gap: volumeGap(b, site ? site.y : 0),
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
    if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) tsds++;
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
    const res = wasmSolve(Array.from(game.board.rows), queue, game.hold, wTarget, { nodeBudget: WINNODES, budgetMs: 60_000, szReserve: SZFILL, partialHealth: PHEALTH });
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
  const res = wasmSolve(Array.from(rows), queue, hold, target, { nodeBudget: ORACLENODES, budgetMs: 60_000 });
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
  if (s.before.gap < 2 && s.after.gap >= 2)
    out.push({ tag: "overstacked", detail: `volumeGap ${s.before.gap.toFixed(1)}→${s.after.gap.toFixed(1)}` });
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

console.log(`lst-mistake-diag: ${N} unpooled seeds, target ${TARGET}, window nodes ${WINNODES}, oracle ${ORACLET} TSD @ ${ORACLENODES} nodes, szReserve ${SZFILL}\n`);

const fatalAgg = new Map<string, number>();
const habitAgg = new Map<string, number>();
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
let diagnosed = 0;

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

  if (t.tsds >= TARGET) {
    console.log(`seed ${seed}: reached ${t.tsds} TSD — no mistake to find  [${((Date.now() - t0) / 1000).toFixed(1)}s]`);
    continue;
  }

  console.log(`seed ${seed}: died @ ${t.tsds} TSD — ${t.note} (${t.steps.length} moves)`);
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
  const lensStr = ls.length ? ls.map((l) => `${l.tag} (${l.detail})`).join(" | ") : "no lens fired — planning/piece-balance mistake";
  console.log(`  FATAL move #${b.good + 1}/${t.steps.length} [${winTag(s)}]: ${s.piece}·${rot} ${s.spin !== "none" ? s.spin + " " : ""}at ${region}, cols ${Math.min(...s.cells.map(([x]) => x))}-${Math.max(...s.cells.map(([x]) => x))}`);
  console.log(`    lens: ${lensStr}`);
  console.log(`    state: SSI ${s.before.ssi}→${s.after.ssi}  lstState ${s.before.lst}→${s.after.lst}  residue ${s.before.res}→${s.after.res}  volGap ${s.before.gap.toFixed(1)}→${s.after.gap.toFixed(1)}`);
  const alt = b.goodLine.moves[0];
  const altRot = rotOf(s.rowsBefore, alt.piece as PieceType, alt.cells);
  console.log(`    oracle keeps a clean ${b.goodLine.tsds}-TSD line by playing instead: ${alt.piece}·${altRot} at ${regionOf(alt.cells)} (E = engine's fatal move, o = oracle's move)`);
  for (const line of render(s.rowsBefore, s.cells, alt.cells)) console.log(`      ${line}`);
  bump(fatalAgg, `${s.piece}·${rot} ${region}  ${ls[0]?.tag ?? "planning"}  [${s.window === 0 ? "opener" : s.windowSolved ? "solved-window" : "partial-window"}]`);
  console.log(`  [${oracleCalls} oracle solves, ${((Date.now() - t0) / 1000).toFixed(1)}s]\n`);
  diagnosed++;
}

console.log(`\n=== fatal mistakes (oracle-verified board-killers) over ${diagnosed} deaths ===`);
for (const [k, v] of [...fatalAgg].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(2)}×  ${k}`);
console.log(`\n=== bad-habit lens events (every move, all runs) ===`);
for (const [k, v] of [...habitAgg].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(2)}×  ${k}`);
if (habitAgg.size === 0) console.log("  (none — every committed move kept parity/shape/residue/volume clean)");
