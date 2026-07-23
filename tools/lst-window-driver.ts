// A/B harness for UNPOOLED window-driver policies, wasm-Rust-solver powered.
//
// The mistake diagnostician (tools/lst-mistake-diag.ts) showed the unpooled
// loop's board-killers are moves committed blindly from window lines (both
// solved windows and partial-window tails), and that some "window returned no
// line" deaths are pure budget artifacts (the board was still alive). This
// harness implements and measures the fixes as DRIVER policies (no solver /
// parity risk, live-portable):
//
//   base    the current live loop: solve a window, commit the WHOLE line,
//           die the first time a window returns nothing (lst-live-sim).
//   verify  verified commit + escalation:
//           - after each window line, PROBE the end state with a cheap solver
//             continuation check ("does a clean PROBET-TSD line still exist?");
//             if dead, truncate the commit back to an earlier TSD boundary
//             that probes alive (bounded number of probes);
//           - when a window returns nothing, retry with escalating node
//             budgets (x4, x16; last retry drops szReserve) before dying.
//           In-sim truncation is done by replaying from the seed to the cut —
//           equivalent to the live design where the probe runs asynchronously
//           during early-plan playback and the tail is simply never played.
//
//   npx tsx tools/lst-window-driver.ts [nSeeds] [policy: base|verify|both]
//   env: SEEDBASE (default 987654321, matches lst-live-sim/mistake-diag)
//        WINNODES (1e6)  PROBENODES (6e5)  PROBET (4)  SZFILL (150)  TARGET (20)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Game } from "../src/core/game";
import { Board } from "../src/core/board";
import { planOpener } from "../src/engine/opener";
import { lstHoles } from "../src/engine/eval";
import { solveLstRun } from "../src/engine/lst-solver";
import type { PieceType } from "../src/core/pieces";
import { initSync, solve } from "../wasm/lst_solver.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
initSync({ module: readFileSync(join(root, "wasm/lst_solver_bg.wasm")) });

// SOLVER=ts uses the TS solveLstRun directly (so a not-yet-in-Rust option like
// LEFTO=leftOCapHorizon can be A/B'd WITHOUT a wasm rebuild); default wasm.
const SOLVER = process.env.SOLVER ?? "wasm";
const LEFTO = Number(process.env.LEFTO ?? 0); // leftOCapHorizon (TS path only)

const N = Number(process.argv[2] ?? 6);
const POLICY = (process.argv[3] ?? "both") as "base" | "verify" | "cascade" | "both";
const TARGET = Number(process.env.TARGET ?? 20);
const WINDOW = 10;
const WINNODES = Number(process.env.WINNODES ?? 1_000_000);
const PROBENODES = Number(process.env.PROBENODES ?? 800_000);
const PROBET = Number(process.env.PROBET ?? 6);
const SZFILL = Number(process.env.SZFILL ?? 150);
const PHEALTH = Number(process.env.PHEALTH ?? 0) > 0; // solver partialHealth exit tie-break
const MAX_PROBES_PER_WINDOW = 4;
const CASNODES = Number(process.env.CASNODES ?? 2_000_000); // cascade full-remaining solve nodes
const CHUNK = Number(process.env.CHUNK ?? 1); // cascade: TSD cycles committed from a partial line
// Phase 1 targets the UNPOOLED QUAD loop, so allow well-quads by default: a
// "clear" (loop cycle) is a full TSD or, in quad mode, an I-quad draining the well.
const ALLOWQUAD = Number(process.env.QUAD ?? 1) > 0;
const countsClear = (piece: string, spin: string, lines: number): boolean =>
  (piece === "T" && spin === "full" && lines >= 2) || (ALLOWQUAD && lines === 4);
const isClearMove = (m: WasmMove): boolean => m.isTsd || (ALLOWQUAD && m.linesCleared === 4);

