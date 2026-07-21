// Does allowing the quad (real LST's volume drain) let the eval-driven live
// loop run indefinitely on random seeds? Counts TSDs + quads and whether the
// loop survives a long horizon (a proxy for "infinite"). Compares no-quad vs
// quad.
//   npx tsx tools/quad-loop.ts [runs] [horizon] [maxSteps]

import { Board } from "../src/core/board";
import type { PieceType } from "../src/core/pieces";
import { enumeratePlacements } from "../src/engine/enumerate";
import { lstLoopMove } from "../src/engine/lst-loop";
import { lstHoles } from "../src/engine/eval";
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

const RUNS = Number(process.argv[2] ?? 20);
const HORIZON = Number(process.argv[3] ?? 7);
const MAX_STEPS = Number(process.argv[4] ?? 300);

function runOne(seed: number, allowQuad: boolean) {
  const rng = mulberry32(seed);
  let board = startBoard();
  let hold: PieceType | null = null;
  let queue: PieceType[] = [];
  let tsds = 0;
  let quads = 0;
  let dirty = false;
  let step = 0;
  for (; step < MAX_STEPS; step++) {
    while (queue.length < 14) queue.push(...bag(rng));
    const mv = lstLoopMove(board, queue, hold, HORIZON, 24, false, allowQuad);
    if (!mv) break;
    if (!mv.usesHold) queue.shift();
    else if (hold !== null) hold = queue.shift()!;
    else {
      hold = queue.shift()!;
      queue.shift();
    }
    const placed = enumeratePlacements(board, mv.piece).find((p) => key(p.cells) === key(mv.cells));
    if (!placed) break;
    board = placed.after;
    if (placed.type === "T" && placed.spin === "full" && placed.linesCleared >= 2) tsds++;
    else if (placed.linesCleared === 4) quads++;
    if (lstHoles(board) > 0) dirty = true;
    if (board.maxHeight() >= 20) break;
  }
  return { tsds, quads, survived: step >= MAX_STEPS, dirty };
}

function summarize(label: string, allowQuad: boolean) {
  const rows = [];
  let survivedCount = 0;
  let dirtyCount = 0;
  for (let i = 0; i < RUNS; i++) {
    const r = runOne(7000 + i, allowQuad);
    rows.push(r);
    if (r.survived) survivedCount++;
    if (r.dirty) dirtyCount++;
  }
  const tsd = rows.map((r) => r.tsds);
  const clears = rows.map((r) => r.tsds + r.quads);
  const meanTsd = tsd.reduce((a, b) => a + b, 0) / RUNS;
  const meanClears = clears.reduce((a, b) => a + b, 0) / RUNS;
  const totalQuads = rows.reduce((a, b) => a + b.quads, 0);
  const sortedC = [...clears].sort((a, b) => a - b);
  console.log(
    `${label}: meanTSD=${meanTsd.toFixed(1)} meanClears=${meanClears.toFixed(1)} ` +
      `medianClears=${sortedC[RUNS >> 1]} maxClears=${Math.max(...clears)} ` +
      `quadsTotal=${totalQuads} survived(${MAX_STEPS}steps)=${survivedCount}/${RUNS} ` +
      `runsWithHole=${dirtyCount}/${RUNS}`,
  );
}

const t0 = Date.now();
console.log(`runs=${RUNS} horizon=${HORIZON} maxSteps=${MAX_STEPS}`);
summarize("no-quad ", false);
summarize("quad    ", true);
console.log(`(${((Date.now() - t0) / 1000).toFixed(0)}s)`);
