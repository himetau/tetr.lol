// Drives the graded All-Spin mode: for each pinned seed, execute the spin and
// confirm the B2B counter + grading feedback fire.
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "fs";

const plan = JSON.parse(readFileSync(process.argv[2], "utf8"));
const shotDir = process.argv[3] ?? "/tmp/allspin-shots";
mkdirSync(shotDir, { recursive: true });

const browser = await chromium.launch();
const results = [];
let shot = 0;
for (const p of plan) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.goto(`http://localhost:5199/?seed=${p.seed}`);
  await page.waitForSelector("canvas", { timeout: 10000 });
  await page.getByRole("button", { name: "All-Spin" }).click();
  await page.waitForTimeout(400);

  for (const k of p.keys) {
    await page.keyboard.press(k);
    await page.waitForTimeout(55);
  }
  await page.waitForTimeout(1000); // worker grading latency

  const state = await page.evaluate(() => ({
    b2b: document.querySelector(".b2b-tag")?.textContent ?? "",
    chip: document.querySelector(".grade-chip")?.textContent ?? "",
    dock: (document.querySelector(".dock-body")?.textContent ?? "").slice(0, 120),
  }));
  const keptB2b = /B2B/.test(state.b2b);
  results.push({ seed: p.seed, piece: p.piece, keptB2b, ...state });
  await page.screenshot({
    path: `${shotDir}/${String(shot++).padStart(2, "0")}-seed${p.seed}-${p.piece}.png`,
  });
  await page.close();
}
await browser.close();

let pass = 0;
for (const r of results) {
  if (r.keptB2b) pass++;
  console.log(
    `${r.keptB2b ? "OK" : "!!"} seed ${r.seed} (${r.piece}) b2b="${r.b2b}" chip="${r.chip}"\n     dock="${r.dock}"`,
  );
}
console.log(`\n${pass}/${results.length} kept B2B via a spin`);
