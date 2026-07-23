// Quantifies the "beam gap" in unpooled LST watch: how many bot moves per run
// are played by the Loop beam (lstLoopMove) at window seams vs the verified
// Plan. In unpooled mode the plan is only the opener, so after each ~10-TSD
// solver window depletes there's a ~1s async re-solve during which every KeyB
// press plays a beam move. This measures that: per-move assist attribution is
// read off the .grade-chip after each press.
//
// Usage: node tools/e2e/lst-seam-probe.mjs [runs] [pressesPerRun]

import { chromium } from "playwright";

const RUNS = Number(process.argv[2] ?? 10);
const PRESSES = Number(process.argv[3] ?? 220);
const STEP_MS = 70; // matches the watch driver cadence; < the ~1s async re-solve

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });

/** Read the current assist attribution ("Plan"|"Book"|"Loop"|"Engine") plus the
 * tsd counter, without throwing if the chip isn't shown yet. */
async function sample() {
  return page.evaluate(() => {
    const chip = document.querySelector(".grade-chip")?.textContent ?? "";
    const who = chip.split("·")[0].trim(); // "Loop · build" -> "Loop"
    const body = document.body.innerText;
    // the goal HUD is a "TSDS" label line followed by a "N/M" count line
    const lines = body.split("\n").map((x) => x.trim());
    let tsd = -1;
    const gi = lines.findIndex((x) => /^TSDS?$/i.test(x));
    if (gi >= 0) {
      for (let j = gi + 1; j < gi + 3 && j < lines.length; j++) {
        const mm = lines[j].match(/^(\d+)\s*\/\s*(\d+)$/);
        if (mm) {
          tsd = Number(mm[1]);
          break;
        }
      }
    }
    const done = body.includes("done ✓");
    const failed = /top ?out|game over|failed/i.test(body);
    return { who, tsd, done, failed };
  });
}

const runs = [];
for (let r = 0; r < RUNS; r++) {
  await page.goto("http://localhost:5199/?unpooled=1");
  await page.waitForSelector("canvas", { timeout: 10000 });
  await page.mouse.click(750, 500);
  await page.waitForTimeout(400);

  const seq = []; // attribution per accepted move
  let lastTsd = -1;
  let prevWho = "";
  let stuck = 0;
  for (let i = 0; i < PRESSES; i++) {
    await page.keyboard.press("KeyB");
    await page.waitForTimeout(STEP_MS);
    const s = await sample();
    // record a move only when the attribution chip is present; the chip text is
    // reset per move, so identical consecutive samples still count as moves
    // (we can't tell two Loop moves apart by text) - we use tsd progress and a
    // stuck-counter to detect a dead/finished run.
    if (s.who) seq.push(s.who);
    if (s.tsd === lastTsd && s.who === prevWho) stuck++;
    else stuck = 0;
    lastTsd = s.tsd;
    prevWho = s.who;
    if (s.done || s.failed) {
      runs.push({ seq, tsd: s.tsd, end: s.done ? "done" : "failed" });
      seq.length && (seq.__ended = true);
      break;
    }
  }
  if (!seq.__ended) runs.push({ seq, tsd: lastTsd, end: "cap" });
  const last = runs[runs.length - 1];
  const loop = last.seq.filter((w) => w === "Loop").length;
  const plan = last.seq.filter((w) => w === "Plan").length;
  console.log(
    `run ${r + 1}: ${last.seq.length} moves | Plan ${plan} Loop ${loop} | ${last.tsd} TSD | ${last.end}`,
  );
}

// aggregate
function tally(w) {
  return runs.reduce((n, r) => n + r.seq.filter((x) => x === w).length, 0);
}
const total = runs.reduce((n, r) => n + r.seq.length, 0);
const loop = tally("Loop");
const plan = tally("Plan");
const book = tally("Book");
const engine = tally("Engine");

// Seam analysis on the Plan/non-Plan boundary (Plan = the solver's clean line;
// everything else is off-line jank). We separate:
//  - INTERIOR gaps: non-Plan runs bracketed by Plan on BOTH sides = the beam
//    gap at a window seam (the thing prefetch-extend would remove).
//  - a LEADING gap (before the first Plan) = opener miss / window not adopted yet.
//  - a TRAILING gap (after the last Plan) = the window-solver stopped producing
//    a line (likely an unwinnable unpooled seed) - prefetch-extend can't help.
const interior = [];
let runsEverPlanned = 0;
let leadTotal = 0;
let trailTotal = 0;
for (const r of runs) {
  const seq = r.seq;
  const planIdx = seq.map((w, i) => (w === "Plan" ? i : -1)).filter((i) => i >= 0);
  if (planIdx.length === 0) {
    leadTotal += seq.length; // whole run never reached the solver line
    continue;
  }
  runsEverPlanned++;
  const first = planIdx[0];
  const last = planIdx[planIdx.length - 1];
  leadTotal += first;
  trailTotal += seq.length - 1 - last;
  // interior gaps: count non-Plan runs strictly between first and last Plan
  let run = 0;
  for (let i = first + 1; i < last; i++) {
    if (seq[i] !== "Plan") run++;
    else {
      if (run > 0) interior.push(run);
      run = 0;
    }
  }
}
const meanGap = interior.length ? (interior.reduce((a, b) => a + b, 0) / interior.length).toFixed(1) : "0";
const maxGap = interior.length ? Math.max(...interior) : 0;
const interiorTotal = interior.reduce((a, b) => a + b, 0);

console.log("\n==== SEAM PROBE SUMMARY ====");
console.log(`runs: ${runs.length}, total bot moves: ${total}, runs that ever reached the solver Plan: ${runsEverPlanned}/${runs.length}`);
console.log(
  `attribution: Plan ${plan} (${((plan / total) * 100).toFixed(1)}%)  Loop ${loop} (${((loop / total) * 100).toFixed(1)}%)  Book ${book} (${((book / total) * 100).toFixed(1)}%)  Engine ${engine} (${((engine / total) * 100).toFixed(1)}%)`,
);
console.log(`INTERIOR seam gaps (beam between two Plan streaks): ${interior.length} seams, ${interiorTotal} moves, mean ${meanGap}, max ${maxGap}`);
console.log(`  -> these are what prefetch-extend removes (@ ${STEP_MS}ms cadence; the async re-solve is ~1s wall-clock)`);
console.log(`LEADING off-line moves (opener miss / pre-first-Plan): ${leadTotal}`);
console.log(`TRAILING off-line moves (post-last-Plan, window-solver gave up = likely unwinnable seed): ${trailTotal}`);
console.log(`mean TSD reached: ${(runs.reduce((n, r) => n + r.tsd, 0) / runs.length).toFixed(1)}`);

await browser.close();
