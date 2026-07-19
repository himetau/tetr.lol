import { chromium } from 'playwright';
const shots = process.argv[2] ?? '/tmp/shots';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
// fresh user: clear storage so we get the new default (rose-pine)
await page.goto('http://localhost:5199/');
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const info = await page.evaluate(() => {
  const sel = document.querySelector('.foot-theme');
  const opts = sel ? [...sel.options].map(o => o.value) : [];
  return {
    hasToggle: !!document.querySelector('.foot-btn'),
    hasThemeSelect: !!sel,
    selectValue: sel?.value,
    options: opts,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
  };
});
console.log(JSON.stringify(info));
await page.screenshot({ path: `${shots}/rosepine-default.png` });
// crop footer
await browser.close();
