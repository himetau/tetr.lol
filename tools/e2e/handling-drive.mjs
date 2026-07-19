import { chromium } from "playwright";
const shotDir =
  "/tmp/claude-1000/-home-hayaku/d771beb1-f1ca-4f94-95ea-5c812b28f082/scratchpad/shots-h";
import { mkdirSync } from "fs";
mkdirSync(shotDir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto("http://localhost:5199/");
await page.waitForSelector("canvas", { timeout: 10000 });

// 1) settings page shows the new handling rows
await page.click("text=Settings");
await page.waitForTimeout(300);
const settingsText = await page.evaluate(() => document.querySelector(".page")?.textContent ?? "");
const hasDCD = settingsText.includes("DCD");
const hasCancel = settingsText.includes("Cancel DAS on direction change");
await page.screenshot({ path: `${shotDir}/00-settings.png` });

// force bounce-friendly handling via localStorage, then reload into freeplay
await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem("lst-trainer-settings-v1") || "{}");
  s.handling = {
    ...(s.handling || {}),
    dasMs: 90,
    arrMs: 0,
    sdf: 41,
    softDropCps: 30,
    dcdMs: 0,
    cancelDasOnDirChange: false,
  };
  localStorage.setItem("lst-trainer-settings-v1", JSON.stringify(s));
});
await page.reload();
await page.waitForSelector("canvas");
await page.click("text=Freeplay");
await page.waitForTimeout(300);
await page.mouse.click(750, 500);

// read the active piece's min x via a debug hook if present; else infer from canvas is hard.
// Instead: drive keys and rely on the piece reaching walls. Charge right, then flick left.
await page.keyboard.down("ArrowRight");
await page.waitForTimeout(200); // DAS + ARR0 -> right wall
await page.screenshot({ path: `${shotDir}/01-right-wall.png` });
await page.keyboard.down("ArrowLeft"); // flick left while right still held
await page.waitForTimeout(120); // should bounce to left wall
await page.screenshot({ path: `${shotDir}/02-after-flick.png` });
await page.keyboard.up("ArrowLeft");
await page.keyboard.up("ArrowRight");

console.log(JSON.stringify({ hasDCD, hasCancel }));
await browser.close();
