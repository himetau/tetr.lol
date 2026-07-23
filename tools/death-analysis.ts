// Detailed "what is it dying to" breakdown of the free beam's LST play, through
// every validated lens: the classic death causes (site/volume/parity/overstack)
// PLUS the residue invariant, the single-mountain profile law, and the L/J
// overhang-mask death signature. Answers, per death: was the residue already
// broken? how long before death did it break? was there a masking overhang? is
// there an interior valley? - so we can see the true proximate cause.
//   npx tsx tools/death-analysis.ts [runs]

import { Board } from "../src/core/board";
import type { PieceType } from "../src/core/pieces";
import { enumeratePlacements } from "../src/engine/enumerate";
import { lstLoopMove } from "../src/engine/lst-loop";
import {
  findLstSite, volumeGap, checkerImbalance, stackSideImbalance,
  hasStartResidue, profileValley,
} from "../src/engine/eval";
import coverData from "../src/data/lst-cover.json";

const PIECES: PieceType[] = ["I", "O", "T", "S", "Z", "J", "L"];
function mul(s: number) { let a = s >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function bag(r: () => number) { const b = [...PIECES]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }
function startBoard() { const g = coverData.groups.find((x) => x.name === "flattop LST bag 2")!; return Board.fromStrings(g.start.map((r) => r.replace(/[^X]/g, "."))); }
const key = (cs: readonly (readonly [number, number])[]) => cs.map(([x, y]) => x * 32 + y).sort((a, b) => a - b).join(",");
const isOverhang = (cells: readonly (readonly [number, number])[], after: Board) => cells.some(([x, y]) => y > 0 && !after.filled(x, y - 1));

function cause(board: Board, topped: boolean): string {
  const site = findLstSite(board);
  const ci = checkerImbalance(board);
  const gap = site ? volumeGap(board, site.y) : volumeGap(board, 0);
  if (topped) return "topped out (overstack)";
  if (!site) return "no col-2 site left";
  if (gap >= 2) return "well overstacked (volume)";
  if (Math.abs(ci) >= 2) return "parity drift (|CI|>=2)";
  return "no legal continuation (piece-fit)";
}

const RUNS = Number(process.argv[2] ?? 40);
interface D { tsds: number; cause: string; resAtDeath: boolean; resBrokeStepsBeforeDeath: number; valley: number; ci: number; ssi: number; masks: number; }
const deaths: D[] = [];

for (let i = 0; i < RUNS; i++) {
  const rng = mul(5000 + i);
  let board = startBoard(), prev = board;
  let hold: PieceType | null = null, queue: PieceType[] = [];
  let tsds = 0, masks = 0;
  const resTrace: boolean[] = [];
  let topped = false;
  for (let step = 0; step < 400; step++) {
    while (queue.length < 14) queue.push(...bag(rng));
    const mv = lstLoopMove(board, queue, hold, 7, 24, false, false, false);
    if (!mv) break;
    if (!mv.usesHold) queue.shift();
    else if (hold !== null) hold = queue.shift()!;
    else { hold = queue.shift()!; queue.shift(); }
    const p = enumeratePlacements(board, mv.piece).find((q) => key(q.cells) === key(mv.cells));
    if (!p) break;
    if ((mv.piece === "L" || mv.piece === "J") && !hasStartResidue(board) && isOverhang(p.cells, p.after)) masks++;
    prev = board; board = p.after;
    if (p.type === "T" && p.spin === "full" && p.linesCleared >= 2) tsds++;
    resTrace.push(hasStartResidue(board));
    if (board.maxHeight() >= 20) { topped = true; break; }
  }
  const db = topped ? prev : board;
  // steps from last residue-break to death
  let broke = -1;
  for (let s = resTrace.length - 1; s >= 0; s--) { if (!resTrace[s]) { broke = s; } else break; }
  deaths.push({
    tsds, cause: cause(db, topped),
    resAtDeath: resTrace.length ? resTrace[resTrace.length - 1] : false,
    resBrokeStepsBeforeDeath: broke < 0 ? 0 : resTrace.length - broke,
    valley: profileValley(db), ci: checkerImbalance(db), ssi: stackSideImbalance(db), masks,
  });
}

const n = deaths.length;
const byCause = new Map<string, number>();
for (const d of deaths) byCause.set(d.cause, (byCause.get(d.cause) ?? 0) + 1);
console.log(`=== death causes over ${n} beam runs ===`);
for (const [c, k] of [...byCause].sort((a, b) => b[1] - a[1])) console.log(`  ${((100 * k) / n).toFixed(0).padStart(3)}%  ${c}`);
const ts = deaths.map((d) => d.tsds).sort((a, b) => a - b);
console.log(`  TSDs: mean=${(ts.reduce((a, b) => a + b, 0) / n).toFixed(1)} median=${ts[n >> 1]} max=${Math.max(...ts)}`);
console.log(`\n=== validated-lens breakdown ===`);
console.log(`  residue BROKEN at death: ${(100 * deaths.filter((d) => !d.resAtDeath).length / n).toFixed(0)}%`);
console.log(`  had an interior valley (>=2) at death: ${(100 * deaths.filter((d) => d.valley >= 2).length / n).toFixed(0)}%`);
console.log(`  parity |CI|>=2 at death: ${(100 * deaths.filter((d) => Math.abs(d.ci) >= 2).length / n).toFixed(0)}%`);
console.log(`  |stackSideImbalance|>=2 at death: ${(100 * deaths.filter((d) => Math.abs(d.ssi) >= 2).length / n).toFixed(0)}%`);
const withMasks = deaths.filter((d) => d.masks > 0);
console.log(`  runs with >=1 L/J overhang-mask: ${(100 * withMasks.length / n).toFixed(0)}% (avg masks/run ${(deaths.reduce((a, d) => a + d.masks, 0) / n).toFixed(2)})`);
const short = deaths.filter((d) => d.tsds <= 2), long = deaths.filter((d) => d.tsds > 2);
const avg = (a: D[], f: (d: D) => number) => a.length ? (a.reduce((s, d) => s + f(d), 0) / a.length).toFixed(2) : "n/a";
console.log(`\n=== short (<=2 TSD) vs long (>2) deaths ===`);
console.log(`  count: short ${short.length}, long ${long.length}`);
console.log(`  avg masks/run:  short ${avg(short, (d) => d.masks)}  long ${avg(long, (d) => d.masks)}`);
console.log(`  residue-broken%: short ${avg(short, (d) => (d.resAtDeath ? 0 : 1))}  long ${avg(long, (d) => (d.resAtDeath ? 0 : 1))}`);
console.log(`  valley>=2 %:     short ${avg(short, (d) => (d.valley >= 2 ? 1 : 0))}  long ${avg(long, (d) => (d.valley >= 2 ? 1 : 0))}`);
