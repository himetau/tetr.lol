import { chromium } from "playwright";
const shots = process.argv[2] ?? "/tmp/shots";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
await page.goto("http://localhost:5199/", { waitUntil: "networkidle" });
await page.waitForTimeout(500);
await page.evaluate(() => {
  const d = document.querySelector(".bg-dim");
  if (d) d.style.opacity = "0.35";
});
await page.evaluate(async () => {
  const m = await import("/src/ui/background.ts");
  for (let i = 0; i < 6; i++) m.nextBackground();
});
await page.waitForTimeout(500);
await page.screenshot({ path: `${shots}/bg-final.png` });
await browser.close();
console.log("done");
