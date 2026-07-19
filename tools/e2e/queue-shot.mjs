import { chromium } from "playwright";
const shots = process.argv[2] ?? "/tmp/shots";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await page.goto("http://localhost:5199/", { waitUntil: "networkidle" });
await page.waitForTimeout(700);
const next = page.locator(".side-col .panel").last();
await next.screenshot({ path: `${shots}/queue.png` });
const info = await page.evaluate(() => {
  const p = [...document.querySelectorAll(".side-col .panel")].pop();
  const cs = getComputedStyle(p);
  return {
    border: cs.border,
    boxShadow: cs.boxShadow,
    padding: cs.padding,
    background: cs.backgroundColor,
    cornerShape: cs.cornerShape || cs.getPropertyValue("corner-shape"),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
