// Drives the LST drill's verified-run playback end to end: open the app on
// a seed that ships a verified 20-TSD line (src/data/lst-runs.json), hammer
// the watch-book key, and assert the goal panel reaches the full target
// with the goal marked done.
//
// Usage: node tools/e2e/lst-run-drive.mjs [seed] [shotDir]

import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "fs";

const data = JSON.parse(readFileSync("src/data/lst-runs.json", "utf8"));
const seeds = Object.keys(data.runs);
if (seeds.length === 0) {
  console.error("no verified runs in src/data/lst-runs.json - run gen-lst-runs first");
  process.exit(1);
}
const seed = process.argv[2] ?? seeds[0];
const moves = data.runs[seed];
if (!moves) {
  console.error(`seed ${seed} has no verified run (have: ${seeds.join(", ")})`);
  process.exit(1);
}
const shotDir = process.argv[3] ?? "/tmp/lst-run-shots";
mkdirSync(shotDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto(`http://localhost:5199/?seed=${seed}`);
await page.waitForSelector("canvas", { timeout: 10000 });
await page.mouse.click(750, 500);
await page.waitForTimeout(400);

console.log(`seed ${seed}: ${moves.length} verified moves, driving watch-book...`);
for (let i = 0; i < moves.length; i++) {
  await page.keyboard.press("KeyB");
  await page.waitForTimeout(70);
  if (i === 20 || i === 70) {
    await page.screenshot({ path: `${shotDir}/mid-${i}.png` });
  }
}
await page.waitForTimeout(1200);
await page.screenshot({ path: `${shotDir}/final.png` });

const text = await page.evaluate(() => document.body.innerText);
const toast = await page.evaluate(() => document.querySelector(".toast")?.textContent ?? "");
const target = data.target;
const gotCount = text.includes(`${target}/${target}`);
const gotDone = text.includes("done ✓");
console.log(`TSD counter ${target}/${target}: ${gotCount ? "PASS" : "FAIL"}`);
console.log(`goal done ✓: ${gotDone ? "PASS" : "FAIL"}`);
console.log(`last toast: ${toast.trim()}`);
if (!gotCount || !gotDone) {
  const m = text.match(/\d+\/\d+ TSDs?/g);
  console.log("panel TSD readings:", m?.join(", ") ?? "none found");
}
await browser.close();
process.exit(gotCount && gotDone ? 0 : 1);