interface WasmMove {
  piece: string; cells: [number, number][]; spin: string;
  linesCleared: number; beforeKey: string; isTsd: boolean;
}
interface WasmResult { moves: WasmMove[]; tsds: number; solved: boolean; mirrored: boolean; nodes: number }
type Mv = { piece: PieceType; cells: [number, number][]; spin: "none" | "mini" | "full" };

function wasmSolve(rows: number[], queue: PieceType[], hold: PieceType | null, target: number, opts: object): WasmResult | null {
  if (SOLVER === "ts") {
    const b = new Board();
    for (let i = 0; i < rows.length && i < b.rows.length; i++) b.rows[i] = rows[i];
    // TS SolvedMove already carries beforeKey/isTsd/linesCleared, so SolveResult
    // is drop-in for WasmResult; leftOCapHorizon is the TS-only rule under test.
    return solveLstRun(b, queue, hold, target, { ...opts, leftOCapHorizon: LEFTO }) as unknown as WasmResult | null;
  }
  return JSON.parse(solve(JSON.stringify({ rows, queue, hold, target, opts }))) as WasmResult | null;
}

interface Stats { windows: number; probes: number; truncations: number; escalations: number; rescues: number }
interface SeedResult { seed: number; tsds: number; note: string; stats: Stats; ms: number }

/** Replay `moves` through a fresh Game; returns null on any goal-rule break. */
function replay(seed: number, moves: Mv[]): { game: Game; tsds: number } | null {
  const game = new Game(seed);
  let tsds = 0;
  for (const m of moves) {
    const ev = game.applyMove(m.piece, m.cells, m.spin);
    if (!ev) return null;
    if (countsClear(ev.piece, ev.spin, ev.linesCleared)) tsds++;
  }
  return { game, tsds };
}

const solveHere = (game: Game, target: number, nodes: number, sz: number) =>
  wasmSolve(
    Array.from(game.board.rows),
    [game.active!.type, ...game.peekQueue(target * 9 + 20)] as PieceType[],
    game.hold, target, { nodeBudget: nodes, budgetMs: 120_000, szReserve: sz, partialHealth: PHEALTH, allowQuad: ALLOWQUAD },
  );

/** Cascade policy: solve FULL remaining each step; a solved line finishes the
 * run outright, a partial line commits only its first CHUNK TSD cycles (the
 * least possible poison) before re-solving from the new state. Every commit
 * is thereby either fully 20-verified or minimal — no probes needed. */
function driveCascade(seed: number): SeedResult {
  const t0 = Date.now();
  const stats: Stats = { windows: 0, probes: 0, truncations: 0, escalations: 0, rescues: 0 };
  const done = (tsds: number, note: string): SeedResult => ({ seed, tsds, note, stats, ms: Date.now() - t0 });

  const game = new Game(seed);
  const opener = planOpener([game.active!.type, ...game.peekQueue(9)]);
  if (!opener) return done(0, "opener miss");
  let tsds = 0;
  for (const m of opener.moves) {
    const ev = game.applyMove(m.piece, m.cells as [number, number][], m.spin);
    if (!ev) return done(0, "opener desync");
    if (countsClear(ev.piece, ev.spin, ev.linesCleared)) tsds++;
  }

  while (tsds < TARGET) {
    let res = solveHere(game, TARGET - tsds, CASNODES, SZFILL);
    stats.windows++;
    if (!res || res.moves.length === 0) {
      stats.escalations++;
      res = solveHere(game, TARGET - tsds, CASNODES * 4, SZFILL);
      if (res && res.moves.length > 0) stats.rescues++;
    }
    if (!res || res.moves.length === 0) return done(tsds, "no line (full remaining)");

    let toPlay = res.moves;
    if (!res.solved) {
      // partial: keep only the first CHUNK TSD cycles
      let cut = 0;
      let fired = 0;
      for (let i = 0; i < toPlay.length; i++) {
        if (isClearMove(toPlay[i])) {
          fired++;
          if (fired >= CHUNK) { cut = i + 1; break; }
        }
      }
      if (fired === 0) return done(tsds, "partial line fires no clear");
      toPlay = toPlay.slice(0, cut || toPlay.length);
      stats.truncations++;
    }
    for (const m of toPlay) {
      if (game.board.key() !== m.beforeKey) return done(tsds, "replay desync");
      const ev = game.applyMove(m.piece as PieceType, m.cells, m.spin as Mv["spin"]);
      if (!ev) return done(tsds, "unreachable placement");
      if (ev.piece === "T" && !(ev.spin === "full" && ev.linesCleared >= 2)) return done(tsds, "wasted T");
      if (lstHoles(game.board) > 0) return done(tsds, "hole");
      if (countsClear(ev.piece, ev.spin, ev.linesCleared)) tsds++;
      if (tsds >= TARGET) break;
    }
    if (game.board.maxHeight() >= 20) return done(tsds, "topped out");
  }
  return done(tsds, "reached target");
}

