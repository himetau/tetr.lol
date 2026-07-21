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
await page.waitForTimeout(1100); // grading latency
const early = await page.evaluate(() => ({
  cls: document.querySelector(".grade-chip")?.className ?? "",
  head: document.querySelector(".dock-grade")?.textContent ?? "",
  cards: document.querySelectorAll(".alt-card").length,
}));
await page.screenshot({ path: `${shotDir}/after-early-move.png` });
// on-plan = Best chip + hoverable path cards (the restored "old system")
const earlyPass = early.cls.includes(plan.expectClass) && early.cards > 0;
console.log(`early plan move: [${early.cls}] "${early.head}" cards=${early.cards} - ${earlyPass ? "PASS" : "FAIL"}`);

// watch-book must keep going (the cycle's remaining fills still play)
const tsdBefore = await page.evaluate(() =>
  document.body.innerText.match(/(\d+)\/20/)?.[1] ?? "?");
await page.keyboard.press("KeyB");
await page.waitForTimeout(600);
const alive = await page.evaluate(() => !document.querySelector(".death-screen, .topout"));
console.log(`watch-book continues (was ${tsdBefore}/20, still alive): ${alive ? "PASS" : "FAIL"}`);
await page.screenshot({ path: `${shotDir}/after-continue.png` });

await browser.close();
process.exit(earlyPass && alive ? 0 : 1);
