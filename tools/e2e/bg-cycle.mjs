import { chromium } from "playwright";
const shots = process.argv[2] ?? "/tmp/shots";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
await page.goto("http://localhost:5199/", { waitUntil: "networkidle" });
await page.waitForTimeout(500);
// dim way down + hide the app grid so we see the raw scene
await page.addStyleTag({
  content:
    ".bg-dim{opacity:.12 !important} body::before{display:none !important} #app{opacity:.0 !important}",
});
// import the background module to cycle deterministically
const count = await page.evaluate(async () => {
  const m = await import("/src/ui/background.ts");
  return typeof m.nextBackground;
});
for (let i = 0; i < 10; i++) {
  await page.evaluate(async () => {
    const m = await import("/src/ui/background.ts");
    m.nextBackground();
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/scene-${i}.png` });
}
console.log("nextBackground:", count);
await browser.close();
