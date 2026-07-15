// Drives the dev app with the planned key script and captures grading UI.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'fs';

const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const shotDir = process.argv[3] ?? '/tmp/e2e-shots';
mkdirSync(shotDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto(`http://localhost:5199/?seed=${plan.seed}`);
await page.waitForSelector('canvas', { timeout: 10000 });
await page.mouse.click(750, 500);
await page.waitForTimeout(400);

const results = [];
let shot = 0;
for (let i = 0; i < plan.steps.length; i++) {
  const step = plan.steps[i];
  for (const k of step.keys) {
    if (k.startsWith('Ctrl+')) {
      await page.keyboard.down('Control');
      await page.keyboard.press(k.slice(5));
      await page.keyboard.up('Control');
    } else {
      await page.keyboard.press(k);
    }
    await page.waitForTimeout(55);
  }
  const dropped = step.keys.includes('Space');
  await page.waitForTimeout(dropped ? 900 : 300);
  const state = await page.evaluate(() => ({
    chip: document.querySelector('.grade-chip')?.textContent ?? '',
    chipShown: document.querySelector('.grade-chip')?.classList.contains('show') ?? false,
    toast: document.querySelector('.toast')?.textContent ?? '',
    dock: (document.querySelector('.dock-body')?.textContent ?? '').slice(0, 300),
    bookCards: document.querySelectorAll('.alt-card.is-book').length,
  }));
  const hay = `${state.chip} | ${state.toast} | ${state.dock}`;
  const pass = step.expect ? hay.includes(step.expect) : null;
  results.push({ i, desc: step.desc, expect: step.expect ?? null, pass, chip: state.chip, toast: state.toast, dock: state.dock.slice(0, 160), bookCards: state.bookCards });
  if (step.expect || step.desc.includes('undo') || step.desc.includes('TSD')) {
    await page.screenshot({ path: `${shotDir}/${String(shot++).padStart(2, '0')}-${step.desc.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}.png` });
  }
}
await page.screenshot({ path: `${shotDir}/${String(shot++).padStart(2, '0')}-final.png` });
await browser.close();
for (const r of results) {
  const mark = r.pass === null ? '  ' : r.pass ? 'OK' : '!!';
  console.log(`${mark} [${r.i}] ${r.desc}\n     chip="${r.chip}" toast="${r.toast}" book-cards=${r.bookCards}\n     dock="${r.dock}"`);
}
const failed = results.filter((r) => r.pass === false);
console.log(failed.length ? `\nFAILED expectations: ${failed.length}` : '\nall expectations met');
