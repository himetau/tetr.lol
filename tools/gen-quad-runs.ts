// Harvest verified LST+quad lines into a pool. Unlike gen-lst-runs (which only
// keeps seeds that hit the full 20-TSD target), this keeps every seed's BEST
// clean line - quad drains mean almost every seed yields a long, goal-legal
// line, so the pool fills fast. Each saved line replays through a real Game
// with every goal rule (no wasted T, no I partial clear, no B2B break, no hole).
//
//   npx tsx tools/gen-quad-runs.ts [maxSeeds] [first] [last] [target] [budgetMs] [minClears]

import { writeFileSync, readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Game } from "../src/core/game";
import { planOpener } from "../src/engine/opener";
import {
  solveLstRun,
  exportSolveCache,
  importSolveCache,
  solveCacheSize,
} from "../src/engine/lst-solver";
import { lstHoles } from "../src/engine/eval";

const maxSeeds = Number(process.argv[2] ?? 10);
const first = Number(process.argv[3] ?? 1);
const last = Number(process.argv[4] ?? 400);
const target = Number(process.argv[5] ?? 50);
const budgetMs = Number(process.argv[6] ?? 30000);
const minClears = Number(process.argv[7] ?? 14);

interface RunMove {
  piece: string;
  cells: [number, number][];
  spin: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "src", "data", "lst-quad-runs.json");

// persistent solve cache: re-scans (or overlapping ranges) reuse solved lines
// instantly instead of re-searching for 30s each
const cachePath = join(here, "data", "solve-cache.json");
if (existsSync(cachePath)) {
  importSolveCache(readFileSync(cachePath, "utf8"));
  console.log(`loaded solve cache: ${solveCacheSize()} entries`);
}
function saveCache(): void {
  writeFileSync(cachePath, exportSolveCache());
}

interface Pool {
  target: number;
  note: string;
  runs: Record<string, RunMove[]>;
  stats: Record<string, { clears: number; tsds: number; quads: number }>;
}
const pool: Pool = existsSync(outPath)
  ? JSON.parse(readFileSync(outPath, "utf8"))
  : { target, note: "", runs: {}, stats: {} };
pool.runs ??= {};
pool.stats ??= {};

function save(): void {
  pool.target = target;
  pool.note =
    "Verified LST+quad watch-book lines (tools/gen-quad-runs.ts): best clean, goal-legal line per seed (TSDs + well quads, no wasted T). Replays from a fresh Game(seed).";
  writeFileSync(outPath, JSON.stringify(pool));
}

for (let seed = first; seed <= last && Object.keys(pool.runs).length < maxSeeds; seed++) {
  if (pool.runs[String(seed)]) continue;

  const game = new Game(seed);
  const plan = planOpener([game.active!.type, ...game.peekQueue(9)]);
  if (!plan) {
    console.log(`seed ${seed}: no opener plan`);
    continue;
  }
  const line: RunMove[] = [];
  let tsds = 0;
  let bad = "";
  for (const mv of plan.moves) {
    const ev = game.applyMove(mv.piece, mv.cells, mv.spin);
    if (!ev) {
      bad = "opener unreachable";
      break;
    }
    line.push({ piece: mv.piece, cells: mv.cells, spin: mv.spin });
    if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) tsds++;
  }
  if (bad || tsds === 0) {
    console.log(`seed ${seed}: opener failed (${bad || "no TSD"})`);
    continue;
  }

  const queue = [game.active!.type, ...game.peekQueue(target * 9 + 20)];
  const t0 = Date.now();
  const res = solveLstRun(game.board, queue, game.hold, target - tsds, {
    budgetMs,
    nodeBudget: 200_000_000,
    tailFree: 3,
    allowQuad: true,
  });
  const ms = Date.now() - t0;
  saveCache(); // persist the freshly solved line for future scans
  if (!res || res.moves.length === 0) {
    console.log(`seed ${seed}: no line (${ms}ms)`);
    continue;
  }

  // replay the (possibly partial) best line, enforcing every goal rule
  let quads = 0;
  let violation = "";
  for (const m of res.moves) {
    if (game.board.key() !== m.beforeKey) {
      violation = "desync";
      break;
    }
    const ev = game.applyMove(m.piece, m.cells, m.spin);
    if (!ev) {
      violation = `unreachable ${m.piece}`;
      break;
    }
    if (ev.piece === "T" && !(ev.spin === "full" && ev.linesCleared >= 2)) {
      violation = "wasted T";
      break;
    }
    if (ev.piece === "I" && ev.linesCleared > 0 && ev.linesCleared < 4) {
      violation = "I partial";
      break;
    }
    if (ev.linesCleared > 0 && ev.linesCleared < 4 && ev.spin === "none") {
      violation = "B2B break";
      break;
    }
    if (lstHoles(game.board) > 0) {
      violation = "hole";
      break;
    }
    line.push({ piece: m.piece, cells: m.cells.map(([a, b]) => [a, b] as [number, number]), spin: m.spin });
    if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) tsds++;
    else if (ev.piece === "I" && ev.linesCleared === 4) quads++;
  }
  const clears = tsds + quads;
  if (violation) {
    console.log(`seed ${seed}: VIOLATION ${violation} at ${clears} clears (${ms}ms)`);
    continue;
  }
  if (clears < minClears) {
    console.log(`seed ${seed}: only ${clears} clears < ${minClears} min (${ms}ms) - skip`);
    continue;
  }
  pool.runs[String(seed)] = line;
  pool.stats[String(seed)] = { clears, tsds, quads };
  save();
  console.log(
    `seed ${seed}: KEPT ${clears} clears (TSD=${tsds} quad=${quads}) ${ms}ms  [pool=${Object.keys(pool.runs).length}]`,
  );
}
console.log(`done: pool has ${Object.keys(pool.runs).length} seeds`);
