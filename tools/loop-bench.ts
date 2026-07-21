// Measures how many clean TSDs the live LST loop player sustains on random
// bags, with and without the cover-book "pattern recognition" prior. Starts
// from a real flat-top LST loop state and feeds fresh 7-bags.
//
//   npx tsx tools/loop-bench.ts [runs] [horizon] [beam]

import { Board } from "../src/core/board";
import type { PieceType } from "../src/core/pieces";
import { enumeratePlacements } from "../src/engine/enumerate";
import { lstLoopMove } from "../src/engine/lst-loop";
import coverData from "../src/data/lst-cover.json";

const PIECES: PieceType[] = ["I", "O", "T", "S", "Z", "J", "L"];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
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

function runOne(seed: number, useBook: boolean, horizon: number, beam: number): number {
  const rng = mulberry32(seed);
  let board = startBoard();
  let hold: PieceType | null = null;
  let queue: PieceType[] = [];
  const refill = () => {
    while (queue.length < 14) {
      queue.push(...bag(rng));
    }
  };
  let tsds = 0;
  for (let step = 0; step < 500; step++) {
    refill();
    const mv = lstLoopMove(board, queue, hold, horizon, beam, useBook);
    if (!mv) {
      break;
    }
    // resolve hold bookkeeping the same way lstLoopMove's opts did
    if (!mv.usesHold) {
      queue.shift();
    } else if (hold !== null) {
      hold = queue.shift()!;
    } else {
      hold = queue.shift()!;
      queue.shift();
    }
    // realise the move on the board (find the matching enumerated placement)
    const key = (cs: readonly (readonly [number, number])[]) =>
      cs.map(([x, y]) => x * 32 + y).sort((a, b) => a - b).join(",");
    const placed = enumeratePlacements(board, mv.piece).find((p) => key(p.cells) === key(mv.cells));
    if (!placed) {
      break; // shouldn't happen; treat as loop death
    }
    board = placed.after;
    if (placed.type === "T" && placed.spin === "full" && placed.linesCleared >= 2) {
      tsds++;
    }
    if (board.maxHeight() >= 20) {
      break;
    }
  }
  return tsds;
}

function summarise(label: string, vals: number[]) {
  const n = vals.length;
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const sorted = [...vals].sort((a, b) => a - b);
  const median = sorted[Math.floor(n / 2)];
  const max = Math.max(...vals);
  const reach20 = vals.filter((v) => v >= 20).length;
  const reach15 = vals.filter((v) => v >= 15).length;
  console.log(
    `${label.padEnd(10)} n=${n} mean=${mean.toFixed(1)} median=${median} max=${max} ` +
      `reach15=${reach15} reach20=${reach20}`,
  );
}

const RUNS = Number(process.argv[2] ?? 40);
const HORIZON = Number(process.argv[3] ?? 7);
const BEAM = Number(process.argv[4] ?? 24);

console.log(`runs=${RUNS} horizon=${HORIZON} beam=${BEAM}`);
const t0 = Date.now();
const noBook: number[] = [];
const withBook: number[] = [];
for (let i = 0; i < RUNS; i++) {
  const seed = 1000 + i;
  noBook.push(runOne(seed, false, HORIZON, BEAM));
  withBook.push(runOne(seed, true, HORIZON, BEAM));
}
summarise("no-book", noBook);
summarise("book", withBook);
console.log(`(${((Date.now() - t0) / 1000).toFixed(0)}s)`);
