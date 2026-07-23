// In-app verification of the wired UNPOOLED quad live loop: open the unpooled
// quad drill with a high ?goal, hammer KeyB (auto-advance), and track how far the
// clears counter climbs and who is driving (Plan vs fallback). Confirms the
// escalation + partial-truncation + ?goal wiring runs in the real app cleanly.
//
// Usage: node tools/e2e/lst-quad-unpooled-drive.mjs [runs] [pressesPerRun] [goal]

import { chromium } from "playwright";

const RUNS = Number(process.argv[2] ?? 3);
const PRESSES = Number(process.argv[3] ?? 400);
const GOAL = Number(process.argv[4] ?? 100);
// The unpooled loop is now SOLVER-DRIVEN: off-plan, the bot waits for a bounded
// window solve (~1-4s) rather than drifting on reactive moves. So the step must
// give the async solver time, and "stall" means PIECES stop advancing (a true
// jam), not clears (which legitimately hold flat for seconds during a solve).
const STEP_MS = Number(process.env.STEP_MS ?? 140);
const STALL_SAMPLES = Number(process.env.STALL ?? 60);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

async function sample() {
  return page.evaluate(() => {
    const chip = document.querySelector(".grade-chip")?.textContent ?? "";
    const who = chip.split("·")[0].trim();
    const body = document.body.innerText;
    // DOM shows the label BEFORE the value: "CLEARS 0/100" (not "0/100 clears").
    const m = body.match(/CLEARS\s+(\d+)\s*\/\s*(\d+)/i);
    const clears = m ? Number(m[1]) : -1;
    const pm = body.match(/PIECES\s+(\d+)/i);
    const pieces = pm ? Number(pm[1]) : -1;
    const done = /Goal reached/i.test(body);
    const failed = /Goal lost|top ?out|game over/i.test(body);
    return { who, clears, pieces, done, failed };
  });
}

for (let r = 0; r < RUNS; r++) {
  await page.goto(`http://localhost:5199/?unpooled=1&quad=1&goal=${GOAL}`);
  await page.waitForSelector("canvas", { timeout: 10000 });
  await page.mouse.click(750, 500);
  await page.waitForTimeout(600);

  let best = 0, lastPieces = -1, stuck = 0, end = "cap";
  const who = {};
  for (let i = 0; i < PRESSES; i++) {
    await page.keyboard.press("KeyB");
    await page.waitForTimeout(STEP_MS);
    const s = await sample();
    if (s.who) who[s.who] = (who[s.who] ?? 0) + 1;
    if (s.clears > best) best = s.clears;
    stuck = s.pieces === lastPieces ? stuck + 1 : 0; // true jam = pieces frozen
    lastPieces = s.pieces;
    if (s.done) { end = "done"; break; }
    if (s.failed) { end = "failed"; break; }
    if (stuck > STALL_SAMPLES) { end = "stalled"; break; }
  }
  const attr = Object.entries(who).map(([k, v]) => `${k}:${v}`).join(" ");
  console.log(`run ${r + 1}: reached ${best}/${GOAL} clears | ${end} | ${attr}`);
}

console.log(errors.length ? `\nPAGE ERRORS (${errors.length}):\n  ${[...new Set(errors)].slice(0, 8).join("\n  ")}` : "\nno page errors ✓");
await browser.close();
