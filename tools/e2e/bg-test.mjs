import { chromium } from "playwright";
const shots = process.argv[2] ?? "/tmp/shots";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
await page.goto("http://localhost:5199/", { waitUntil: "networkidle" });
await page.waitForTimeout(600);
// force scenes mode + render every scene by importing the module and checking each loads
const res = await page.evaluate(async () => {
  // reach into the running app: enable scenes background
  const bgRoot = document.querySelector(".bg-root");
  const hasRoot = !!bgRoot;
  const rootDisplay = bgRoot ? getComputedStyle(bgRoot).display : "none";
  const layer = document.querySelector(".bg-img.show");
  const hasImg = !!(layer && getComputedStyle(layer).backgroundImage !== "none");
  return { hasRoot, rootDisplay, hasImg, bodyClass: document.body.className };
});
console.log("feature check:", JSON.stringify(res));
await page.screenshot({ path: `${shots}/bg-live.png` });
await browser.close();
