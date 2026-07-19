import { chromium } from "playwright";
const shots = process.argv[2] ?? "/tmp/shots";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 640, height: 260 } });
await page.goto("http://localhost:5199/");
await page.waitForTimeout(400);
await page.evaluate(async () => {
  const { ZenithAltimeter } = await import("/src/ui/zenith-altimeter.ts");
  document.body.innerHTML = "";
  document.body.style.cssText =
    "background:#181825;display:flex;flex-direction:column;gap:14px;padding:20px";
  window.__alts = [];
  for (const alt of [30, 450, 1650]) {
    const box = document.createElement("div");
    box.style.cssText = "background:#11111b;border:1px solid #333;border-radius:8px;width:560px";
    const a = new ZenithAltimeter(560);
    a.reset(alt);
    box.appendChild(a.el);
    document.body.appendChild(box);
    window.__alts.push({ a, alt });
  }
  const tick = () => {
    for (const { a, alt } of window.__alts)
      a.frame({ altitude: alt, climbRank: 3, climbProgress: 6, climbMultiplier: () => 0.75 }, 16);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
await page.waitForTimeout(600);
await page.screenshot({ path: `${shots}/altimeter-colors.png` });
await browser.close();
