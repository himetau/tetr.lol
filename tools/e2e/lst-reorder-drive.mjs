// Drives the "plan move played early" scenario from lst-reorder-plan.ts:
// watch-book to the reorder point, place the plan's next-plus-one move by
// hand, and assert it grades as a plan move (best) - then that watch-book
// keeps playing the line.
//
// Usage: npx tsx tools/e2e/lst-reorder-plan.ts [seed] > /tmp/reorder.json
//        node tools/e2e/lst-reorder-drive.mjs /tmp/reorder.json [shotDir]

import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "fs";

const plan = JSON.parse(readFileSync(process.argv[2], "utf8"));
const shotDir = process.argv[3] ?? "/tmp/lst-reorder-shots";
mkdirSync(shotDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto(`http://localhost:5199/?seed=${plan.seed}`);
await page.waitForSelector("canvas", { timeout: 10000 });
await page.mouse.click(750, 500);
await page.waitForTimeout(400);

for (let i = 0; i < plan.pressB; i++) {
  await page.keyboard.press("KeyB");
  await page.waitForTimeout(70);
}
await page.waitForTimeout(400);

// the user plays the plan's move from two ahead, by hand
for (const k of plan.keys) {
  await page.keyboard.press(k);
  await page.waitForTimeout(55);
}
await page.waitForTimeout(1000); // grading latency
const chip1 = await page.evaluate(() => document.querySelector(".grade-chip")?.textContent ?? "");
await page.screenshot({ path: `${shotDir}/after-early-move.png` });
const earlyPass = chip1.includes(plan.expectChip);
console.log(`early plan move graded: "${chip1.trim()}" - ${earlyPass ? "PASS" : "FAIL"}`);

// watch-book must keep going (the cycle's remaining fills still play)
await page.keyboard.press("KeyB");
await page.waitForTimeout(600);
const chip2 = await page.evaluate(() => document.querySelector(".grade-chip")?.textContent ?? "");
const contPass = chip2.includes(plan.thenExpect);
console.log(`watch-book continues: "${chip2.trim()}" - ${contPass ? "PASS" : "FAIL"}`);
await page.screenshot({ path: `${shotDir}/after-continue.png` });

await browser.close();
process.exit(earlyPass && contPass ? 0 : 1);
