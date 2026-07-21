// Parallel quad-pool harvester. Growing the pool one seed at a time is CPU-bound
// and single-threaded (~30s/seed); this fans it out across cores. The orchestrator
// forks N worker copies of itself, each scanning a STRIDED, disjoint slice of the
// seed range (worker k does seeds first+k, first+k+N, ...) into its OWN shard file,
// then merges the shards into src/data/lst-quad-runs.json. No shared-file race:
// workers write disjoint files and never touch the persistent solve cache (new
// seeds miss it anyway). Every kept line is replay-verified against a real Game,
// exactly like gen-quad-runs, so test/lst-quad-pool.test.ts stays green.
//
//   npx tsx tools/pool-parallel.ts [total=100] [budgetMs=30000] [first=42] [span=700] [minClears=14] [shards=10]
//
// (internal) worker form:
//   npx tsx tools/pool-parallel.ts --worker <outFile> <first> <last> <stride> <offset> <target> <budgetMs> <minClears> <maxKeep>

import { spawn } from "child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Game } from "../src/core/game";
import { planOpener } from "../src/engine/opener";
import { solveLstRun } from "../src/engine/lst-solver";
import { lstHoles } from "../src/engine/eval";
import type { PieceType } from "../src/core/pieces";

const here = dirname(fileURLToPath(import.meta.url));
const selfPath = fileURLToPath(import.meta.url);
const outPath = join(here, "..", "src", "data", "lst-quad-runs.json");
const shardDir = join(here, "data", "quad-shards");

interface RunMove {
  piece: string;
  cells: [number, number][];
  spin: string;
}
interface Stat {
  clears: number;
  tsds: number;
  quads: number;
}
interface Pool {
  target: number;
  note: string;
  runs: Record<string, RunMove[]>;
  stats: Record<string, Stat>;
}

/** Solve + replay-verify one seed. Returns the kept line or null (skip). */
function harvestSeed(
  seed: number,
  target: number,
  budgetMs: number,
  minClears: number,
): { line: RunMove[]; stat: Stat } | null {
  const game = new Game(seed);
  const plan = planOpener([game.active!.type, ...game.peekQueue(9)]);
  if (!plan) return null;
  const line: RunMove[] = [];
  let tsds = 0;
  for (const mv of plan.moves) {
    const ev = game.applyMove(mv.piece, mv.cells, mv.spin);
    if (!ev) return null;
    line.push({ piece: mv.piece, cells: mv.cells, spin: mv.spin });
    if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) tsds++;
  }
  if (tsds === 0) return null;

  const queue = [game.active!.type, ...game.peekQueue(target * 9 + 20)] as PieceType[];
  const res = solveLstRun(game.board, queue, game.hold, target - tsds, {
    budgetMs,
    nodeBudget: 200_000_000,
    tailFree: 3,
    allowQuad: true,
  });
  if (!res || res.moves.length === 0) return null;

  let quads = 0;
  for (const m of res.moves) {
    if (game.board.key() !== m.beforeKey) return null; // desync
    const ev = game.applyMove(m.piece, m.cells, m.spin);
    if (!ev) return null; // unreachable
    if (ev.piece === "T" && !(ev.spin === "full" && ev.linesCleared >= 2)) return null; // wasted T
    if (ev.piece === "I" && ev.linesCleared > 0 && ev.linesCleared < 4) return null; // I partial
    if (ev.linesCleared > 0 && ev.linesCleared < 4 && ev.spin === "none") return null; // B2B break
    if (lstHoles(game.board) > 0) return null; // hole
    line.push({ piece: m.piece, cells: m.cells.map(([a, b]) => [a, b] as [number, number]), spin: m.spin });
    if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) tsds++;
    else if (ev.piece === "I" && ev.linesCleared === 4) quads++;
  }
  const clears = tsds + quads;
  if (clears < minClears) return null;
  return { line, stat: { clears, tsds, quads } };
}

