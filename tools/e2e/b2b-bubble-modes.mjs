// Check ChainBubble placement in each mode: force-show it (game/versus views
// only touch it on lock events, so injected state sticks) and screenshot.
import { chromium } from "playwright";

const shots = process.argv[2] ?? "/tmp/shots";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto("http://localhost:5199/");
await page.waitForTimeout(500);

const show = (label, n) =>
  page.evaluate(
    ({ label, n }) => {
      const slot = document.querySelector(".chain-slot");
      if (!slot) return "no bubble in DOM";
      slot.querySelector(".chain-label").textContent = label;
      slot.querySelector(".b2b-bubble").textContent = `×${n}`;
      slot.style.setProperty("--b2b-col", `hsl(${Math.max(5, 50 - (n - 1) * 6)}, 90%, 55%)`);
      slot.classList.add("show");
      if (n >= 4) slot.querySelector(".b2b-bubble").classList.add("charged");
      const q = document.querySelector(".chain-slot + .panel").getBoundingClientRect();
      const b = slot.getBoundingClientRect();
      return { aboveQueue: b.y + b.height <= q.y + 1, sameCol: Math.abs(b.x - q.x) < 2 };
    },
    { label, n },
  );

for (const [nav, label, n, shot] of [
  ["4-wide", "COMBO", 12, "fourwide"],
  ["LST drill", "B2B", 3, "lst"],
  ["1v1", "B2B", 6, "versus"],
]) {
  await page.getByText(nav, { exact: false }).first().click();
  await page.waitForTimeout(600);
  // versus needs the match started for the field to exist? try showing anyway
  const res = await show(label, n);
  console.log(nav, JSON.stringify(res));
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${shots}/m-${shot}.png` });
}
await browser.close();
