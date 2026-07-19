import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto("http://localhost:5199/", { waitUntil: "networkidle" });
await page.waitForTimeout(600);
const r = await page.evaluate(() => {
  const g = (sel, prop) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el)[prop] : "MISSING";
  };
  return {
    rootRadius: getComputedStyle(document.documentElement).getPropertyValue("--radius"),
    fieldPanelRadius: g(".field-panel", "borderRadius"),
    panelRadius: g(".side-col .panel", "borderRadius"),
    panelBg: g(".side-col .panel", "backgroundColor"),
    hasBgClass: document.body.className,
  };
});
console.log(JSON.stringify(r, null, 2));
await browser.close();
