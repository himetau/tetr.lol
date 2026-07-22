// Verifies the "Quad loop" setting (settings.lstQuad) drives quad mode in the LST
// drill, independent of the ?quad=1 URL flag: default is the 20-TSD drill, the
// setting turns quads on, and ?quad=1 still forces them on.
//
// Usage: node tools/e2e/lst-quad-setting-drive.mjs   (needs the dev server on :5199)

import { chromium } from "playwright";

const browser = await chromium.launch();
async function isQuad({ setting, param }) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  if (setting) {
    // partial settings merge over defaults, so this just flips lstQuad on
    await page.addInitScript(() => localStorage.setItem("lst-trainer-settings-v1", '{"lstQuad":true}'));
  }
  await page.goto(`http://localhost:5199/${param ? "?quad=1" : ""}`);
  await page.waitForSelector("canvas", { timeout: 10000 });
  await page.mouse.click(700, 450);
  await page.waitForTimeout(700);
  const text = await page.evaluate(() => document.body.innerText);
  await page.close();
  // quad mode renders a "clears" HUD cell; the 20-TSD drill reads 0/20
  return /\bclears\b/i.test(text) && !/\b0\/20\b/.test(text);
}

const cases = [
  ["default (no setting, no param)", { setting: false, param: false }, false],
  ["setting on", { setting: true, param: false }, true],
  ["?quad=1 forces on", { setting: false, param: true }, true],
];
let ok = true;
for (const [name, opts, want] of cases) {
  const got = await isQuad(opts);
  const pass = got === want;
  if (!pass) ok = false;
  console.log(`${name}: quad=${got} expected=${want} -> ${pass ? "PASS" : "FAIL"}`);
}
await browser.close();
process.exit(ok ? 0 : 1);
