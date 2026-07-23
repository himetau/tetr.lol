// Parallel harvester for the PURE-20-TSD pool (src/data/lst-runs.json). Mirrors
// pool-parallel.ts but with allowQuad=false and a hard 20-TSD keep bar, fanned
// out across cores (each worker scans a strided disjoint slice into its own
// shard, then the orchestrator merges). Every kept line is replay-verified
// against a real Game via harvestSeed, exactly like gen-lst-runs.
//
//   npx tsx tools/pool-20-parallel.ts [total=40] [budgetMs=30000] [first=1] [span=2000] [shards=12]
//   (internal) --worker <outFile> <first> <last> <stride> <offset> <budgetMs> <maxKeep>

import { spawn } from "child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { harvestSeed, type RunMove } from "./harvest-core";

const TARGET = 20;
const here = dirname(fileURLToPath(import.meta.url));
const selfPath = fileURLToPath(import.meta.url);
const outPath = join(here, "..", "src", "data", "lst-runs.json");
const shardDir = join(here, "data", "pool20-shards");

function runWorker(): void {
  const [outFile, firstS, lastS, strideS, offsetS, budgetS, maxKeepS] = process.argv.slice(3);
  const first = Number(firstS), last = Number(lastS), stride = Number(strideS);
  const offset = Number(offsetS), budgetMs = Number(budgetS), maxKeep = Number(maxKeepS);
  const shard: { runs: Record<string, RunMove[]> } = { runs: {} };
  const flush = () => writeFileSync(outFile, JSON.stringify(shard));
  flush();
  let kept = 0;
  for (let seed = first + offset; seed <= last && kept < maxKeep; seed += stride) {
    const t0 = Date.now();
    // allowQuad=false, minClears=TARGET -> only full clean 20-TSD lines are kept
    const r = harvestSeed(seed, TARGET, budgetMs, TARGET, false);
    const ms = Date.now() - t0;
    if (r && r.stat.tsds >= TARGET && r.stat.quads === 0) {
      shard.runs[String(seed)] = r.line;
      kept++;
      flush();
      console.log(`[w${offset}] seed ${seed}: VERIFIED ${r.stat.tsds} TSDs ${ms}ms  [${kept}/${maxKeep}]`);
    } else {
      console.log(`[w${offset}] seed ${seed}: skip ${ms}ms`);
    }
  }
  console.log(`[w${offset}] done: kept ${kept}`);
}

async function runOrchestrator(): Promise<void> {
  const total = Number(process.argv[2] ?? 40);
  const budgetMs = Number(process.argv[3] ?? 30000);
  const first = Number(process.argv[4] ?? 1);
  const span = Number(process.argv[5] ?? 2000);
  const shards = Number(process.argv[6] ?? 12);
  const last = first + span;

  const pool: { target: number; note: string; runs: Record<string, RunMove[]> } = existsSync(outPath)
    ? JSON.parse(readFileSync(outPath, "utf8"))
    : { target: TARGET, note: "", runs: {} };
  pool.runs ??= {};
  const have = Object.keys(pool.runs).length;
  const needed = total - have;
  if (needed <= 0) {
    console.log(`pool already has ${have} >= ${total}; nothing to do`);
    return;
  }
  const maxKeep = Math.ceil(needed / shards) + 2;
  console.log(
    `orchestrator: have ${have}, need ${needed} -> ${shards} workers x maxKeep ${maxKeep}, seeds ${first}..${last} (stride ${shards}), ${budgetMs}ms/seed`,
  );
  rmSync(shardDir, { recursive: true, force: true });
  mkdirSync(shardDir, { recursive: true });
  const children = Array.from({ length: shards }, (_, k) => {
    const outFile = join(shardDir, `shard-${k}.json`);
    const args = ["tsx", selfPath, "--worker", outFile, String(first), String(last), String(shards),
      String(k), String(budgetMs), String(maxKeep)];
    const child = spawn("npx", args, { stdio: "inherit" });
    return new Promise<void>((resolve) => child.on("exit", () => resolve()));
  });
  await Promise.all(children);

  let added = 0;
  for (const f of readdirSync(shardDir)) {
    if (!f.endsWith(".json")) continue;
    const s = JSON.parse(readFileSync(join(shardDir, f), "utf8")) as { runs: Record<string, RunMove[]> };
    for (const seed of Object.keys(s.runs)) {
      if (pool.runs[seed]) continue;
      pool.runs[seed] = s.runs[seed];
      added++;
    }
  }
  pool.target = TARGET;
  pool.note =
    "Verified 20-TSD watch-book lines (tools/pool-20-parallel.ts / gen-lst-runs.ts); every move replays goal-legally from a fresh Game(seed).";
  writeFileSync(outPath, JSON.stringify(pool));
  console.log(`\nmerged: +${added} -> ${Object.keys(pool.runs).length} pure-20-TSD seeds`);
}

if (process.argv[2] === "--worker") runWorker();
else void runOrchestrator();
