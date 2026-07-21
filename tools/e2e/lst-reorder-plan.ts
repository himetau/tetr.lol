// Plans the "played the plan's move early" e2e: walk a verified run until a
// point where the NEXT-plus-one plan move is playable right now with the
// piece in hand, and emit the key script that places it manually. The app
// must grade that placement as a plan move (best), not an inaccuracy, and
// watch-book must keep playing afterwards.
//
// Output JSON: { seed, pressB, keys, expectChip, thenExpect }

import { Game, SPAWN_X } from "../../src/core/game";
import { Board } from "../../src/core/board";
import { cellsAt, type PieceType } from "../../src/core/pieces";
import { enumeratePlacements, type Placement } from "../../src/engine/enumerate";
import type { SpinKind } from "../../src/core/spin";
import data from "../../src/data/lst-runs.json";

type Cells = [number, number][];
const ckey = (cs: readonly (readonly [number, number])[]) =>
  cs
    .map(([x, y]) => x * 32 + y)
    .sort((a, b) => a - b)
    .join(",");

function pureDropReaches(board: Board, p: Placement): boolean {
  let y = 20;
  while (!board.collides(cellsAt(p.type, p.rot, p.x, y - 1))) {
    y--;
  }
  return ckey(cellsAt(p.type, p.rot, p.x, y)) === ckey(p.cells);
}

function keysFor(board: Board, p: Placement, useHold: boolean): string[] {
  const keys: string[] = useHold ? ["KeyC"] : [];
  if (!pureDropReaches(board, p)) {
    let prevSd = false;
    for (const m of p.path) {
      if (m === "sd") {
        if (!prevSd) {
          keys.push("ArrowDown");
        }
        prevSd = true;
        continue;
      }
      prevSd = false;
      keys.push(
        m === "left"
          ? "ArrowLeft"
          : m === "right"
            ? "ArrowRight"
            : m === "cw"
              ? "ArrowUp"
              : m === "ccw"
                ? "KeyZ"
                : "KeyA",
      );
    }
  } else {
    if (p.rot === 1) {
      keys.push("ArrowUp");
    } else if (p.rot === 2) {
      keys.push("KeyA");
    } else if (p.rot === 3) {
      keys.push("KeyZ");
    }
    const dx = p.x - SPAWN_X;
    for (let i = 0; i < Math.abs(dx); i++) {
      keys.push(dx < 0 ? "ArrowLeft" : "ArrowRight");
    }
  }
  keys.push("Space");
  return keys;
}

const runs = data.runs as unknown as Record<
  string,
  { piece: string; cells: Cells; spin: string }[]
>;
const seed = process.argv[2] ?? Object.keys(runs)[0];
const moves = runs[seed];
if (!moves) {
  console.error(`no verified run for seed ${seed}`);
  process.exit(1);
}

const game = new Game(Number(seed));
const firstT = moves.findIndex((m) => m.piece === "T");

for (let i = 0; i < moves.length - 1; i++) {
  const nxt = moves[i + 1];
  // loop phase only (the opener grader is target-based already), plain fills
  if (i > firstT && moves[i].piece !== "T" && nxt.piece !== "T") {
    const active = game.active!.type;
    let useHold = false;
    let ok = nxt.piece === active;
    if (!ok && game.canHold) {
      const viaHold = game.hold ?? game.preview()[0];
      if (nxt.piece === viaHold) {
        ok = true;
        useHold = true;
      }
    }
    if (ok) {
      const p = enumeratePlacements(game.board, nxt.piece as PieceType).find(
        (pl) => ckey(pl.cells) === ckey(nxt.cells),
      );
      if (p) {
        console.log(
          JSON.stringify({
            seed,
            pressB: i,
            skipIndex: i + 1,
            keys: keysFor(game.board, p, useHold),
            expectChip: "Plan · queued",
            thenExpect: "Plan",
          }),
        );
        process.exit(0);
      }
    }
  }
  const ev = game.applyMove(
    moves[i].piece as PieceType,
    moves[i].cells,
    moves[i].spin as SpinKind,
  );
  if (!ev) {
    console.error(`replay broke at move ${i}`);
    process.exit(1);
  }
}
console.error("no reorder point found");
process.exit(1);
