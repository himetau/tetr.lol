import { chromium } from "playwright";
const shots = process.argv[2] ?? "/tmp/shots";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto("http://localhost:5199/", { waitUntil: "networkidle" });
await page.waitForTimeout(700);
await page.screenshot({ path: `${shots}/blocky.png` });
// quick play menu too
await page.getByText("Quick play", { exact: false }).first().click();
await page.waitForTimeout(500);
await page.locator(".qp-menu").screenshot({ path: `${shots}/blocky-qp.png` });
await browser.close();
