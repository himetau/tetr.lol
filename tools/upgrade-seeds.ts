// Quality pass: re-solve the pool's top seeds at a higher budget and keep the new
// line only if it clears strictly MORE. The 30s harvest undersells some seeds
// (seed 513 went 34->41 at 120s); this recovers that. One child process per seed
// (they're independent) so a batch finishes in ~one solve-wave, not serially.
// Writes the pool once, in the parent, after merging - safe to run between sweeps
// (never concurrently with pool-parallel, which also writes the pool).
//
//   npx tsx tools/upgrade-seeds.ts [budgetMs=120000] [minClears=24] [target=60]
//   (internal) --solve <outFile> <seed> <target> <budgetMs>

import { spawn } from "child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { harvestSeed, type RunMove, type Stat } from "./harvest-core";

const here = dirname(fileURLToPath(import.meta.url));
const selfPath = fileURLToPath(import.meta.url);
const outPath = join(here, "..", "src", "data", "lst-quad-runs.json");
const workDir = join(here, "data", "upgrade");

interface Pool {
  target: number;
  note: string;
  runs: Record<string, RunMove[]>;
  stats: Record<string, Stat>;
}

function runWorker(): void {
  const [outFile, seedS, targetS, budgetS] = process.argv.slice(3);
  const r = harvestSeed(Number(seedS), Number(targetS), Number(budgetS), 0);
  // minClears 0 -> always returns the best clean line it found (or null if the
  // seed genuinely can't sustain a loop, which shouldn't happen for pool seeds)
  writeFileSync(outFile, JSON.stringify(r ? { line: r.line, stat: r.stat } : null));
}

async function runParent(): Promise<void> {
  const budgetMs = Number(process.argv[2] ?? 120000);
  const minClears = Number(process.argv[3] ?? 24);
  const target = Number(process.argv[4] ?? 60);

  if (!existsSync(outPath)) {
    console.log("no pool");
    return;
  }
  const pool: Pool = JSON.parse(readFileSync(outPath, "utf8"));
  const seeds = Object.keys(pool.runs).filter((s) => pool.stats[s].clears >= minClears);
  if (seeds.length === 0) {
    console.log(`no seeds >= ${minClears} clears`);
    return;
  }
  console.log(
    `upgrading ${seeds.length} seeds (>=${minClears} clears) at ${budgetMs}ms: ${seeds.join(",")}`,
  );

  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  await Promise.all(
    seeds.map((seed) => {
      const outFile = join(workDir, `${seed}.json`);
      const child = spawn(
        "npx",
        ["tsx", selfPath, "--solve", outFile, seed, String(target), String(budgetMs)],
        { stdio: "ignore" },
      );
      return new Promise<void>((resolve) => child.on("exit", () => resolve()));
    }),
  );

  let upgraded = 0;
  for (const f of readdirSync(workDir)) {
    if (!f.endsWith(".json")) continue;
    const seed = f.replace(".json", "");
    const raw = readFileSync(join(workDir, f), "utf8");
    if (raw === "null") continue;
    const r = JSON.parse(raw) as { line: RunMove[]; stat: Stat };
    const old = pool.stats[seed].clears;
    if (r.stat.clears > old) {
      console.log(`  seed ${seed}: ${old} -> ${r.stat.clears} clears (T=${r.stat.tsds} Q=${r.stat.quads}) UP`);
      pool.runs[seed] = r.line;
      pool.stats[seed] = r.stat;
      upgraded++;
    } else {
      console.log(`  seed ${seed}: ${old} (no gain, kept)`);
    }
  }
  if (upgraded > 0) writeFileSync(outPath, JSON.stringify(pool));

  const clears = Object.keys(pool.runs).map((k) => pool.stats[k].clears);
  console.log(
    `\nupgraded ${upgraded} seeds. pool clears ${Math.min(...clears)}-${Math.max(...clears)}`,
  );
}

if (process.argv[2] === "--solve") {
  runWorker();
} else {
  runParent();
}
