// Measures how far Cold Clear 2 (the best available bot) loops LST on the same
// death-probe harness the built-in beam uses. Drives CC2's wasm directly from
// Node with the LST-loop weight profile, from the same flat-top start board and
// deterministic 7-bag seeds as death-probe, and reports death causes + the TSD
// distribution at death. If CC2 also caps single digits, LST-reactive is
// engine-independent-bounded; if it loops long, the beam was just weak.
//   npx tsx tools/cc2-lst-probe.ts [runs] [show] [nodes]

import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initSync, ColdClear } from "../src/engine/cc2/cold_clear_2.js";
import { Board } from "../src/core/board";
import type { PieceType } from "../src/core/pieces";
import { enumeratePlacements } from "../src/engine/enumerate";
import { CC2_LST_LOOP } from "../src/engine/cc2-weights";

// LST-taught profile: tune the levers CC2's fixed feature set actually exposes
// toward basic LST structure. NOTE only-T-spins is enforced by the GOAL=tonly
// move filter, not here — CC2's spin_clears weight can't distinguish piece type.
const CC2_LST_STRICT_JSON = JSON.stringify({
  freestyle_weights: {
    ...CC2_LST_LOOP.freestyle_weights,
    cell_coveredness: -0.05, // LST *needs* a covered T-slot notch — don't punish coverage hard
    max_cell_covered_height: 8, // let the overhang cover a deeper void
    tslot: [1.0, 4.0, 6.0, 8.0], // build and keep the standing T-slot (the whole structure)
    tetris_well_depth: 0.0, // no I-well in LST; don't dig one
    holes: -4.0, // strictly hole-free residue
  },
  freestyle_exploitation: CC2_LST_LOOP.freestyle_exploitation,
});
const WEIGHTS = process.env.PROFILE === "strict" ? CC2_LST_STRICT_JSON : JSON.stringify(CC2_LST_LOOP);
import {
  findLstSite,
  volumeGap,
  checkerImbalance,
  isLstState,
  lstOverhangHeights,
  LST_SPIN_COL,
} from "../src/engine/eval";
import coverData from "../src/data/lst-cover.json";

// --- boot the CC2 wasm in Node (bypass the browser fetch loader) ---
const wasmPath = fileURLToPath(new URL("../src/engine/cc2/cold_clear_2_bg.wasm", import.meta.url));
initSync(readFileSync(wasmPath));

interface CC2Move {
  piece: string;
  spin: "n" | "m" | "f";
  lines: number;
  usesHold: boolean;
  cells: number[];
}

/** Board rows (bit x = filled at column x) -> 10 column bitboards (bit y). */
function rowsToCols(rows: ArrayLike<number>): Uint32Array {
  const cols = new Uint32Array(10);
  for (let y = 0; y < rows.length; y++) {
    const r = rows[y];
    for (let x = 0; x < 10; x++) if ((r >>> x) & 1) cols[x] |= 1 << y;
  }
  return cols;
}
function pairsOf(flat: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}
function cc2Analyze(
  board: Board,
  queue: PieceType[],
  hold: PieceType | null,
  b2b: boolean,
  combo: number,
  nodes: number,
): CC2Move[] {
  const cc = new ColdClear(
    rowsToCols(board.rows),
    queue.join(""),
    hold ?? "",
    b2b,
    combo,
    WEIGHTS,
  );
  cc.work(nodes);
  const s = cc.suggest();
  cc.free();
  return s ? (JSON.parse(s) as CC2Move[]) : [];
}

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
const key = (cs: readonly (readonly [number, number])[]) =>
  cs.map(([x, y]) => x * 32 + y).sort((a, b) => a - b).join(",");

interface Death {
  tsds: number;
  otherClears: number;
  cause: string;
  board: Board;
  detail: string;
}

