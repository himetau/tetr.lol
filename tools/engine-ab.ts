// A/B bench of the two LST beam rankers over identical seeds/queues: the default
// soft-sum scoreNode vs the dormant lexicographic hard-gate ruleKey (ruleMode).
// Same horizon/beam/start for both, same bag stream per seed - the only variable
// is the ranking. Reports the TSD survival distribution and death causes so we
// can see if the hard-gate policy actually loops longer before dying.
//   npx tsx tools/engine-ab.ts [runs=60]

import { Board } from "../src/core/board";
import type { PieceType } from "../src/core/pieces";
import { lstLoopMove } from "../src/engine/lst-loop";
import { enumeratePlacements } from "../src/engine/enumerate";
import { findLstSite, volumeGap, checkerImbalance } from "../src/engine/eval";
import coverData from "../src/data/lst-cover.json";

const PIECES: PieceType[] = ["I", "O", "T", "S", "Z", "J", "L"];
function mul(s: number) { let a = s >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function bag(r: () => number) { const b = [...PIECES]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }
function startBoard() { const g = coverData.groups.find((x) => x.name === "flattop LST bag 2")!; return Board.fromStrings(g.start.map((r) => r.replace(/[^X]/g, "."))); }
const key = (cs: readonly (readonly [number, number])[]) => cs.map(([x, y]) => x * 32 + y).sort((a, b) => a - b).join(",");

function play(seed: number, ruleMode: boolean): { tsds: number; cause: string } {
  const rng = mul(5000 + seed);
  let board = startBoard();
  let hold: PieceType | null = null;
  const queue: PieceType[] = [];
  let tsds = 0;
  let topped = false;
  for (let step = 0; step < 400; step++) {
    while (queue.length < 14) queue.push(...bag(rng));
    const mv = lstLoopMove(board, queue, hold, 7, 24, false, false, ruleMode);
    if (!mv) break;
    if (!mv.usesHold) queue.shift();
    else if (hold !== null) hold = queue.shift()!;
    else { hold = queue.shift()!; queue.shift(); }
    const p = enumeratePlacements(board, mv.piece).find((q) => key(q.cells) === key(mv.cells));
    if (!p) break;
    board = p.after;
    if (p.type === "T" && p.spin === "full" && p.linesCleared >= 2) tsds++;
    if (board.maxHeight() >= 20) { topped = true; break; }
  }
  const site = findLstSite(board);
  const gap = site ? volumeGap(board, site.y) : 0;
  const cause = topped ? "topped out" : !site ? "no col-2 site" : gap >= 2 ? "well overstacked" : Math.abs(checkerImbalance(board)) >= 2 ? "parity drift" : "no legal continuation";
  return { tsds, cause };
}

const RUNS = Number(process.argv[2] ?? 60);
for (const ruleMode of [false, true]) {
  const label = ruleMode ? "ruleMode (hard-gate)" : "default (soft-sum)";
  const res = Array.from({ length: RUNS }, (_, i) => play(i, ruleMode));
  const ts = res.map((r) => r.tsds).sort((a, b) => a - b);
  const n = ts.length;
  const mean = (ts.reduce((a, b) => a + b, 0) / n).toFixed(2);
  const byCause = new Map<string, number>();
  for (const r of res) byCause.set(r.cause, (byCause.get(r.cause) ?? 0) + 1);
  console.log(`\n=== ${label} over ${n} runs ===`);
  console.log(`  TSDs: mean=${mean} median=${ts[n >> 1]} p90=${ts[Math.floor(n * 0.9)]} max=${Math.max(...ts)}  >=20: ${res.filter((r) => r.tsds >= 20).length}`);
  for (const [c, k] of [...byCause].sort((a, b) => b[1] - a[1])) console.log(`  ${((100 * k) / n).toFixed(0).padStart(3)}%  ${c}`);
}
