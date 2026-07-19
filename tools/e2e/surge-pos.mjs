// Fire a clear label and a SURGE popup on the same frame to confirm they
// no longer overlap (clear at 34%, surge anchored low).
import { chromium } from 'playwright';

const shots = process.argv[2] ?? '/tmp/shots';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto('http://localhost:5199/');
await page.waitForTimeout(500);
await page.getByText('Quick play', { exact: false }).first().click();
await page.waitForTimeout(300);
await page.getByText('Start climb', { exact: true }).click();
await page.waitForTimeout(1700);

await page.evaluate(async () => {
  const { actionText } = await import('/src/ui/fx.ts');
  const panel = document.querySelector('.field-panel');
  actionText(panel, 'T-SPIN DOUBLE', 'B2B ×4', 'spin');
  actionText(panel, 'SURGE', '14 LINES', 'surge', 'low');
});
await page.waitForTimeout(350);
await page.locator('.field-panel').screenshot({ path: `${shots}/6-surge-pos.png` });
await browser.close();
