// Eyeball the B2B bubble CSS states in isolation (the live run loop owns
// the real element's classes, so drive a standalone copy instead).
import { chromium } from "playwright";

const shots = process.argv[2] ?? "/tmp/shots";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 760, height: 260 } });
await page.goto("http://localhost:5199/");
await page.waitForTimeout(500);

await page.evaluate(() => {
  document.body.innerHTML = "";
  document.body.style.cssText = "background:#181825;display:flex;gap:30px;padding:30px";
  for (const b2b of [1, 5, 12]) {
    const panel = document.createElement("div");
    panel.style.cssText =
      "width:200px;height:190px;position:relative;background:#11111b;border:1px solid #333;border-radius:8px";
    const el = document.createElement("div");
    el.className = "b2b-bubble show";
    el.innerHTML = `<small>B2B</small>×${b2b}`;
    el.style.setProperty("--b2b-col", `hsl(${Math.max(5, 50 - (b2b - 1) * 6)}, 90%, 55%)`);
    if (b2b >= 4) el.classList.add("charged");
    const tag = document.createElement("div");
    tag.style.cssText = "position:absolute;bottom:6px;right:8px;color:#888;font:12px sans-serif";
    tag.textContent = `b2b ${b2b}`;
    panel.append(el, tag);
    document.body.appendChild(panel);
  }
});
await page.waitForTimeout(300);
await page.screenshot({ path: `${shots}/7-b2b-states.png` });
// second shot mid-drift to confirm the bubble wanders
await page.waitForTimeout(1600);
await page.screenshot({ path: `${shots}/8-b2b-drift.png` });

const moved = await page.evaluate(() => {
  const els = [...document.querySelectorAll(".b2b-bubble")];
  return els.map((e) => getComputedStyle(e).translate);
});
console.log("translate mid-drift:", moved);
await browser.close();
