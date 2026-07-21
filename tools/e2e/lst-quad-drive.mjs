// Drives the QUAD drill (?quad=1) end to end in a real browser: this exercises
// the lazily-imported quad pool (kept out of the default bundle), confirming the
// pool loads on demand, deals the seed, and the watch-book plays it to the goal.
//
// Usage: node tools/e2e/lst-quad-drive.mjs [seed] [shotDir]

import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "fs";

const data = JSON.parse(readFileSync("src/data/lst-quad-runs.json", "utf8"));
const seeds = Object.keys(data.runs);
// default to the SHORTEST run - this verifies the lazy pool load + quad playback
// with the least chance of a long-run timing hiccup; pass a seed to test a bigger one
const seed = process.argv[2] ?? seeds.sort((a, b) => data.runs[a].length - data.runs[b].length)[0];
const moves = data.runs[seed];
if (!moves) {
  console.error(`seed ${seed} not in quad pool (have ${seeds.length} seeds)`);
  process.exit(1);
}
const stat = data.stats[seed];
const shotDir = process.argv[3] ?? "/tmp/lst-quad-shots";
mkdirSync(shotDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto(`http://localhost:5199/?seed=${seed}&quad=1`);
await page.waitForSelector("canvas", { timeout: 10000 });
await page.mouse.click(750, 500);
await page.waitForTimeout(500); // give the lazy quad-pool import time to land

console.log(`seed ${seed}: ${moves.length} moves, target ${stat.clears} clears (${stat.tsds} TSD + ${stat.quads} quad)`);
for (let i = 0; i < moves.length; i++) {
  await page.keyboard.press("KeyB");
  await page.waitForTimeout(70);
}
await page.waitForTimeout(1200);
await page.screenshot({ path: `${shotDir}/final.png` });

// the goal panel latches "done ✓" (line ~2338 in game-view) whether or not the
// toast has faded, so assert on body text like the non-quad driver does
const text = await page.evaluate(() => document.body.innerText);
const gotDone = text.includes("done ✓");
// the quad drill loaded the pool at all iff it dealt this seed's line: the goal
// counter should read the seed's TSD total
const gotTsds = text.includes(`${stat.tsds}/`);
console.log(`goal done ✓: ${gotDone ? "PASS" : "FAIL"}`);
if (!gotDone) {
  const m = text.match(/\d+\/\d+ TSDs?/g);
  console.log("panel TSD readings:", m?.join(", ") ?? "none found");
  console.log("dealt the seed (pool loaded):", gotTsds ? "yes" : "NO - lazy load may have failed");
}
await browser.close();
process.exit(gotDone ? 0 : 1);