function drive(seed: number, policy: "base" | "verify"): SeedResult {
  const t0 = Date.now();
  const stats: Stats = { windows: 0, probes: 0, truncations: 0, escalations: 0, rescues: 0 };
  const done = (tsds: number, note: string): SeedResult => ({ seed, tsds, note, stats, ms: Date.now() - t0 });

  let game = new Game(seed);
  const opener = planOpener([game.active!.type, ...game.peekQueue(9)]);
  if (!opener) return done(0, "opener miss");
  const committed: Mv[] = opener.moves.map((m) => ({ piece: m.piece, cells: m.cells as [number, number][], spin: m.spin }));
  let tsds = 0;
  for (const m of committed) {
    const ev = game.applyMove(m.piece, m.cells, m.spin);
    if (!ev) return done(0, "opener desync");
    if (countsClear(ev.piece, ev.spin, ev.linesCleared)) tsds++;
  }

  const probeAlive = (g: Game, tsdsNow: number, doubleCheck = false): boolean => {
    const t = Math.min(TARGET - tsdsNow, PROBET);
    if (t <= 0) return true;
    stats.probes++;
    const r = solveHere(g, t, PROBENODES, SZFILL);
    if (r && r.solved) return true;
    if (!doubleCheck) return false;
    // a false "dead" verdict forces an expensive retreat, so confirm at x4
    stats.probes++;
    const r2 = solveHere(g, t, PROBENODES * 4, SZFILL);
    return !!r2 && r2.solved;
  };

  while (tsds < TARGET) {
    const wTarget = Math.min(TARGET - tsds, WINDOW);
    let res = solveHere(game, wTarget, WINNODES, SZFILL);
    stats.windows++;
    if ((!res || res.moves.length === 0) && policy === "verify") {
      // escalation ladder: the diag proved some no-line deaths are budget artifacts
      for (const [mult, sz] of [[4, SZFILL], [16, SZFILL], [16, 0]] as const) {
        stats.escalations++;
        res = solveHere(game, wTarget, WINNODES * mult, sz);
        if (res && res.moves.length > 0) { stats.rescues++; break; }
      }
    }
    if (!res || res.moves.length === 0) return done(tsds, "window returned no line");

    // play the line, snapshotting cut points (move counts) at each TSD boundary
    const cuts: { nMoves: number; tsds: number }[] = [];
    let played = 0;
    let broke = "";
    for (const m of res.moves) {
      if (game.board.key() !== m.beforeKey) { broke = "replay desync"; break; }
      const ev = game.applyMove(m.piece as PieceType, m.cells, m.spin as Mv["spin"]);
      if (!ev) { broke = "unreachable placement"; break; }
      committed.push({ piece: m.piece as PieceType, cells: m.cells, spin: m.spin as Mv["spin"] });
      played++;
      if (ev.piece === "T" && !(ev.spin === "full" && ev.linesCleared >= 2)) { broke = "wasted T"; break; }
      if (lstHoles(game.board) > 0) { broke = "hole"; break; }
      if (countsClear(ev.piece, ev.spin, ev.linesCleared)) {
        tsds++;
        cuts.push({ nMoves: committed.length, tsds });
      }
      if (tsds >= TARGET) break;
    }
    if (broke) return done(tsds, broke);
    if (played === 0) return done(tsds, "window made no progress");
    if (tsds >= TARGET) break;

    if (policy === "verify") {
      // verified commit: end state must probe alive, else fall back to the
      // latest TSD-boundary cut that does (replaying from seed to the cut)
      if (!probeAlive(game, tsds, true)) {
        let rescued = false;
        const candidates = cuts.slice(0, -1).reverse().slice(0, MAX_PROBES_PER_WINDOW - 1);
        for (const cut of candidates) {
          const r = replay(seed, committed.slice(0, cut.nMoves));
          if (!r) break;
          if (probeAlive(r.game, r.tsds)) {
            stats.truncations++;
            committed.length = cut.nMoves;
            game = r.game;
            tsds = r.tsds;
            rescued = true;
            break;
          }
        }
        // no alive cut: retreat to this window's FIRST TSD boundary anyway —
        // committing the least of a poisoned line beats keeping all of it, and
        // each round still commits >=1 TSD so progress is monotonic
        if (!rescued && cuts.length > 1) {
          const r = replay(seed, committed.slice(0, cuts[0].nMoves));
          if (r) {
            stats.truncations++;
            committed.length = cuts[0].nMoves;
            game = r.game;
            tsds = r.tsds;
          }
        }
      }
    }
    if (game.board.maxHeight() >= 20) return done(tsds, "topped out");
  }
  return done(tsds, "reached target");
}

