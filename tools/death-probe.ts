// Runs the live LST loop until it dies, captures the board + diagnostics at the
// moment of death, classifies the cause, and prints representative death boards.
//   npx tsx tools/death-probe.ts [runs] [show]

import { Board } from "../src/core/board";
import type { PieceType } from "../src/core/pieces";
import { enumeratePlacements } from "../src/engine/enumerate";
import { lstLoopMove } from "../src/engine/lst-loop";
import {
  findLstSite,
  volumeGap,
  checkerImbalance,
  isLstState,
  lstOverhangHeights,
  LST_SPIN_COL,
} from "../src/engine/eval";
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

interface Death {
  tsds: number;
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
  if (toppedOut) {
    cause = "topped out (overstack)";
  } else if (!site) {
    cause = "no col-2 site left";
  } else if (gap >= 2) {
    cause = "well overstacked (volume, no double-up completed)";
  } else if (Math.abs(ci) >= 2) {
    cause = "parity drift (|CI|>=2)";
  } else {
    cause = "no legal continuation (piece-fit)";
  }
  return { cause, detail };
}

const HORIZON = Number(process.argv[4] ?? 7);
const RULE_MODE = process.env.RULE === "1"; // hard rule-follower vs soft beam

function runOne(seed: number): Death {
  const rng = mulberry32(seed);
  let board = startBoard();
  let prev = board;
  let hold: PieceType | null = null;
  let queue: PieceType[] = [];
  let tsds = 0;
  for (let step = 0; step < 400; step++) {
    while (queue.length < 14) queue.push(...bag(rng));
    const mv = lstLoopMove(board, queue, hold, HORIZON, 24, false, false, RULE_MODE);
    if (!mv) {
      const c = classify(board, false);
      return { tsds, cause: c.cause, board, detail: c.detail };
    }
    if (!mv.usesHold) queue.shift();
    else if (hold !== null) hold = queue.shift()!;
    else {
      hold = queue.shift()!;
      queue.shift();
    }
    const placed = enumeratePlacements(board, mv.piece).find((p) => key(p.cells) === key(mv.cells));
    if (!placed) {
      const c = classify(board, false);
      return { tsds, cause: "internal", board, detail: c.detail };
    }
    prev = board;
    board = placed.after;
    if (placed.type === "T" && placed.spin === "full" && placed.linesCleared >= 2) tsds++;
    if (board.maxHeight() >= 20) {
      const c = classify(prev, true);
      return { tsds, cause: c.cause, board: prev, detail: c.detail };
    }
  }
  return { tsds, cause: "survived 400 steps", board, detail: "" };
}

const RUNS = Number(process.argv[2] ?? 40);
const SHOW = Number(process.argv[3] ?? 4);
const deaths: Death[] = [];
for (let i = 0; i < RUNS; i++) deaths.push(runOne(5000 + i));

const byCause = new Map<string, number>();
for (const d of deaths) byCause.set(d.cause, (byCause.get(d.cause) ?? 0) + 1);
console.log(`=== death causes over ${RUNS} runs ===`);
for (const [c, n] of [...byCause.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${((100 * n) / RUNS).toFixed(0).padStart(3)}%  ${c}`);
}
const tsdVals = deaths.map((d) => d.tsds).sort((a, b) => a - b);
console.log(`  TSDs at death: mean=${(tsdVals.reduce((a, b) => a + b, 0) / RUNS).toFixed(1)} median=${tsdVals[RUNS >> 1]} max=${Math.max(...tsdVals)}`);

// show representative death boards (the most common cause, a spread of TSD counts)
const topCause = [...byCause.entries()].sort((a, b) => b[1] - a[1])[0][0];
const samples = deaths.filter((d) => d.cause === topCause).sort((a, b) => b.tsds - a.tsds).slice(0, SHOW);
console.log(`\n=== ${SHOW} boards dying to: "${topCause}" (well = col ${LST_SPIN_COL}) ===`);
for (const d of samples) {
  console.log(`\n--- died at ${d.tsds} TSDs --- ${d.detail}`);
  for (const row of d.board.toStrings(Math.min(20, d.board.maxHeight() + 1))) {
    console.log("  " + row.replace(/X/g, "█").replace(/_/g, "·"));
  }
}
