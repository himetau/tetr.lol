import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await page.goto("http://localhost:5199/", { waitUntil: "networkidle" });
await page.waitForTimeout(700);
const r = await page.evaluate(() => {
  const panel = [...document.querySelectorAll(".side-col .panel")].pop();
  const cvs = panel.querySelector("canvas");
  const pr = panel.getBoundingClientRect(),
    cr = cvs.getBoundingClientRect();
  const ccs = getComputedStyle(cvs);
  return {
    panelW: Math.round(pr.width),
    canvasCssW: ccs.width,
    canvasDisplay: ccs.display,
    canvasMargin: ccs.margin,
    canvasRenderedW: Math.round(cr.width),
    canvasRenderedH: Math.round(cr.height),
    canvasLeftInPanel: Math.round(cr.left - pr.left),
    panelPadL: getComputedStyle(panel).paddingLeft,
    intrinsic: `${cvs.width}x${cvs.height}`,
    styleW: cvs.style.width,
  };
});
console.log(JSON.stringify(r, null, 2));
await browser.close();
