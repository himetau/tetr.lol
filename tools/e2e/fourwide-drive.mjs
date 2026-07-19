// Drives the 4-wide drill with the planned key script and captures the
// grading UI + combo tag; also spot-checks the patterns page 4-Wide section.
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "fs";

const plan = JSON.parse(readFileSync(process.argv[2], "utf8"));
const shotDir = process.argv[3] ?? "/tmp/e2e-shots";
mkdirSync(shotDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto(`http://localhost:5199/?seed=${plan.seed}`);
await page.waitForSelector("canvas", { timeout: 10000 });
await page.click("text=4-wide drill");
await page.waitForTimeout(400);

const results = [];
let shot = 0;

const phase = await page.evaluate(() => document.querySelector(".side-col")?.textContent ?? "");
results.push({
  i: "setup",
  desc: "session strip shows 4-wide phase",
  expect: "4-wide combo",
  pass: phase.includes("4-wide combo"),
  chip: "",
  toast: "",
  dock: phase.slice(0, 120),
});
await page.screenshot({ path: `${shotDir}/${String(shot++).padStart(2, "0")}-fourwide-start.png` });

for (let i = 0; i < plan.steps.length; i++) {
  const step = plan.steps[i];
  for (const k of step.keys) {
    if (k.startsWith("Ctrl+")) {
      await page.keyboard.down("Control");
      await page.keyboard.press(k.slice(5));
      await page.keyboard.up("Control");
    } else {
      await page.keyboard.press(k);
    }
    await page.waitForTimeout(55);
  }
  const dropped = step.keys.includes("Space");
  await page.waitForTimeout(dropped ? 900 : 300);
  const state = await page.evaluate(() => ({
    chip: document.querySelector(".grade-chip")?.textContent ?? "",
    toast: document.querySelector(".reason-toast")?.textContent ?? "",
    dock: (document.querySelector(".dock-body")?.textContent ?? "").slice(0, 300),
    comboTag: document.querySelector(".b2b-tag")?.textContent ?? "",
    bookCards: document.querySelectorAll(".alt-card.is-book").length,
  }));
  const hay = `${state.chip} | ${state.toast} | ${state.dock}`;
  let pass = step.expect ? hay.includes(step.expect) : null;
  if (step.combo !== undefined) {
    const comboOk = state.comboTag === (step.combo >= 1 ? `Combo ×${step.combo}` : "");
    pass = (pass ?? true) && comboOk;
  }
  results.push({
    i,
    desc: step.desc,
    expect: step.expect ?? null,
    pass,
    chip: state.chip,
    toast: state.toast,
    dock: state.dock.slice(0, 140),
    comboTag: state.comboTag,
    bookCards: state.bookCards,
  });
  if (step.expect || step.desc.includes("undo")) {
    await page.screenshot({
      path: `${shotDir}/${String(shot++).padStart(2, "0")}-${step.desc.replace(/[^a-z0-9]+/gi, "_").slice(0, 40)}.png`,
    });
  }
}

// patterns page gained the 4-Wide section
await page.click("text=Patterns");
await page.waitForTimeout(600);
const patterns = await page.evaluate(() => {
  const heads = [...document.querySelectorAll("h1")].map((h) => h.textContent);
  const cards = document.querySelectorAll(".alt-card").length;
  return { has4w: heads.some((t) => t === "4-Wide"), cards };
});
results.push({
  i: "patterns",
  desc: `patterns page has 4-Wide section (${patterns.cards} diagrams total)`,
  expect: "4-Wide",
  pass: patterns.has4w,
  chip: "",
  toast: "",
  dock: "",
});
await page.screenshot({
  path: `${shotDir}/${String(shot++).padStart(2, "0")}-patterns.png`,
  fullPage: false,
});

await browser.close();
for (const r of results) {
  const mark = r.pass === null ? "  " : r.pass ? "OK" : "!!";
  console.log(
    `${mark} [${r.i}] ${r.desc}\n     chip="${r.chip}" toast="${r.toast}" combo="${r.comboTag ?? ""}" book-cards=${r.bookCards ?? ""}\n     dock="${r.dock}"`,
  );
}
const failed = results.filter((r) => r.pass === false);
console.log(failed.length ? `\nFAILED expectations: ${failed.length}` : "\nall expectations met");
