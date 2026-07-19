import { chromium } from 'playwright';
const shots = process.argv[2] ?? '/tmp/shots';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
await page.goto('http://localhost:5199/', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
// open settings
await page.getByText('SETTINGS', { exact: false }).first().click();
await page.waitForTimeout(400);
// find the Theme preset select and choose each preset, screenshot the app chrome
const applyPreset = async (preset) => {
  await page.evaluate(async (p) => {
    const s = await import('/src/ui/settings.ts');
    const t = await import('/src/ui/themes.ts');
    s.settings.palette.preset = p;
    t.applyTheme();
  }, preset);
  await page.waitForTimeout(250);
};
for (const p of ['mocha','dracula','nord','gruvbox','rose-pine','latte']) {
  await applyPreset(p);
  await page.screenshot({ path: `${shots}/theme-${p}.png` });
}
// verify a custom override applies a var
await applyPreset('mocha');
const beforeAccent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
await page.evaluate(async () => {
  const s = await import('/src/ui/settings.ts');
  const t = await import('/src/ui/themes.ts');
  s.settings.palette.custom = { ...t.activePalette(), accent: '#ff0088' };
  s.settings.palette.preset = 'custom';
  t.applyTheme();
});
await page.waitForTimeout(200);
const afterAccent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
console.log(JSON.stringify({ beforeAccent, afterAccent }));
await browser.close();
