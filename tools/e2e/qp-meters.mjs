import { chromium } from 'playwright';
const shots = process.argv[2] ?? '/tmp/shots';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto('http://localhost:5199/');
await page.waitForTimeout(500);
// tagline shot (top-left brand)
await page.locator('.brand').screenshot({ path: `${shots}/tagline.png` });
// quick play run
await page.getByText('Quick play', { exact: false }).first().click();
await page.waitForTimeout(300);
await page.getByText('Start climb', { exact: true }).click();
await page.waitForTimeout(1700);
for (let i = 0; i < 8; i++) { await page.keyboard.press(i % 3 ? 'ArrowLeft' : 'ArrowUp'); await page.keyboard.press('Space'); await page.waitForTimeout(150); }
await page.locator('.side-col').first().screenshot({ path: `${shots}/qp-hud.png` });
await browser.close();
