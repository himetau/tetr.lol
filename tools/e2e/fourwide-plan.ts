// Plans a keyboard script for the 4-wide drill e2e drive: follow the combo
// book for a stretch (with one deliberate combo-breaking deviation + undo).
// Prints JSON steps for tools/e2e/fourwide-drive.mjs.

import { Game, SPAWN_X } from "../../src/core/game";
import { Board } from "../../src/core/board";
import { cellsAt, type PieceType } from "../../src/core/pieces";
import { enumeratePlacements, type Placement } from "../../src/engine/enumerate";
import { buildFourwideStart, fourwideAdvice, refillWalls } from "../../src/engine/fourwide";

type Cells = [number, number][];
const key = (cs: Cells) =>
  cs
    .map(([x, y]) => x * 32 + y)
    .sort((a, b) => a - b)
    .join(",");

interface Step {
  keys: string[];
  desc: string;
  expect?: string;
  combo?: number;
}

function pureDropReaches(board: Board, p: Placement): boolean {
  let y = 20;
  while (!board.collides(cellsAt(p.type, p.rot, p.x, y - 1))) {
    y--;
  }
  return key(cellsAt(p.type, p.rot, p.x, y) as Cells) === key(p.cells as Cells);
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

function findPlacement(board: Board, piece: PieceType, cells: Cells): Placement | null {
  return (
    enumeratePlacements(board, piece).find((p) => key(p.cells as Cells) === key(cells)) ?? null
  );
}

// ---- pick a seed whose visible queue sustains a long book line ----
let seed = 0;
for (let s = 1; s < 60; s++) {
  const g = new Game();
  g.reset(buildFourwideStart(s).board, s);
  const adv = fourwideAdvice(
    g.board,
    [g.active!.type, ...g.preview()] as PieceType[],
    null,
    g.pieceIndex,
  );
  if (adv.sustainable && adv.moves.length > 0 && !adv.moves[0].usesHold) {
    seed = s;
    break;
  }
}
if (!seed) {
  throw new Error("no sustainable seed found");
}

const steps: Step[] = [];
const sim = new Game();
sim.reset(buildFourwideStart(seed).board, seed);

const doPlacement = (
  piece: PieceType,
  cells: Cells,
  desc: string,
  expect?: string,
  combo?: number,
) => {
  let useHold = false;
  if (sim.active!.type !== piece) {
    useHold = true;
    sim.holdPiece();
    if (sim.active!.type !== piece) {
      throw new Error(`sim desync at "${desc}": want ${piece}, active ${sim.active!.type}`);
    }
  }
  const p = findPlacement(sim.board, piece, cells);
  if (!p) {
    throw new Error(`unreachable ${piece} at "${desc}"`);
  }
  steps.push({ keys: keysFor(sim.board, p, useHold), desc, expect, combo });
  sim.active!.rot = p.rot;
  sim.active!.x = p.x;
  sim.active!.y = p.y;
  const ev = sim.hardDrop();
  if (!ev || key(ev.cells as Cells) !== key(cells)) {
    throw new Error(`sim landed wrong at "${desc}"`);
  }
  refillWalls(sim.board); // the view does this after every 4-wide lock
};

let combo = 0;
let deviated = false;
let doomShown = false;
let placed = 0;
let guard = 0;
while (placed < 7 && guard++ < 24) {
  const queue = [sim.active!.type, ...sim.preview()] as PieceType[];
  const adv = fourwideAdvice(sim.board, queue, sim.hold, sim.pieceIndex);
  if (!adv.onBook) {
    throw new Error(`sim off book at piece ${placed}`);
  }
  if (adv.moves.length === 0) {
    if (sim.hold !== null) {
      steps.push({
        keys: [],
        desc: `no continuation with hold occupied at piece ${placed} - plan ends`,
      });
      break;
    }
    steps.push({ keys: ["KeyC"], desc: `park ${sim.active!.type} in hold (no continuation)` });
    sim.holdPiece();
    continue;
  }
  const mv = adv.moves.find((m) => !m.usesHold && m.score >= adv.moves[0].score) ?? adv.moves[0];
  // a clearing move for the active piece that survives yet leaves a line the
  // preview can't sustain -> "Combo will be lost" mistake, then undo
  if (!doomShown && adv.moves[0].score >= queue.length) {
    const doom = adv.moves.find(
      (m) => !m.usesHold && m.piece === sim.active!.type && m.score < queue.length,
    );
    if (doom) {
      doomShown = true;
      const p = findPlacement(sim.board, doom.piece, doom.cells as Cells)!;
      steps.push({
        keys: keysFor(sim.board, p, false),
        desc: `doom: ${doom.piece} clears but loses the combo in ${doom.score}`,
        expect: "Combo will be lost",
      });
      steps.push({ keys: ["Escape", "Ctrl+KeyZ"], desc: "dismiss + undo the doomed clear", combo });
    }
  }
  if (!deviated && placed >= 2) {
    deviated = true;
    // deliberate combo breaker: stack the active piece without clearing
    const stray = enumeratePlacements(sim.board, sim.active!.type)
      .filter((p) => p.linesCleared === 0)
      .sort((a, b) => b.y - a.y)[0];
    if (stray) {
      steps.push({
        keys: keysFor(sim.board, stray, false),
        desc: `deviation: ${stray.type} stacked without clearing`,
        expect: "Combo breaker",
      });
      steps.push({
        keys: ["Escape", "Ctrl+KeyZ"],
        desc: "dismiss + undo the combo breaker",
        combo,
      });
      // sim never applies it: the app's undo restores this exact state
    }
  }
  combo++;
  doPlacement(
    mv.piece,
    mv.cells as Cells,
    `book ${mv.piece}${mv.usesHold ? " (hold)" : ""} #${placed}`,
    "Book · 4-wide",
    combo,
  );
  placed++;
}
if (placed < 3) {
  throw new Error(`plan too short: ${placed} placements`);
}

console.error(`seed ${seed}: ${placed} book placements, final combo ${combo}`);
console.log(JSON.stringify({ seed, steps }, null, 1));
