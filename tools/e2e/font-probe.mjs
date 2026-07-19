import { chromium } from 'playwright';
const shots = process.argv[2] ?? '/tmp/shots';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 700, height: 300 } });
await page.goto('http://localhost:5199/');
await page.waitForTimeout(400);
const info = await page.evaluate(async () => {
  await document.fonts.ready;
  // width test: if Terminus loads, its metrics differ from generic monospace
  const c = document.createElement('canvas').getContext('2d');
  const sample = 'ag4@0 SINGLEPLAYER';
  c.font = '700 40px "Terminus (TTF)"';
  const wTerm = c.measureText(sample).width;
  c.font = '700 40px monospace';
  const wMono = c.measureText(sample).width;
  const has = document.fonts.check('700 40px "Terminus (TTF)"');
  return { wTerm, wMono, differ: Math.abs(wTerm - wMono) > 0.5, fontCheck: has };
});
console.log(JSON.stringify(info));
await page.setContent(`<body style="background:#181825;margin:0;padding:24px">
  <div style="font:700 44px 'Terminus (TTF)';color:#cba6f7">Terminus 4@ ag0</div>
  <div style="font:700 44px monospace;color:#89b">monospace 4@ ag0</div>
</body>`);
await page.waitForTimeout(300);
await page.screenshot({ path: `${shots}/font-probe.png` });
await browser.close();
