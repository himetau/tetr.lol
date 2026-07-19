// Regenerates src/data/fourwide.json - the center 4-wide combo book.
//
// The 28 canonical 3-residual states are the ones DDRKirby's 4-wide trainer
// (https://ddrkirby.com/games/4-wide-trainer/4-wide-trainer.html) enumerates:
// every residual pattern that both results from a combo continuation and has
// continuations of its own. The continuation table itself is NOT copied from
// that tool: for each state x piece we rebuild the real trainer board (walls
// on columns 0-2 / 7-9, residual in the column 3-6 well) and run the engine's
// own enumeratePlacements, so every book move is reachable under this
// trainer's SRS kicks, spawn position, and tuck rules. A placement is a
// continuation when it clears exactly one line and the post-clear well is
// again a canonical state.
//
// Run: npm run gen:fourwide-db

import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Board } from "../src/core/board";
import { PIECE_TYPES, type PieceType } from "../src/core/pieces";
import { enumeratePlacements } from "../src/engine/enumerate";
import {
  WELL_X,
  WELL_W,
  WALL_H,
  wallMask,
  residualKey,
  stateToBoard,
} from "../src/engine/fourwide-core";

const here = dirname(fileURLToPath(import.meta.url));

// DDRKirby's canonical residual list, verbatim: 4 lines top-down, '1' = cell.
// All 28 fit in the bottom 3 rows of the well and the set is mirror-closed.
const DDRKIRBY_STATES = [
  "    \n    \n    \n111 \n",
  "    \n    \n    \n 111\n",
  "    \n    \n1   \n11  \n",
  "    \n    \n   1\n  11\n",
  "    \n    \n11  \n1   \n",
  "    \n    \n  11\n   1\n",
  "    \n1   \n1   \n1   \n",
  "    \n   1\n   1\n   1\n",
  "    \n    \n11  \n 1  \n",
  "    \n    \n  11\n  1 \n",
  "    \n    \n 1  \n11  \n",
  "    \n    \n  1 \n  11\n",
  "    \n    \n    \n11 1\n",
  "    \n    \n    \n1 11\n",
  "    \n    \n1   \n1 1 \n",
  "    \n    \n   1\n 1 1\n",
  "    \n    \n1   \n1  1\n",
  "    \n    \n   1\n1  1\n",
  "    \n    \n 1  \n1  1\n",
  "    \n    \n  1 \n1  1\n",
  "    \n    \n   1\n11  \n",
  "    \n    \n1   \n  11\n",
  "    \n    \n   1\n 11 \n",
  "    \n    \n1   \n 11 \n",
  "    \n    \n   1\n1 1 \n",
  "    \n    \n1   \n 1 1\n",
  "    \n    \n 11 \n1   \n",
  "    \n    \n 11 \n   1\n",
];

/** "    \n    \n1   \n11  \n" -> 12-bit key (bit = row*4+col, row 0 bottom) */
function parseState(s: string): number {
  const lines = s.split("\n").filter((l) => l.length > 0);
  let key = 0;
  for (let i = 0; i < lines.length; i++) {
    const row = lines.length - 1 - i; // bottom-up
    for (let col = 0; col < WELL_W; col++) {
      if (lines[i][col] === "1") {
        key |= 1 << (row * WELL_W + col);
      }
    }
  }
  return key;
}

const stateKeys = DDRKIRBY_STATES.map(parseState);
const keyToIndex = new Map(stateKeys.map((k, i) => [k, i]));
if (keyToIndex.size !== stateKeys.length) {
  throw new Error("duplicate canonical state");
}

interface GenPlacement {
  piece: PieceType;
  rot: number;
  x: number;
  y: number;
  cells: [number, number][];
  spin: string;
  next: number; // index of the post-clear canonical state
}

const states = stateKeys.map((key, idx) => {
  const board = stateToBoard(key);
  const placements: Partial<Record<PieceType, GenPlacement[]>> = {};
  for (const piece of PIECE_TYPES) {
    const cont: GenPlacement[] = [];
    for (const p of enumeratePlacements(board, piece)) {
      if (p.linesCleared === 0) {
        continue;
      }
      if (p.linesCleared !== 1) {
        throw new Error(`state ${idx} ${piece}: cleared ${p.linesCleared}`);
      }
      const nextKey = residualKey(p.after);
      if (nextKey === null) {
        continue;
      }
      const next = keyToIndex.get(nextKey);
      // clears but leaves a non-canonical residual
      if (next === undefined) {
        continue;
      }
      cont.push({
        piece,
        rot: p.rot,
        x: p.x,
        y: p.y,
        cells: p.cells.map(([a, b]) => [a, b] as [number, number]),
        spin: p.spin,
        next,
      });
    }
    if (cont.length > 0) {
      placements[piece] = cont;
    }
  }
  return { key, pattern: DDRKIRBY_STATES[idx].split("\n").filter(Boolean), placements };
});

// sanity: the canonical set must be closed and every state continuable
for (const [i, s] of states.entries()) {
  const pieces = Object.keys(s.placements);
  if (pieces.length === 0) {
    throw new Error(`state ${i} has no continuations`);
  }
}

const out = {
  source: "canonical states: ddrkirby.com/games/4-wide-trainer; placements: engine-derived",
  wellX: WELL_X,
  wellW: WELL_W,
  wallH: WALL_H,
  states,
};

writeFileSync(join(here, "..", "src", "data", "fourwide.json"), JSON.stringify(out));

const nPlacements = states.reduce(
  (n, s) => n + Object.values(s.placements).reduce((m, arr) => m + arr.length, 0),
  0,
);
const scores = states.map((s) => Object.keys(s.placements).length);
console.log(`fourwide.json: ${states.length} states, ${nPlacements} continuations`);
console.log(`continuable pieces per state: min ${Math.min(...scores)} max ${Math.max(...scores)}`);
// sanity that the shared helpers round-trip
const b: Board = stateToBoard(stateKeys[0]);
if (residualKey(b) !== stateKeys[0]) {
  throw new Error("residualKey round-trip failed");
}
if ((b.rows[0] & wallMask()) !== wallMask()) {
  throw new Error("walls missing");
}
