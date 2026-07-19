import { describe, it, expect } from "vitest";
import { genAllspin } from "../src/engine/allspin-gen";
import { Board } from "../src/core/board";
import { Game } from "../src/core/game";
import type { PieceType, Rot } from "../src/core/pieces";

const FALLBACK = ["___X______", "XXX___XXXX", "XXXX_XXXXX"].join("|");

function orient(g: Game, rot: Rot): void {
  if (rot === 1) {
    g.rotate(1);
  } else if (rot === 3) {
    g.rotate(-1);
  } else if (rot === 2) {
    g.rotate(2);
  }
}
function shiftTo(g: Game, x: number): boolean {
  let guard = 20;
  while (g.active && g.active.x < x && guard-- > 0) {
    if (!g.moveRight()) {
      break;
    }
  }
  guard = 20;
  while (g.active && g.active.x > x && guard-- > 0) {
    if (!g.moveLeft()) {
      break;
    }
  }
  return !!g.active && g.active.x === x;
}
// the generator promises a clean spin double with `piece`; reproduce via SRS
function canSpinDouble(board: Board, piece: PieceType): boolean {
  for (let preRot = 0 as Rot; preRot < 4; preRot = (preRot + 1) as Rot) {
    for (let preX = 0; preX < 10; preX++) {
      for (const dir of [1, -1, 2] as const) {
        const g = new Game(1);
        g.reset(board.clone(), 1, [piece]);
        orient(g, preRot);
        if (!shiftTo(g, preX)) {
          continue;
        }
        g.softDropToFloor();
        if (!g.rotate(dir)) {
          continue;
        }
        const ev = g.hardDrop();
        if (ev && ev.spin !== "none" && ev.linesCleared >= 2) {
          return true;
        }
      }
    }
  }
  return false;
}

describe("all-spin generator", () => {
  it("produces a spin-able board (rarely falling back) across many seeds", () => {
    let fallback = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const { board, spinPiece } = genAllspin(seed, (seed & 1) === 1);
      // never hands back a board that is already partly cleared or overflowing
      for (let y = 0; y < 26; y++) {
        expect(board.rows[y] === (1 << 10) - 1).toBe(false);
      }
      expect(board.maxHeight()).toBeLessThanOrEqual(12);
      // the promised spin double actually clears through the real kick tables
      expect(
        canSpinDouble(board, spinPiece),
        `seed ${seed} (${spinPiece}) has no spin double`,
      ).toBe(true);
      if (board.toStrings().join("|") === FALLBACK) {
        fallback++;
      }
    }
    expect(fallback).toBeLessThan(12); // <10% fall back to the canned TSD
  });
});

// live grading of the all-spin mode is done by the real Cold Clear 2 bot -
// see test/cc2.test.ts
