// Verifies the new features end-to-end: Quick Play (Zenith) mode and the
// stats charts. Assumes vite dev server on :5199.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const shotDir = process.argv[2] ?? '/tmp/e2e-shots';
mkdirSync(shotDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const fails = [];
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'OK ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) fails.push(name);
};

const sfxRequests = new Set();
page.on('request', (req) => {
  const m = /\/sfx\/([a-z0-9_]+)\.ogg/.exec(req.url());
  if (m) sfxRequests.add(m[1]);
});

await page.goto('http://localhost:5199/');
await page.waitForSelector('canvas', { timeout: 10000 });

// ---------- quick play ----------
await page.click('text=Quick play');
await page.waitForTimeout(400);
ok('quick: launch overlay shows', await page.isVisible('.zenith-overlay.show'));
ok('quick: 10 floor buttons', (await page.locator('.floor-btn').count()) === 10);
await page.screenshot({ path: `${shotDir}/quick-launch.png` });

// start on The Laboratory with brutal pressure so garbage shows up fast
await page.locator('.floor-btn', { hasText: 'The Laboratory' }).click();
await page.selectOption('.zenith-opts select', 'brutal');
await page.click('text=Start climb');
await page.waitForTimeout(600);
ok('quick: overlay hidden after start', !(await page.isVisible('.zenith-overlay.show')));

const altOf = async () => parseFloat(await page.locator('.zenith-hud .alt').textContent());
const a0 = await altOf();
ok('quick: starts at F7 altitude', a0 >= 850 && a0 < 860, `alt=${a0}`);

// drop pieces for a while; altitude climbs passively, garbage arrives.
// topping out under brutal pressure is a legitimate end — the results
// overlay then carries the evidence instead of the live HUD.
ok('quick: garbage meter present', (await page.locator('.gmeter').count()) === 1);
ok('quick: b2b tag present', (await page.locator('.b2b-tag').count()) === 1);

let lastAlt = a0;
let taken = 0;
let ended = false;
let meterFilled = false;
for (let i = 0; i < 40 && !ended; i++) {
  await page.keyboard.press('Space');
  await page.waitForTimeout(450);
  ended = await page.isVisible('.zenith-overlay.show');
  if (!ended) {
    const alt = await altOf();
    if (!Number.isNaN(alt)) lastAlt = alt;
    const hud = await page.locator('.zenith-hud').textContent();
    taken = Number(/taken\s*(\d+)/.exec(hud)?.[1] ?? taken);
    const h = await page.evaluate(() => {
      const q = document.querySelector('.gm-queued');
      const a = document.querySelector('.gm-active');
      return (q?.clientHeight ?? 0) + (a?.clientHeight ?? 0);
    });
    if (h > 0) meterFilled = true;
  }
}
ok('quick: garbage meter filled during run', meterFilled);
ok('quick: piece sfx requested', sfxRequests.has('harddrop'), [...sfxRequests].join(','));
ok('quick: altitude climbed', lastAlt > a0, `alt ${a0} -> ${lastAlt}`);
ok('quick: garbage arrived', taken > 0 || ended, `taken=${taken} ended=${ended}`);
if (ended) {
  const res = await page.locator('.zenith-overlay').textContent();
  ok('quick: results overlay has the run', /m\b/.test(res) && res.includes('pieces'), res.slice(0, 60));
}
await page.screenshot({ path: `${shotDir}/quick-run.png` });

// retry resets the run at the same floor
await page.keyboard.press('KeyR');
await page.waitForTimeout(300);
const a2 = await altOf();
ok('quick: retry resets altitude', a2 >= 850 && a2 < 852, `alt=${a2}`);

// Esc returns to the launch overlay
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
ok('quick: Esc reopens launch', await page.isVisible('.zenith-overlay.show'));

// ---------- stats charts (seed sessions, then render) ----------
await page.evaluate(() => {
  const grades = (best, good, inacc, mist) => ({ best, good, inaccuracy: inacc, mistake: mist, killer: 0 });
  const day = 86400000;
  const sessions = [];
  for (let i = 0; i < 10; i++) {
    sessions.push({
      at: new Date(Date.now() - (10 - i) * day).toISOString(),
      mode: i % 3 === 2 ? 'free' : 'lst',
      pieces: 40 + i * 3,
      tsds: 5 + i,
      grades: grades(20 + i * 2, 10, 5, Math.max(0, 5 - i)),
      durationMs: 300000,
    });
    sessions.push({
      at: new Date(Date.now() - (10 - i) * day + 3600e3).toISOString(),
      mode: 'quick',
      pieces: 80,
      tsds: 2,
      grades: grades(0, 0, 0, 0),
      durationMs: 240000,
      altitude: 120 + i * 55,
    });
  }
  const raw = JSON.parse(localStorage.getItem('lst-trainer-stats-v1') ?? '{"modes":{}}');
  raw.sessions = sessions;
  localStorage.setItem('lst-trainer-stats-v1', JSON.stringify(raw));
});
await page.reload();
await page.waitForSelector('canvas', { timeout: 10000 });
await page.click('text=Stats');
await page.waitForTimeout(300);

ok('stats: two charts render', (await page.locator('svg.chart').count()) === 2);
ok('stats: legend for multi-series trend', (await page.locator('.legend-chip').count()) === 2);
ok('stats: session log rows', (await page.locator('.card:last-child table tr').count()) > 5);
const page1 = await page.locator('.page').textContent();
ok('stats: altitude chart labeled', page1.includes('altitude per run'));

// hover tooltip on the trend chart
const svg = page.locator('svg.chart').first();
const bb = await svg.boundingBox();
await page.mouse.move(bb.x + bb.width * 0.5, bb.y + bb.height * 0.5);
await page.waitForTimeout(150);
ok('stats: hover tooltip appears', await page.isVisible('.chart-tooltip.show'));
await page.screenshot({ path: `${shotDir}/stats-light.png` });

// dark theme
await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
await page.waitForTimeout(200);
await page.screenshot({ path: `${shotDir}/stats-dark.png` });

// ---------- LST drill still works & records a session ----------
await page.evaluate(() => { localStorage.removeItem('lst-trainer-stats-v1'); });
await page.reload();
await page.waitForSelector('canvas', { timeout: 10000 });
for (let i = 0; i < 8; i++) {
  await page.keyboard.press('Space');
  await page.waitForTimeout(900);
}
await page.click('text=Stats'); // destroys the drill -> flushes the session
await page.waitForTimeout(300);
const sess = await page.evaluate(() => JSON.parse(localStorage.getItem('lst-trainer-stats-v1')).sessions);
ok('drill: session recorded on leave', sess.length === 1 && sess[0].mode === 'lst', JSON.stringify(sess.map((s) => s.mode)));

await browser.close();
if (fails.length) {
  console.log(`\n${fails.length} FAILURES: ${fails.join(', ')}`);
  process.exit(1);
}
console.log('\nall new-feature checks passed');
