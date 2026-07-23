// Dumps parity fixtures for the Rust port of the core primitives.
// For a set of deterministically-generated boards, records each board's rows
// and, for every piece type, the exact enumeratePlacements() output (ordered).
// The Rust parity test (rust/lst-solver/tests/primitives.rs) reconstructs the
// same boards from rows and asserts byte-identical enumeration.
//
//   npx tsx tools/rust-fixtures.ts

import { writeFileSync, mkdirSync } from "node:fs";
import { Board, BOARD_W } from "../src/core/board";
import { PIECE_TYPES, type PieceType } from "../src/core/pieces";
import { enumeratePlacements, enumerateFast, placementKey } from "../src/engine/enumerate";
import { findLstSite, quadWellDepth } from "../src/engine/eval";
import LST_RUNS from "../src/data/lst-runs.json";

// mirror matching lst-solver.ts mirrorBoard (col x -> BOARD_W-1-x).
function mirrorKey(board: Board): string {
  const out = new Board();
  for (let y = 0; y < board.rows.length; y++) {
    const r = board.rows[y];
    let m = 0;
    for (let x = 0; x < BOARD_W; x++) {
      if ((r >>> x) & 1) m |= 1 << (BOARD_W - 1 - x);
    }
    out.rows[y] = m;
  }
  return out.key();
}

// Replay the first k moves of a verified LST run to reach a genuine LST state.
function replayBoard(seed: number, k: number): Board {
  const moves = (LST_RUNS.runs as Record<string, { cells: number[][] }[]>)[String(seed)];
  const b = new Board();
  for (let i = 0; i < Math.min(k, moves.length); i++) {
    b.place(moves[i].cells as [number, number][]);
    b.clearLines();
  }
  return b;
}

// mulberry32 deterministic PRNG
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Build a realistic reachable stack by hard-dropping `n` random pieces.
function buildBoard(seed: number, n: number): Board {
  const rand = rng(seed);
  const board = new Board();
  for (let i = 0; i < n; i++) {
    const type = PIECE_TYPES[(rand() * PIECE_TYPES.length) | 0];
    const opts = enumerateFast(board, type).filter((p) => p.after.maxHeight() < 18);
    if (opts.length === 0) break;
    const pick = opts[(rand() * opts.length) | 0];
    board.rows.set(pick.after.rows);
  }
  return board;
}

interface PlacementDump {
  key: string;
  spin: string;
  lines: number;
  after: string; // after-board key
  path: string; // path joined by space
}

interface BoardDump {
  rows: number[];
  key: string;
  placements: Record<string, PlacementDump[]>; // piece -> ordered enumeratePlacements
  fast: Record<string, PlacementDump[]>; // piece -> ordered enumerateFast
  site: { y: number; missing: number; roofReady: boolean } | null;
  quadDepth: number;
  mirror: string; // mirrorBoard(board).key()
}

function dumpPlacements(board: Board, type: PieceType, fast: boolean): PlacementDump[] {
  const list = fast ? enumerateFast(board, type) : enumeratePlacements(board, type);
  return list.map((p) => ({
    key: placementKey(p.type, p.cells),
    spin: p.spin,
    lines: p.linesCleared,
    after: p.after.key(),
    path: p.path.join(" "),
  }));
}

const boards: BoardDump[] = [];

// Board 0: empty (exercises the full open-field enumeration)
{
  const b = new Board();
  boards.push(makeDump(b));
}
// A spread of stacked boards of varying height/seed for tuck & spin coverage.
for (const [seed, n] of [
  [1, 8],
  [2, 12],
  [3, 16],
  [7, 20],
  [11, 24],
  [13, 10],
  [42, 18],
  [99, 22],
  [123, 14],
  [777, 26],
] as [number, number][]) {
  boards.push(makeDump(buildBoard(seed, n)));
}

// Genuine LST states from verified runs (findLstSite non-null coverage).
for (const [seed, k] of [
  [10, 4],
  [10, 20],
  [10, 40],
  [165, 24],
  [165, 30],
  [392, 12],
  [1228, 26],
] as [number, number][]) {
  boards.push(makeDump(replayBoard(seed, k)));
}

function makeDump(board: Board): BoardDump {
  const placements: Record<string, PlacementDump[]> = {};
  const fast: Record<string, PlacementDump[]> = {};
  for (const type of PIECE_TYPES) {
    placements[type] = dumpPlacements(board, type, false);
    fast[type] = dumpPlacements(board, type, true);
  }
  const s = findLstSite(board);
  return {
    rows: Array.from(board.rows),
    key: board.key(),
    placements,
    fast,
    site: s ? { y: s.y, missing: s.missing, roofReady: s.roofReady } : null,
    quadDepth: quadWellDepth(board),
    mirror: mirrorKey(board),
  };
}

const outDir = "rust/lst-solver/tests";
mkdirSync(outDir, { recursive: true });
const out = `${outDir}/primitives-fixtures.json`;
writeFileSync(out, JSON.stringify({ boards }, null, 0));

const totalPlacements = boards.reduce(
  (s, b) => s + Object.values(b.placements).reduce((a, ps) => a + ps.length, 0),
  0,
);
console.log(
  `wrote ${out}: ${boards.length} boards, ${totalPlacements} placements across ${PIECE_TYPES.length} pieces`,
);
