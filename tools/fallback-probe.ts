// Decisive test of the "planner as off-plan fallback" lever. The live drill,
// when off-plan, tries lstLoopMove (the beam); when that returns null it drops
// to the generic soft engine bestMove (measured 52% of unpooled live moves).
// This probe asks: on the boards where the beam bails, can a SHORT even-residue
// mini-solve (solveLstRun, target 2-3) produce a clean line instead of the
// blind engine? It drives two fallback chains on identical deterministic seeds
// and reports attribution, survival (TSDs before death), and cleanliness
// (mean lstHoles over the played boards + well-side base spread).
//
//   npx tsx tools/fallback-probe.ts [runs] [shortTarget] [budgetMs]

import { Board, BOARD_W, BOARD_H } from "../src/core/board";
import type { PieceType } from "../src/core/pieces";
import { enumeratePlacements } from "../src/engine/enumerate";
import { lstLoopMove } from "../src/engine/lst-loop";
import { bestMove } from "../src/engine/grade";
import { solveLstRun } from "../src/engine/lst-solver";
import { lstHoles, LST_SPIN_COL, findLstSite } from "../src/engine/eval";
import coverData from "../src/data/lst-cover.json";

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

/** well-side base spread (cols 0,1,3): the "uneven residue" metric. */
function baseSpread(board: Board): number {
  const cols = [LST_SPIN_COL - 2, LST_SPIN_COL - 1, LST_SPIN_COL + 1].filter((x) => x >= 0 && x < BOARD_W);
  let lo = Infinity, hi = -Infinity;
  for (const x of cols) {
    let base = 0;
    while (base < BOARD_H && board.filled(x, base)) base++;
    lo = Math.min(lo, base);
    hi = Math.max(hi, base);
  }
  return hi > lo ? hi - lo : 0;
}

const SHORT_TARGET = Number(process.argv[3] ?? 3);
const BUDGET = Number(process.argv[4] ?? 400);

interface Stats {
  tsds: number;
  loop: number;
  solve: number; // short-solve rescues (only in mode B)
  engine: number;
  holeSum: number;
  spreadSum: number;
  steps: number;
  nullRescuable: number; // beam-null steps where a short solve WOULD return a line
  nullTotal: number;
  nullWithSite: number; // beam-null steps that still have a clean LST site
}

function runOne(seed: number, useSolve: boolean): Stats {
  const rng = mulberry32(seed);
  let board = startBoard();
  let hold: PieceType | null = null;
  let queue: PieceType[] = [];
  let tsds = 0;
  const s: Stats = { tsds: 0, loop: 0, solve: 0, engine: 0, holeSum: 0, spreadSum: 0, steps: 0, nullRescuable: 0, nullTotal: 0, nullWithSite: 0 };
  for (let step = 0; step < 200; step++) {
    while (queue.length < 16) queue.push(...bag(rng));
    let mv: { piece: PieceType; cells: [number, number][]; spin: string } | null = null;
    const loop = lstLoopMove(board, queue, hold, 7, 24, false);
    if (loop) {
      mv = { piece: loop.piece, cells: loop.cells, spin: loop.spin };
      s.loop++;
    } else {
      // beam bailed: this is where the live drill drops to the blind engine
      s.nullTotal++;
      if (findLstSite(board)) s.nullWithSite++;
      const rescue = solveLstRun(board, queue, hold, SHORT_TARGET, { budgetMs: BUDGET });
      const hasLine = !!rescue && rescue.moves.length > 0;
      if (hasLine) s.nullRescuable++;
      if (useSolve && hasLine) {
        const m0 = rescue!.moves[0];
        mv = { piece: m0.piece, cells: m0.cells, spin: m0.spin };
        s.solve++;
      } else {
        const bm = bestMove(Array.from(board.rows), [queue[0], ...queue.slice(1)], hold, true);
        if (bm) {
          mv = { piece: bm.piece, cells: bm.cells, spin: bm.spin };
          s.engine++;
        }
      }
    }
    if (!mv) break;
    // resolve hold usage: mv.piece must be the active or the held piece
    const active = queue[0];
    if (mv.piece === active) {
      queue.shift();
    } else if (hold === mv.piece) {
      hold = queue.shift()!;
    } else if (hold === null) {
      hold = queue.shift()!;
      // now the held piece is the old active; the intended piece is next
      if (queue[0] === mv.piece) queue.shift();
      else { /* mismatch, just consume */ queue.shift(); }
    } else {
      queue.shift();
    }
    const placed = enumeratePlacements(board, mv.piece).find((p) => key(p.cells) === key(mv.cells));
    if (!placed) break;
    board = placed.after;
    if (placed.type === "T" && placed.spin === "full" && placed.linesCleared >= 2) tsds++;
    s.steps++;
    s.holeSum += lstHoles(board);
    s.spreadSum += baseSpread(board);
    if (board.maxHeight() >= 20) break;
  }
  s.tsds = tsds;
  return s;
}

const RUNS = Number(process.argv[2] ?? 30);
function agg(mode: boolean, label: string) {
  const all: Stats[] = [];
  for (let i = 0; i < RUNS; i++) all.push(runOne(5000 + i, mode));
  const sum = (f: (s: Stats) => number) => all.reduce((a, s) => a + f(s), 0);
  const tsdMean = sum((s) => s.tsds) / RUNS;
  const steps = sum((s) => s.steps);
  const holeMean = sum((s) => s.holeSum) / Math.max(1, steps);
  const spreadMean = sum((s) => s.spreadSum) / Math.max(1, steps);
  const nullTotal = sum((s) => s.nullTotal);
  const nullResc = sum((s) => s.nullRescuable);
  const nullSite = sum((s) => s.nullWithSite);
  console.log(`\n[${label}]`);
  console.log(`  mean TSDs at death: ${tsdMean.toFixed(2)}`);
  console.log(`  moves: Loop ${sum((s) => s.loop)}  Solve ${sum((s) => s.solve)}  Engine ${sum((s) => s.engine)}  (total steps ${steps})`);
  console.log(`  cleanliness: mean lstHoles/board ${holeMean.toFixed(2)}  mean base spread ${spreadMean.toFixed(2)}`);
  console.log(`  beam-null steps: ${nullTotal}, of which still have a clean site: ${nullSite}, of which a short solve returns a line: ${nullResc} (${nullTotal ? ((100 * nullResc) / nullTotal).toFixed(0) : 0}% rescue rate)`);
}
console.log(`fallback-probe: ${RUNS} runs, shortTarget=${SHORT_TARGET}, budget=${BUDGET}ms`);
agg(false, "A: current  (Loop -> Engine)");
agg(true, "B: proposed (Loop -> ShortSolve -> Engine)");