function classify(board: Board, toppedOut: boolean): { cause: string; detail: string } {
  const site = findLstSite(board);
  const ci = checkerImbalance(board);
  const gap = site ? volumeGap(board, site.y) : volumeGap(board, 0);
  const left = lstOverhangHeights(board, LST_SPIN_COL - 1, board.maxHeight());
  const right = lstOverhangHeights(board, LST_SPIN_COL + 1, board.maxHeight());
  const shape = isLstState(board);
  const detail =
    `h=${board.maxHeight()} site=${site ? `y${site.y}/miss${site.missing}` : "NONE"} ` +
    `volGap=${gap.toFixed(1)} CI=${ci} lstShape=${shape} ` +
    `L=[${left}] R=[${right}]`;
  let cause: string;
  if (toppedOut) cause = "topped out (overstack)";
  else if (!site) cause = "no col-2 site left";
  else if (gap >= 2) cause = "well overstacked (volume, no double-up completed)";
  else if (Math.abs(ci) >= 2) cause = "parity drift (|CI|>=2)";
  else cause = "no legal continuation (piece-fit)";
  return { cause, detail };
}

const NODES = Number(process.argv[4] ?? 30000);
const STEP_LOG = process.env.STEP_LOG ?? "";
const MAX_STEPS = Number(process.env.MAX_STEPS ?? 400);
// GOAL selects which clears are allowed:
//   "top"  (default) take CC2's top move, no constraint (all-spin B2B loop)
//   "tonly" only a full-T TSD may clear lines (strict shipped solver goal)
//   "noi"   any clear allowed EXCEPT an I-piece clearing lines (the literal
//           lst-goal-design rule: "no I spent on a clear", spins permitted)
const GOAL = process.env.GOAL ?? (process.env.CLEAN === "1" ? "tonly" : "top");
const CLEAN = GOAL !== "top";
const DEBUG_CLEARS = process.env.DEBUG_CLEARS ?? ""; // log every non-TSD clear (spin-mismatch diagnosis)
const QAHEAD = Number(process.env.QAHEAD ?? 14); // pieces of lookahead fed to CC2 (deterministic-queue "read the bag")

function runOne(seed: number): Death {
  const rng = mulberry32(seed);
  let board = startBoard();
  let prev = board;
  let hold: PieceType | null = null;
  let queue: PieceType[] = [];
  let tsds = 0;
  let otherClears = 0;
  let b2b = false;
  let combo = 0;
  for (let step = 0; step < MAX_STEPS; step++) {
    while (queue.length < QAHEAD) queue.push(...bag(rng));
    const moves = cc2Analyze(board, queue, hold, b2b, combo, NODES);
    // Strict-clean mode: the LST drill goal forbids EVERY clear except a full
    // *T*-spin double. CC2's all-spin patch happily makes S/Z/J/L spin doubles
    // and I-quads to manage volume; those violate the T-only LST goal, so here
    // we reject them, keeping only CC2 candidates that clear nothing or are a
    // genuine full-T TSD. Iterate CC2's ranking and take the best candidate that
    // is BOTH goal-legal and reproducible here (skip tuck paths our enumerator
    // can't rebuild, rather than counting them as a death).
    const isFullTsd = (m: CC2Move) => m.piece === "T" && m.spin === "f" && m.lines >= 2;
    const noIClear = (m: CC2Move) => !(m.piece === "I" && m.lines > 0);
    const noWastedT = (m: CC2Move) => m.piece !== "T" || isFullTsd(m);
    const goalOk = (m: CC2Move) =>
      GOAL === "noi"
        ? noIClear(m) // forbid only I-clears; spins OK
        : GOAL === "shipped"
          ? noIClear(m) && noWastedT(m) // literal lst-goal-design: no I-clear + no wasted T
          : m.lines === 0 || isFullTsd(m); // tonly: only a full-T TSD may clear
    const candidates = CLEAN ? moves.filter(goalOk) : moves;
    let mv: CC2Move | undefined;
    let placed: ReturnType<typeof enumeratePlacements>[number] | undefined;
    for (const cand of candidates) {
      const p = enumeratePlacements(board, cand.piece as PieceType).find(
        (pl) => key(pl.cells) === key(pairsOf(cand.cells)),
      );
      if (p) {
        mv = cand;
        placed = p;
        break;
      }
    }
    if (!mv || !placed) {
      const c = classify(board, false);
      const cause = candidates.length === 0 ? c.cause : "no reproducible goal-legal move";
      return { tsds, otherClears, cause, board, detail: c.detail };
    }
    if (!mv.usesHold) queue.shift();
    else if (hold !== null) hold = queue.shift()!;
    else {
      hold = queue.shift()!;
      queue.shift();
    }
    // b2b / combo bookkeeping for the next CC2 query
    const cleared = placed.linesCleared;
    const isTsd = placed.type === "T" && placed.spin === "full" && cleared >= 2;
    if (cleared > 0) {
      combo++;
      const spinClear = placed.spin === "full" || placed.spin === "mini";
      b2b = spinClear || cleared >= 4;
      if (!isTsd) otherClears++; // a goal-violating clear (quad/single/TSS/etc.)
      if (DEBUG_CLEARS && !isTsd)
        appendFileSync(
          DEBUG_CLEARS,
          `  seed ${seed} step ${step}: cc2[${mv.piece} spin=${mv.spin} lines=${mv.lines}] ` +
            `vs placed[${placed.type} spin=${placed.spin} lines=${placed.linesCleared}]\n`,
        );
    } else {
      combo = 0;
    }
    prev = board;
    board = placed.after;
    if (isTsd) tsds++;
    if (STEP_LOG && step % 10 === 0)
      appendFileSync(STEP_LOG, `    seed ${seed} step ${step}: tsds=${tsds} h=${board.maxHeight()} combo=${combo}\n`);
    if (board.maxHeight() >= 20) {
      const c = classify(prev, true);
      return { tsds, otherClears, cause: c.cause, board: prev, detail: c.detail };
    }
  }
  return { tsds, otherClears, cause: `survived ${MAX_STEPS} steps`, board, detail: "" };
}