// ---- main ----

function seedStream(n: number): number[] {
  let a = Number(process.env.SEEDBASE ?? 987654321);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    a = (a * 1103515245 + 12345) & 0x7fffffff;
    out.push(((a / 0x7fffffff) * 2 ** 31) | 0);
  }
  return out;
}

const seeds = seedStream(N);
const policies: ("base" | "verify" | "cascade")[] = POLICY === "both" ? ["base", "verify"] : [POLICY];
console.log(`lst-window-driver: ${N} seeds, ${ALLOWQUAD ? "QUAD" : "TSD"} loop, target ${TARGET} clears, solver ${SOLVER}${SOLVER === "ts" ? ` leftOCap ${LEFTO}` : ""}, winNodes ${WINNODES}, probe ${PROBET} @ ${PROBENODES}, szReserve ${SZFILL}, partialHealth ${PHEALTH}\n`);

const summary: Record<string, number[]> = {};
for (const policy of policies) {
  console.log(`--- policy: ${policy} ---`);
  const reached: number[] = [];
  let hit = 0;
  for (const seed of seeds) {
    const r = policy === "cascade" ? driveCascade(seed) : drive(seed, policy);
    reached.push(r.tsds);
    if (r.tsds >= TARGET) hit++;
    const s = r.stats;
    console.log(
      `  seed ${String(seed).padStart(10)}: ${String(r.tsds).padStart(2)} TSD  ${r.note.padEnd(24)} ` +
        `win=${s.windows} probe=${s.probes} trunc=${s.truncations} esc=${s.escalations} rescue=${s.rescues}  [${(r.ms / 1000).toFixed(1)}s]`,
    );
  }
  const sorted = [...reached].sort((a, b) => a - b);
  const mean = reached.reduce((a, b) => a + b, 0) / reached.length;
  console.log(`  => reached ${TARGET}: ${hit}/${N}  |  mean ${mean.toFixed(1)}, median ${sorted[N >> 1]}, min ${sorted[0]}, max ${sorted[N - 1]}\n`);
  summary[policy] = reached;
}
if (policies.length === 2) {
  const diff = seeds.map((_, i) => summary.verify[i] - summary.base[i]);
  const wins = diff.filter((d) => d > 0).length;
  const losses = diff.filter((d) => d < 0).length;
  console.log(`verify vs base per-seed delta: [${diff.join(", ")}]  (${wins} up, ${losses} down)`);
}
