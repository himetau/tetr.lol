// Every seed the quad drill deals (?quad=1) must replay clean and goal-legal:
// no wasted T, no partial I clear, no B2B break, no hole - and it must land the
// exact clear count recorded in stats. This guards the pool the same way
// gen-quad-runs verifies at harvest time, so a bad seed or an eval change can't
// silently ship a broken line.

import { describe, it, expect } from "vitest";
import { Game } from "../src/core/game";
import type { PieceType } from "../src/core/pieces";
import type { SpinKind } from "../src/core/spin";
import { lstHoles } from "../src/engine/eval";
import { planOpener } from "../src/engine/opener";
import LST_QUAD_RUNS from "../src/data/lst-quad-runs.json";

type Move = { piece: string; cells: [number, number][]; spin: string };
const runs = LST_QUAD_RUNS.runs as unknown as Record<string, Move[]>;
const stats = LST_QUAD_RUNS.stats as unknown as Record<
  string,
  { clears: number; tsds: number; quads: number }
>;
const seeds = Object.keys(runs);

describe("quad drill pool is clean and goal-legal", () => {
  it("deals at least the starter seeds", () => {
    expect(seeds.length).toBeGreaterThanOrEqual(10);
  });

  for (const seed of seeds) {
    it(`seed ${seed} replays clean (${stats[seed].clears} clears, no wasted T / hole / B2B break)`, () => {
      const game = new Game(Number(seed));
      // the TKI opener legitimately has covered cells mid-construction; the
      // no-hole invariant applies to the loop, so gate it past the opener (the
      // harvester does the same - it only hole-checks the solver's loop moves).
      const openerLen = planOpener([game.active!.type, ...game.peekQueue(9)])?.moves.length ?? 0;
      let tsds = 0;
      let quads = 0;
      runs[seed].forEach((m, i) => {
        const ev = game.applyMove(m.piece as PieceType, m.cells, m.spin as SpinKind);
        expect(ev, `${m.piece} unreachable`).not.toBeNull();
        if (ev!.piece === "T") {
          // a T is only ever spent on a TSD - never wasted
          expect(ev!.spin, "T is a full spin").toBe("full");
          expect(ev!.linesCleared, "T clears two").toBeGreaterThanOrEqual(2);
          tsds++;
        }
        if (ev!.piece === "I" && ev!.linesCleared > 0) {
          // an I only ever clears as a well quad, never a partial line clear
          expect(ev!.linesCleared, "I clears four or none").toBe(4);
          quads++;
        }
        // no non-spin, non-quad clear (would break back-to-back)
        if (ev!.linesCleared > 0 && ev!.linesCleared < 4) {
          expect(ev!.spin, "loop clears keep B2B").not.toBe("none");
        }
        if (i >= openerLen) {
          expect(lstHoles(game.board), "no covered hole outside the spin cols").toBe(0);
        }
      });
      // whatever the opener did, the finished line is hole-free
      expect(lstHoles(game.board), "final board hole-free").toBe(0);
      expect(tsds, "recorded TSD count").toBe(stats[seed].tsds);
      expect(quads, "recorded quad count").toBe(stats[seed].quads);
      expect(tsds + quads, "recorded clear count").toBe(stats[seed].clears);
    });
  }
});