function runWorker(): void {
  const [outFile, firstS, lastS, strideS, offsetS, targetS, budgetS, minS, maxKeepS] =
    process.argv.slice(3);
  const first = Number(firstS);
  const last = Number(lastS);
  const stride = Number(strideS);
  const offset = Number(offsetS);
  const target = Number(targetS);
  const budgetMs = Number(budgetS);
  const minClears = Number(minS);
  const maxKeep = Number(maxKeepS);

  const shard: { runs: Record<string, RunMove[]>; stats: Record<string, Stat> } = {
    runs: {},
    stats: {},
  };
  const flush = () => writeFileSync(outFile, JSON.stringify(shard));
  flush();

  let kept = 0;
  for (let seed = first + offset; seed <= last && kept < maxKeep; seed += stride) {
    const t0 = Date.now();
    const r = harvestSeed(seed, target, budgetMs, minClears);
    const ms = Date.now() - t0;
    if (r) {
      shard.runs[String(seed)] = r.line;
      shard.stats[String(seed)] = r.stat;
      kept++;
      flush();
      console.log(
        `[w${offset}] seed ${seed}: KEPT ${r.stat.clears} (T=${r.stat.tsds} Q=${r.stat.quads}) ${ms}ms  [${kept}/${maxKeep}]`,
      );
    } else {
      console.log(`[w${offset}] seed ${seed}: skip ${ms}ms`);
    }
  }
  console.log(`[w${offset}] done: kept ${kept}`);
}

async function runOrchestrator(): Promise<void> {
  const total = Number(process.argv[2] ?? 100);
  const budgetMs = Number(process.argv[3] ?? 30000);
  const first = Number(process.argv[4] ?? 42);
  const span = Number(process.argv[5] ?? 700);
  const minClears = Number(process.argv[6] ?? 14);
  const shards = Number(process.argv[7] ?? 10);
  const last = first + span;
  const target = 50; // never "solved"; the budget is the real cap

  const pool: Pool = existsSync(outPath)
    ? JSON.parse(readFileSync(outPath, "utf8"))
    : { target, note: "", runs: {}, stats: {} };
  pool.runs ??= {};
  pool.stats ??= {};
  const have = Object.keys(pool.runs).length;
  const needed = total - have;
  if (needed <= 0) {
    console.log(`pool already has ${have} >= ${total}; nothing to do`);
    return;
  }
  // per-shard cap with headroom so we reach the target even with uneven keep
  // rates (overshoot is fine - more verified seeds is pure upside)
  const maxKeep = Math.ceil(needed / shards) + 2;
  console.log(
    `orchestrator: have ${have}, need ${needed} -> ${shards} workers x maxKeep ${maxKeep}, seeds ${first}..${last} (stride ${shards}), ${budgetMs}ms/seed`,
  );

  rmSync(shardDir, { recursive: true, force: true });
  mkdirSync(shardDir, { recursive: true });

  const children = Array.from({ length: shards }, (_, k) => {
    const outFile = join(shardDir, `shard-${k}.json`);
    const args = [
      "tsx",
      selfPath,
      "--worker",
      outFile,
      String(first),
      String(last),
      String(shards),
      String(k),
      String(target),
      String(budgetMs),
      String(minClears),
      String(maxKeep),
    ];
    const child = spawn("npx", args, { stdio: "inherit" });
    return new Promise<void>((resolve) => child.on("exit", () => resolve()));
  });
  await Promise.all(children);

  // merge every shard into the pool (disjoint seeds, so union; skip any seed
  // already present just in case)
  let added = 0;
  for (const f of readdirSync(shardDir)) {
    if (!f.endsWith(".json")) continue;
    const s = JSON.parse(readFileSync(join(shardDir, f), "utf8")) as {
      runs: Record<string, RunMove[]>;
      stats: Record<string, Stat>;
    };
    for (const seed of Object.keys(s.runs)) {
      if (pool.runs[seed]) continue;
      pool.runs[seed] = s.runs[seed];
      pool.stats[seed] = s.stats[seed];
      added++;
    }
  }
  pool.target = target;
  pool.note =
    "Verified LST+quad watch-book lines (tools/pool-parallel.ts / gen-quad-runs.ts): best clean, goal-legal line per seed (TSDs + well quads, no wasted T). Replays from a fresh Game(seed).";
  writeFileSync(outPath, JSON.stringify(pool));

  const seeds = Object.keys(pool.runs);
  const clears = seeds.map((k) => pool.stats[k].clears);
  console.log(
    `\nmerged: +${added} -> ${seeds.length} seeds. clears ${Math.min(...clears)}-${Math.max(...clears)}, avg ${(clears.reduce((a, b) => a + b, 0) / seeds.length).toFixed(1)}`,
  );
}

if (process.argv[2] === "--worker") {
  runWorker();
} else {
  runOrchestrator();
}
