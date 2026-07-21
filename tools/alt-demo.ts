// Demonstrates the health-based grader: at a mid-loop decision on a verified
// seed, grade (a) the plan move, (b) several VALID alternative placements, and
// (c) a genuinely damaging move - showing the grader now accepts alternatives
// instead of scolding everything off the one line.
//   npx tsx tools/alt-demo.ts [seed]

import { Game } from "../src/core/game";
import { enumeratePlacements } from "../src/engine/enumerate";
import { gradePlacement, type GradeRequest } from "../src/engine/grade";
import { lstHoles, findLstSite } from "../src/engine/eval";
import type { PieceType } from "../src/core/pieces";
import type { SpinKind } from "../src/core/spin";
import runs from "../src/data/lst-runs.json";

const seed = process.argv[2] ?? "10";
const line = (runs as any).runs[seed] as {
  piece: PieceType;
  cells: [number, number][];
  spin: SpinKind;
}[];
if (!line) throw new Error(`no verified run for seed ${seed}`);

const key = (cs: readonly (readonly [number, number])[]) =>
  cs.map(([x, y]) => x * 32 + y).sort((a, b) => a - b).join(",");

// pick decision points where the plan plays the ACTIVE piece (no hold) and
// several distinct legal placements of it exist
function gradeAt(k: number): boolean {
  const game = new Game(Number(seed));
  for (let i = 0; i < k; i++) {
    const m = line[i];
    if (!game.applyMove(m.piece, m.cells, m.spin)) return false;
  }
  if (!game.active) return false;
  const plan = line[k];
  if (plan.piece !== game.active.type) return false; // skip hold decisions for clarity
  const board = game.board;
  const placements = enumeratePlacements(board, game.active.type);
  const planPl = placements.find((p) => key(p.cells) === key(plan.cells));
  if (!planPl) return false;
  const alts = placements.filter((p) => key(p.cells) !== key(plan.cells));
  if (alts.length < 3) return false;

  const base: Omit<GradeRequest, "userCells" | "userPiece" | "userRot" | "userX" | "userY" | "userSpin" | "userLines"> = {
    rows: Array.from(board.rows),
    queue: [game.active.type, ...game.preview()] as PieceType[],
    hold: game.hold,
    usedHold: false,
    pieceIndex: k,
    lstBias: true,
    planActive: true,
    planMovePiece: plan.piece as PieceType,
    planMoveCells: plan.cells,
  };
  const grade = (p: (typeof placements)[number], onPlan: boolean) =>
    gradePlacement({
      ...base,
      userOnPlan: onPlan,
      userCells: p.cells.map(([a, b]) => [a, b] as [number, number]),
      userPiece: p.type,
      userRot: p.rot,
      userX: p.x,
      userY: p.y,
      userSpin: p.spin,
      userLines: p.linesCleared,
    });

  console.log(`\n===== seed ${seed}, decision #${k}: piece ${game.active.type}, well=col2 =====`);
  const pg = grade(planPl, true);
  console.log(`  PLAN move           -> ${pad(pg.grade)} | ${pg.reasons[0] ?? "(no note)"}`);

  // rank alternatives by how "clean" they leave the board, show the top few
  const scored = alts
    .map((p) => ({ p, holes: lstHoles(p.after), site: findLstSite(p.after) ? 1 : 0 }))
    .sort((a, b) => b.site - a.site || a.holes - b.holes);
  let shownGood = 0;
  for (const { p } of scored) {
    if (shownGood >= 4) break;
    const g = grade(p, false);
    const cols = p.cells.map(([x]) => x + 1);
    console.log(
      `  alt ${p.type} col ${Math.min(...cols)}-${Math.max(...cols)}  -> ${pad(g.grade)} | ${g.reasons[0] ?? "(clean)"}`,
    );
    shownGood++;
  }
  // a deliberately damaging move: the one that buries the most cells / kills site
  const worst = alts
    .map((p) => ({ p, holes: lstHoles(p.after), site: findLstSite(p.after) ? 1 : 0 }))
    .sort((a, b) => a.site - b.site || b.holes - a.holes)[0];
  if (worst) {
    const g = grade(worst.p, false);
    const cols = worst.p.cells.map(([x]) => x + 1);
    console.log(
      `  BAD ${worst.p.type} col ${Math.min(...cols)}-${Math.max(...cols)}  -> ${pad(g.grade)} | ${g.reasons[0] ?? "(no note)"}`,
    );
  }
  return true;
}

function pad(s: string) {
  return s.padEnd(10);
}

let shown = 0;
for (let k = 12; k < line.length - 2 && shown < 5; k++) {
  if (gradeAt(k)) shown++;
}
