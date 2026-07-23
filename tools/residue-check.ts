// Tests the user's true-LST invariant: a correct LST structure carries a 2-tall
// residue on the 1st and 5th columns (0-indexed cols 0 and 4). Since TSDs clear
// full rows and the stack shifts down, that residue sits at the bottom, so we
// check rows 0-1. Traces it along the beam's play to answer: does it hold while
// the loop is healthy, and does its violation predict / coincide with death?
//   npx tsx tools/residue-check.ts [runs]

import { Board } from "../src/core/board";
import type { PieceType } from "../src/core/pieces";
import { enumeratePlacements } from "../src/engine/enumerate";
import { lstLoopMove } from "../src/engine/lst-loop";
import coverData from "../src/data/lst-cover.json";

/** The invariant under test: 2-tall residue at the base of cols 0 and 4. */
function hasStartResidue(b: Board): boolean {
  return b.filled(0, 0) && b.filled(0, 1) && b.filled(4, 0) && b.filled(4, 1);
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

const RUNS = Number(process.argv[2] ?? 15);

// calibration: does the invariant hold on the canonical start?
console.log(`start board hasStartResidue: ${hasStartResidue(startBoard())} (opener, expected false until loop establishes)`);

let healthyTrue = 0, healthySteps = 0; // residue rate over the first N-3 steps of each run
let deathResidueTrue = 0; // runs where residue held AT death
let brokeBeforeDeath = 0, deaths = 0;
const gapToDeaths: number[] = []; // steps from first residue-break to death

for (let i = 0; i < RUNS; i++) {
  const rng = mulberry32(5000 + i);
  let board = startBoard();
  let hold: PieceType | null = null;
  let queue: PieceType[] = [];
  const residueTrace: boolean[] = [];
  let tsds = 0;
  for (let step = 0; step < 400; step++) {
    while (queue.length < 14) queue.push(...bag(rng));
    const mv = lstLoopMove(board, queue, hold, 7, 24, false, false, false);
    if (!mv) { break; }
    if (!mv.usesHold) queue.shift();
    else if (hold !== null) hold = queue.shift()!;
    else { hold = queue.shift()!; queue.shift(); }
    const placed = enumeratePlacements(board, mv.piece).find((p) => key(p.cells) === key(mv.cells));
    if (!placed) { break; }
    board = placed.after;
    if (placed.type === "T" && placed.spin === "full" && placed.linesCleared >= 2) tsds++;
    residueTrace.push(hasStartResidue(board));
    if (board.maxHeight() >= 20) { break; }
  }
  deaths++;
  // healthy window = all but the last 3 steps (the pre-collapse loop)
  const healthyEnd = Math.max(0, residueTrace.length - 3);
  for (let s = 0; s < healthyEnd; s++) { healthySteps++; if (residueTrace[s]) healthyTrue++; }
  const atDeath = residueTrace.length ? residueTrace[residueTrace.length - 1] : false;
  if (atDeath) deathResidueTrue++;
  const firstBreak = residueTrace.findIndex((v) => !v);
  if (firstBreak >= 0 && firstBreak < residueTrace.length) {
    brokeBeforeDeath++;
    gapToDeaths.push(residueTrace.length - firstBreak);
  }
  console.log(
    `  seed ${5000 + i}: ${tsds} TSDs, ${residueTrace.length} steps, ` +
      `residueHeld=${(100 * residueTrace.filter(Boolean).length / Math.max(1, residueTrace.length)).toFixed(0)}%, ` +
      `atDeath=${atDeath}, firstBreak@${firstBreak < 0 ? "never" : firstBreak}`,
  );
}

console.log(`\n=== over ${RUNS} runs ===`);
console.log(`residue holds during healthy loop (pre-collapse steps): ${(100 * healthyTrue / Math.max(1, healthySteps)).toFixed(0)}%`);
console.log(`residue was BROKEN at the moment of death: ${(100 * (deaths - deathResidueTrue) / deaths).toFixed(0)}%`);
const med = gapToDeaths.sort((a, b) => a - b)[gapToDeaths.length >> 1] ?? NaN;
console.log(`median steps from first residue-break to death: ${med}`);
