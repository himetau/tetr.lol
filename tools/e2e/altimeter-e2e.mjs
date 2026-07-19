import { chromium } from "playwright";

const shots = process.argv[2] ?? "/tmp/shots";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto("http://localhost:5199/?seed=12");
await page.waitForTimeout(600);

// enter quick play
await page.getByText("Quick play", { exact: false }).first().click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${shots}/1-launch.png` });

// start the climb from the default floor
await page.getByText("Start climb", { exact: true }).click();
await page.waitForTimeout(1700); // countdown 3-2-1

// play a few pieces: rotate + hard drop
for (let i = 0; i < 10; i++) {
  await page.keyboard.press(i % 3 === 0 ? "ArrowUp" : "ArrowLeft");
  await page.keyboard.press("Space");
  await page.waitForTimeout(180);
}
await page.screenshot({ path: `${shots}/2-run.png` });
await page.locator(".field-panel").screenshot({ path: `${shots}/3-field.png` });

// verify the altimeter canvas exists, is sized, and has real pixels drawn
const info = await page.evaluate(() => {
  const c = document.querySelector("canvas.zenith-altimeter");
  if (!c) return { ok: false, reason: "canvas missing" };
  const board = document.querySelector(".field-well canvas");
  const cr = c.getBoundingClientRect();
  const br = board.getBoundingClientRect();
  const ctx = c.getContext("2d");
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 10) lit++;
  return {
    ok: true,
    litPx: lit,
    canvasRect: { x: cr.x, y: cr.y, w: cr.width, h: cr.height },
    boardRect: { x: br.x, y: br.y, w: br.width, h: br.height },
    alignedLeft: Math.abs(cr.x - br.x) < 2,
    sameWidth: Math.abs(cr.width - br.width) < 2,
    belowBoard: cr.y >= br.y + br.height - 2,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
