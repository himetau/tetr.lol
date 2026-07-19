import { describe, it, expect, afterEach } from "vitest";
import { Board } from "../src/core/board";
import { evaluateBoard, lstFeatureVector } from "../src/engine/eval";
import { neuralValue, neuralEnabled, setNeuralBlend } from "../src/engine/neural";

afterEach(() => setNeuralBlend(1));

describe("learned evaluator", () => {
  it("is trained and produces bounded, finite corrections", () => {
    expect(neuralEnabled()).toBe(true);
    const boards = [
      Board.fromStrings(["_______X__", "X__XX_XXXX"]),
      Board.fromStrings(["XX________", "X___XXXXXX", "XX_XXXXXXX"]),
      Board.fromStrings(["_______X__", "X_XXX_XXXX"]),
      new Board(),
    ];
    for (const b of boards) {
      const v = neuralValue(lstFeatureVector(b));
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThan(1500); // residual scale, clipped in training
    }
  });

  it("blend 0 is a strict no-op on evaluation", () => {
    const b = Board.fromStrings(["_______X__", "X__XX_XXXX"]);
    setNeuralBlend(0);
    const off = evaluateBoard(b, true).score;
    setNeuralBlend(1);
    const on = evaluateBoard(b, true).score;
    expect(on - off).toBeCloseTo(neuralValue(lstFeatureVector(b)), 6);
    setNeuralBlend(0);
    expect(neuralValue(lstFeatureVector(b))).toBe(0);
  });

  it("does not overturn the heuristic on loop life-and-death", () => {
    // dead loop (plugged spin column) must still evaluate below the alive one
    const alive = Board.fromStrings(["_______X__", "X__XX_XXXX"]);
    const dead = Board.fromStrings(["_______X__", "X_XXX_XXXX"]);
    expect(evaluateBoard(dead, true).score).toBeLessThan(evaluateBoard(alive, true).score);
  });
});
