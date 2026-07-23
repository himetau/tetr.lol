// One-off structural diagnosis of a single hand-transcribed board.
//   npx tsx tools/board-diag.ts
import { Board } from "../src/core/board";
import {
  findLstSite,
  volumeGap,
  checkerImbalance,
  stackSideImbalance,
  isLstState,
  lstHoles,
  lstOverhangHeights,
  LST_SPIN_COL,
} from "../src/engine/eval";

// Top-down, X = filled, . = empty. Best-effort read of the image's LOCKED stack
// (the floating T is the active piece and is excluded). EDIT ME to correct.
const GRID = [
  ".........X",
  ".........X",
  ".........X",
  "...XX...XX",
  "...XXXX.XX",
  "XX.XXXXXXX",
  "XX.XXXXXXX",
  "XX.XXXXXXX",
];

const board = Board.fromStrings(GRID);
const heights: number[] = [];
for (let x = 0; x < 10; x++) {
  let h = 0;
  for (let y = board.maxHeight(); y >= 0; y--) if (board.filled(x, y)) { h = y + 1; break; }
  heights.push(h);
}
const site = findLstSite(board);
console.log("grid I read:");
for (const r of board.toStrings(board.maxHeight())) console.log("  " + r.replace(/X/g, "█").replace(/_/g, "·"));
console.log("\nheights per col:", heights.join(" "));
console.log("well col:", LST_SPIN_COL, "  maxHeight:", board.maxHeight());
console.log("findLstSite:", site ? `y${site.y} missing${site.missing}` : "NONE");
console.log("checkerImbalance (whole-board):", checkerImbalance(board));
console.log("stackSideImbalance (theory-correct):", stackSideImbalance(board));
console.log("lstHoles (covered voids):", lstHoles(board), "  <-- the covered-hole verdict");
console.log("isLstState:", isLstState(board));
console.log("volumeGap @site:", site ? volumeGap(board, site.y).toFixed(1) : "n/a");
console.log("overhang L(col1):", lstOverhangHeights(board, LST_SPIN_COL - 1, board.maxHeight()));
console.log("overhang R(col3):", lstOverhangHeights(board, LST_SPIN_COL + 1, board.maxHeight()));