const RUNS = Number(process.argv[2] ?? 20);
const SHOW = Number(process.argv[3] ?? 4);
const PROGRESS = process.env.PROGRESS ?? ""; // file to append per-seed results (unbuffered)
const deaths: Death[] = [];
const note = (s: string) => {
  console.log(s);
  if (PROGRESS) appendFileSync(PROGRESS, s + "\n");
};
note(`Running CC2 (LST-loop weights${CLEAN ? ", STRICT-CLEAN" : ""}, ${NODES} nodes) over ${RUNS} seeds...`);
for (let i = 0; i < RUNS; i++) {
  const t0 = Date.now();
  deaths.push(runOne(5000 + i));
  const d = deaths[i];
  note(
    `  seed ${5000 + i}: ${d.tsds} TSDs, ${d.otherClears} other-clears (${d.cause}) ` +
      `[${((Date.now() - t0) / 1000).toFixed(1)}s]`,
  );
}

const byCause = new Map<string, number>();
for (const d of deaths) byCause.set(d.cause, (byCause.get(d.cause) ?? 0) + 1);
console.log(`\n=== death causes over ${RUNS} runs ===`);
for (const [c, n] of [...byCause.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${((100 * n) / RUNS).toFixed(0).padStart(3)}%  ${c}`);
}
const tsdVals = deaths.map((d) => d.tsds).sort((a, b) => a - b);
const ocVals = deaths.map((d) => d.otherClears);
console.log(
  `  TSDs at death: mean=${(tsdVals.reduce((a, b) => a + b, 0) / RUNS).toFixed(1)} ` +
    `median=${tsdVals[RUNS >> 1]} max=${Math.max(...tsdVals)} min=${Math.min(...tsdVals)}`,
);
console.log(
  `  non-TSD clears/run (goal violations): mean=${(ocVals.reduce((a, b) => a + b, 0) / RUNS).toFixed(1)} ` +
    `max=${Math.max(...ocVals)}  (${CLEAN ? "strict-clean: should be 0" : "soft: >0 = CC2 cheated volume with quads/singles"})`,
);

const topCause = [...byCause.entries()].sort((a, b) => b[1] - a[1])[0][0];
const samples = deaths.filter((d) => d.cause === topCause).sort((a, b) => b.tsds - a.tsds).slice(0, SHOW);
console.log(`\n=== ${SHOW} boards dying to: "${topCause}" (well = col ${LST_SPIN_COL}) ===`);
for (const d of samples) {
  console.log(`\n--- died at ${d.tsds} TSDs --- ${d.detail}`);
  for (const row of d.board.toStrings(Math.min(20, d.board.maxHeight() + 1))) {
    console.log("  " + row.replace(/X/g, "█").replace(/_/g, "·"));
  }
}
