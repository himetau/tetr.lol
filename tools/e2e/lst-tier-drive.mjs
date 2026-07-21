// Verifies ?quad=1&tier=<name> narrows the quad drill to that difficulty bucket:
// loads each tier a few times and asserts the dealt seed's clear target falls in
// the tier's range. Ranges mirror lstTier() in src/engine/lst-tier.ts.
//
// Usage: node tools/e2e/lst-tier-drive.mjs   (needs the dev server on :5199)

import { chromium } from "playwright";

const ranges = { warmup: [14, 17], standard: [18, 23], long: [24, 29], showcase: [30, 99] };
const browser = await chromium.launch();
let ok = true;
for (const [tier, [lo, hi]] of Object.entries(ranges)) {
  for (let i = 0; i < 3; i++) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.goto(`http://localhost:5199/?quad=1&tier=${tier}`);
    await page.waitForSelector("canvas", { timeout: 10000 });
    await page.mouse.click(600, 400);
    await page.waitForTimeout(500);
    const text = await page.evaluate(() => document.body.innerText);
    const m = text.match(/\b0\/(\d+)\b/); // the clears HUD reads 0/<target> at start
    const target = m ? Number(m[1]) : NaN;
    const pass = target >= lo && target <= hi;
    if (!pass) ok = false;
    console.log(`${tier} #${i}: target ${target} in [${lo},${hi}] -> ${pass ? "PASS" : "FAIL"}`);
    await page.close();
  }
}
await browser.close();
process.exit(ok ? 0 : 1);
