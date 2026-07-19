import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { Board } from "../src/core/board";
import type { PieceType } from "../src/core/pieces";
import { bookAdvice, matchesBookMove } from "../src/engine/book";
import { enumeratePlacements } from "../src/engine/enumerate";
import { gradePlacement, type GradeRequest } from "../src/engine/grade";
import { TKI_TARGETS } from "../src/engine/opener";
import { findLstSite } from "../src/engine/eval";
import coverData from "../src/data/lst-cover.json";
import lstPatterns from "../src/data/lst-patterns.json";

const bag2Group = coverData.groups.find((g) => g.name === "flattop LST bag 2")!;

function boardFrom(rows: string[]): Board {
  return Board.fromStrings(rows.map((r) => r.replace(/[A-WYZa-z]/g, "X")));
}

const MIRROR: Record<string, string> = { I: "I", O: "O", T: "T", S: "Z", Z: "S", J: "L", L: "J" };

describe("lst cover book", () => {
  it("bag-1 advice from an empty board parks the leading T", () => {
    const adv = bookAdvice(new Board(), "TILJSZO".split("") as PieceType[], null);
    expect(adv.onBook).toBe(true);
    expect(adv.sustainable).toBe(true);
    expect(adv.moves).toHaveLength(0); // T has no build placement yet
    expect(adv.holdIsBook).toBe(true);
  });

  it("suggests each placement while following a bag-2 solution", () => {
    const sol = bag2Group.solutions[0];
    const board = boardFrom(bag2Group.start);
    // feed pieces in the fumen's own order; T arrives last so hold stays free
    const order = sol.placements.map((p) => p.piece) as PieceType[];
    for (let i = 0; i < order.length; i++) {
      const queue = [...order.slice(i), "T"] as PieceType[];
      const adv = bookAdvice(board, queue, null);
      expect(adv.onBook).toBe(true);
      expect(adv.sustainable).toBe(true);
      const next = sol.placements[i];
      expect(matchesBookMove(adv, next.piece as PieceType, next.cells as [number, number][])).toBe(
        true,
      );
      board.place(next.cells as [number, number][]);
      board.clearLines();
    }
  });

  it("never calls a queue unsustainable that sfinder covers (bag 1)", () => {
    const csv = readFileSync(
      join(__dirname, "..", "tools", "data", "cover", "flattop LST bag 1 cover.csv"),
      "utf8",
    )
      .trim()
      .split("\n");
    const rows = csv.slice(2).map((l) => l.split(","));
    const byQueue = new Map(rows.map((r) => [r[0], r.slice(1).some((c) => c.trim() === "O")]));
    let optimistic = 0;
    const SAMPLE = 120;
    for (let i = 0; i < SAMPLE; i++) {
      const [queue, direct] = rows[Math.floor((i * rows.length) / SAMPLE)];
      const sfinderOk = Boolean(direct) && byQueue.get(queue) === true;
      const mirrorOk =
        byQueue.get(
          queue
            .split("")
            .map((c) => MIRROR[c])
            .join(""),
        ) === true;
      const mine = bookAdvice(new Board(), queue.split("") as PieceType[], null).sustainable;
      if (!mine) {
        // pessimism would produce false "loop is dead" verdicts - never allowed
        expect(sfinderOk || mirrorOk).toBe(false);
      } else if (!sfinderOk && !mirrorOk) {
        optimistic++; // permissible: any-order + SRS+ kicks beat sfinder's model
      }
    }
    expect(optimistic).toBeLessThan(SAMPLE * 0.15);
  });

  it("chains from a four.lol TKI opener into the bag-2 book", () => {
    // build each TKI book target, T-spin-double it, and require that at least
    // one resulting board is a bag-2 book start - otherwise the book would
    // never activate in real play
    const starts = new Set<string>();
    const startBoard = boardFrom(bag2Group.start);
    starts.add(startBoard.key());
    const mirrored = new Board();
    for (let y = 0; y < 26; y++) {
      for (let x = 0; x < 10; x++) {
        if ((startBoard.rows[y] >>> x) & 1) {
          mirrored.rows[y] |= 1 << (9 - x);
        }
      }
    }
    starts.add(mirrored.key());

    const chained: string[] = [];
    for (const target of TKI_TARGETS) {
      const board = boardFrom(target.rows);
      // "Using TKI"/follow-up shapes already contain the TSD T (full rows)
      const cleared = board.clone();
      if (cleared.clearLines().length >= 2 && starts.has(cleared.key())) {
        chained.push(target.name);
      }
      // pre-T shapes: the TSD is still to be played
      for (const p of enumeratePlacements(board, "T")) {
        if (p.spin === "full" && p.linesCleared >= 2 && starts.has(p.after.key())) {
          chained.push(target.name);
        }
      }
    }
    expect(chained.length).toBeGreaterThan(0);
  });

  it("grades a book move as best and a deviation with a book hint", () => {
    // solutions[0] (impcross) has a gravity-legal fumen order, so its first
    // placement is immediately playable; fumen order is NOT legal in general
    const sol = bag2Group.solutions[0];
    const rows = boardFrom(bag2Group.start).rows;
    const order = sol.placements.map((p) => p.piece) as PieceType[];
    const first = sol.placements[0];
    const base: Omit<GradeRequest, "userCells" | "userPiece" | "userRot" | "userX" | "userY"> = {
      rows: Array.from(rows),
      queue: [...order, "T"].slice(0, 6) as PieceType[],
      hold: null,
      userSpin: "none",
      userLines: 0,
      usedHold: false,
      pieceIndex: 7,
      lstBias: true,
    };

    // the book placement for the first piece, located among real placements
    const board = boardFrom(bag2Group.start);
    const key = (cs: [number, number][]) =>
      cs
        .map(([x, y]) => x * 32 + y)
        .sort((a, b) => a - b)
        .join(",");
    const bookPlacement = enumeratePlacements(board, first.piece as PieceType).find(
      (p) => key(p.cells as [number, number][]) === key(first.cells as [number, number][]),
    )!;
    expect(bookPlacement).toBeDefined();

    const good = gradePlacement({
      ...base,
      userCells: bookPlacement.cells as [number, number][],
      userPiece: bookPlacement.type,
      userRot: bookPlacement.rot,
      userX: bookPlacement.x,
      userY: bookPlacement.y,
      userSpin: bookPlacement.spin,
      userLines: bookPlacement.linesCleared,
    });
    expect(good.book?.userMatched).toBe(true);
    expect(good.grade).toBe("best");
    expect(good.reasons[0]).toMatch(/^Book move/);

    // a legal but non-book placement of the same piece
    const stray = enumeratePlacements(board, first.piece as PieceType).find(
      (p) => key(p.cells as [number, number][]) !== key(first.cells as [number, number][]),
    )!;
    const bad = gradePlacement({
      ...base,
      userCells: stray.cells as [number, number][],
      userPiece: stray.type,
      userRot: stray.rot,
      userX: stray.x,
      userY: stray.y,
      userSpin: stray.spin,
      userLines: stray.linesCleared,
    });
    expect(bad.book?.userMatched).toBe(false);
    expect(bad.grade).not.toBe("best");
    expect(bad.reasons.some((r) => r.startsWith("Book"))).toBe(true);
  });

  it(
    "never grades a loop-keeping TSD worse than good (four.lol corpus)",
    { timeout: 30000 },
    () => {
      // the loop's mandatory TSD used to be flagged as "destroyed your T-spin
      // slot" / "moved away from the next TSD" - self-defeating for LST
      const queue = ["T", "I", "J", "Z", "S", "L"] as PieceType[];
      let checked = 0;
      for (const section of (lstPatterns as any).lst) {
        for (const pat of section.patterns) {
          for (const page of pat.pages) {
            const rows: string[] = page.rows;
            if (!rows.length || rows.length > 7) {
              continue;
            }
            const board = boardFrom(rows);
            for (const p of enumeratePlacements(board, "T")) {
              if (p.spin !== "full" || p.linesCleared < 2 || !findLstSite(p.after)) {
                continue;
              }
              const r = gradePlacement({
                rows: Array.from(board.rows),
                queue,
                hold: null,
                userCells: p.cells as [number, number][],
                userPiece: "T",
                userRot: p.rot,
                userX: p.x,
                userY: p.y,
                userSpin: p.spin,
                userLines: p.linesCleared,
                usedHold: false,
                pieceIndex: 14,
                lstBias: true,
              });
              checked++;
              expect(
                ["best", "good"],
                `${section.heading}: TSD graded ${r.grade} (${r.reasons.join("; ")})`,
              ).toContain(r.grade);
            }
          }
        }
      }
      expect(checked).toBeGreaterThan(10);
    },
  );
});
