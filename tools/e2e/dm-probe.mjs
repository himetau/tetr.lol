import { chromium } from "playwright";
const shots = process.argv[2] ?? "/tmp/shots";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 760, height: 240 } });
await page.goto("http://localhost:5199/");
await page.waitForTimeout(400);
const info = await page.evaluate(async () => {
  await document.fonts.ready;
  const c = document.createElement("canvas").getContext("2d");
  const s = "BLOCKY ag08@";
  c.font = '40px "Departure Mono"';
  const wDM = c.measureText(s).width;
  c.font = "40px monospace";
  const wMono = c.measureText(s).width;
  return {
    check: document.fonts.check('40px "Departure Mono"'),
    wDM,
    wMono,
    differ: Math.abs(wDM - wMono) > 0.5,
  };
});
console.log(JSON.stringify(info));
await page.setContent(`<body style="background:#181825;margin:0;padding:24px;image-rendering:pixelated">
  <div style="font:44px 'Departure Mono';color:#cba6f7;image-rendering:pixelated">Departure BLOCKY 08@</div>
  <div style="font:44px monospace;color:#89b">monospace BLOCKY 08@</div>
</body>`);
await page.waitForTimeout(300);
await page.screenshot({ path: `${shots}/dm-probe.png` });
await browser.close();
