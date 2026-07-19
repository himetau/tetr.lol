// Drive ZenithAltimeter directly with a fake surging run to eyeball the
// heat glow + spark systems without needing a real surge via keyboard.
import { chromium } from "playwright";

const shots = process.argv[2] ?? "/tmp/shots";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 700, height: 300 } });
await page.goto("http://localhost:5199/");
await page.waitForTimeout(400);

await page.evaluate(async () => {
  const { ZenithAltimeter } = await import("/src/ui/zenith-altimeter.ts");
  document.body.innerHTML = "";
  document.body.style.background = "#181825";
  const alti = new ZenithAltimeter(560);
  alti.el.style.margin = "60px";
  document.body.appendChild(alti.el);
  const fake = {
    altitude: 862,
    climbRank: 9,
    climbProgress: 21,
    climbMultiplier: () => 2.25,
  };
  alti.reset(fake.altitude);
  alti.surge(14);
  let last = performance.now();
  const tick = (t) => {
    const dt = t - last;
    last = t;
    fake.altitude += 6 * (dt / 1000); // rocketing upward: heat saturates
    alti.frame(fake, dt);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
await page.waitForTimeout(500);
await page.screenshot({ path: `${shots}/4-surge.png` });
await page.waitForTimeout(1600);
await page.screenshot({ path: `${shots}/5-hot.png` });
await browser.close();
