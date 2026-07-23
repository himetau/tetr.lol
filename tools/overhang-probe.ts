// Tests the user's observation: the bot papers over bad residue by dropping an
// L/J piece as an overhang instead of repairing the 2-tall residue on cols 0-4.
// Counts, over beam play, how often it plays an L/J-overhang WHILE residue is
// bad, and whether those runs die sooner (i.e. the masking coincides with doom).
//   npx tsx tools/overhang-probe.ts [runs]

import { Board } from "../src/core/board";
import type { PieceType } from "../src/core/pieces";
import { enumeratePlacements } from "../src/engine/enumerate";
import { lstLoopMove } from "../src/engine/lst-loop";
import coverData from "../src/data/lst-cover.json";

const hasStartResidue = (b: Board) => b.filled(0, 0) && b.filled(0, 1) && b.filled(4, 0) && b.filled(4, 1);
/** A placement is an "overhang" if it leaves an empty cell directly under one of
 *  its own cells (a covered void it created). */
function isOverhang(cells: readonly (readonly [number, number])[], after: Board): boolean {
  for (const [x, y] of cells) if (y > 0 && !after.filled(x, y - 1)) return true;
  return false;
}

const PIECES: PieceType[] = ["I", "O", "T", "S", "Z", "J", "L"];
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function bag(rng: () => number): PieceType[] {
  const b = [...PIECES];
  for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
  return b;
}
function startBoard(): Board {
  const g = coverData.groups.find((x) => x.name === "flattop LST bag 2")!;
  return Board.fromStrings(g.start.map((r) => r.replace(/[^X]/g, ".")));
}
const key = (cs: readonly (readonly [number, number])[]) => cs.map(([x, y]) => x * 32 + y).sort((a, b) => a - b).join(",");

const RUNS = Number(process.argv[2] ?? 15);
const shortRuns: number[] = [], longRuns: number[] = [];
let ljOverhangBad = 0, totalMoves = 0, anyOverhangBad = 0;

for (let i = 0; i < RUNS; i++) {
  const rng = mulberry32(5000 + i);
  let board = startBoard();
  let hold: PieceType | null = null;
  let queue: PieceType[] = [];
  let tsds = 0, ljBadThisRun = 0;
  for (let step = 0; step < 400; step++) {
    while (queue.length < 14) queue.push(...bag(rng));
    const mv = lstLoopMove(board, queue, hold, 7, 24, false, false, false);
    if (!mv) break;
    if (!mv.usesHold) queue.shift();
    else if (hold !== null) hold = queue.shift()!;
    else { hold = queue.shift()!; queue.shift(); }
    const placed = enumeratePlacements(board, mv.piece).find((p) => key(p.cells) === key(mv.cells));
    if (!placed) break;
    const badBefore = !hasStartResidue(board);
    const overhang = isOverhang(placed.cells, placed.after);
    totalMoves++;
    if (badBefore && overhang) {
      anyOverhangBad++;
      if (mv.piece === "L" || mv.piece === "J") { ljOverhangBad++; ljBadThisRun++; }
    }
    board = placed.after;
    if (placed.type === "T" && placed.spin === "full" && placed.linesCleared >= 2) tsds++;
    if (board.maxHeight() >= 20) break;
  }
  (tsds <= 2 ? shortRuns : longRuns).push(ljBadThisRun);
  console.log(`  seed ${5000 + i}: ${tsds} TSDs, L/J-overhang-while-bad-residue moves = ${ljBadThisRun}`);
}

const avg = (a: number[]) => a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : "n/a";
console.log(`\n=== over ${RUNS} runs ===`);
console.log(`L/J overhang played while residue BAD: ${ljOverhangBad}/${totalMoves} moves (${(100 * ljOverhangBad / totalMoves).toFixed(0)}%)`);
console.log(`any-piece overhang while residue bad: ${anyOverhangBad}/${totalMoves} (${(100 * anyOverhangBad / totalMoves).toFixed(0)}%)`);
console.log(`avg L/J-overhang-while-bad per run: short(<=2 TSD)=${avg(shortRuns)}  long(>2)=${avg(longRuns)}`);
