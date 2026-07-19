import { chromium } from 'playwright';
const shots = process.argv[2] ?? '/tmp/shots';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto('http://localhost:5199/');
await page.waitForTimeout(500);
await page.getByText('Quick play', { exact: false }).first().click();
await page.waitForTimeout(400);
// select a different floor to show the 'on' state
await page.locator('.qp-floor').nth(4).click();
await page.waitForTimeout(200);
await page.locator('.qp-menu').screenshot({ path: `${shots}/qp-menu.png` });
await browser.close();
