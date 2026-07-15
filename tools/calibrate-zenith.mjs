// Calibrate the quick-play garbage model against real TETR.IO QUICK PLAY
// records from the public TETRA CHANNEL API (ch.tetr.io/api).
//
//   node tools/calibrate-zenith.mjs [nRecords]
//
// Method: each record reports total garbage lines received, the run length,
// and `zenith.splits` (ms timestamps of reaching floors 2..10), which gives
// the time spent inside each floor. Every run is then one equation
//     sum_f rate_f * timeInFloor_f = garbageReceived
// and per-floor rates (lines/min) fall out of a non-negative least-squares
// fit over many runs (solved here with simple projected gradient descent).
// The suggested attackEveryMs makes the simulator's expected lines/min at
// 'normal' pressure match the fitted rate, given the rng^2-skewed attack
// size in src/core/zenith.ts.

const N = Number(process.argv[2] ?? 200);
const FLOOR_COUNT = 10;

async function fetchPage(after) {
  const url = `https://ch.tetr.io/api/records/zenith_global?limit=100${after ? `&after=${after}` : ''}`;
  const res = await fetch(url, { headers: { 'user-agent': 'lst-trainer-calibration' } });
  const j = await res.json();
  if (!j.success) throw new Error(JSON.stringify(j.error));
  return j.data.entries;
}

const runs = [];
let after = null;
while (runs.length < N) {
  const entries = await fetchPage(after);
  if (entries.length === 0) break;
  for (const e of entries) {
    const s = e.results?.stats;
    const z = s?.zenith;
    if (!s || !z || !s.finaltime || z.revivesTotal > 0) continue; // revives skew received
    runs.push({
      altitude: z.altitude,
      finaltime: s.finaltime,
      splits: z.splits.filter((t) => t > 0),
      received: s.garbage?.received ?? 0,
      mods: e.extras?.zenith?.mods ?? [],
    });
  }
  const last = entries[entries.length - 1].p;
  after = `${last.pri}:${last.sec}:${last.ter}`;
  process.stderr.write(`fetched ${runs.length} runs...\n`);
}

// time spent in each floor: splits are cumulative ms at floor entries 2..10
function timePerFloor(run) {
  const t = new Array(FLOOR_COUNT).fill(0);
  const marks = [0, ...run.splits, run.finaltime];
  for (let f = 0; f < Math.min(marks.length - 1, FLOOR_COUNT); f++) {
    t[f] = Math.max(0, (Math.min(marks[f + 1], run.finaltime) - marks[f]) / 60000); // minutes
  }
  return t;
}

const X = runs.map(timePerFloor);
const y = runs.map((r) => r.received);

// Non-negative least squares with monotonicity (pressure never drops with
// floor): parameterize rate_f = sum of non-negative increments d_0..d_f,
// which keeps the problem linear — design matrix becomes suffix sums.
const Xc = X.map((row) => {
  const out = new Array(FLOOR_COUNT).fill(0);
  for (let j = 0; j < FLOOR_COUNT; j++) {
    for (let f = j; f < FLOOR_COUNT; f++) out[j] += row[f];
  }
  return out;
});
let d = new Array(FLOOR_COUNT).fill(1);
for (let iter = 0; iter < 40000; iter++) {
  const grad = new Array(FLOOR_COUNT).fill(0);
  for (let i = 0; i < Xc.length; i++) {
    let pred = 0;
    for (let j = 0; j < FLOOR_COUNT; j++) pred += d[j] * Xc[i][j];
    const err = pred - y[i];
    for (let j = 0; j < FLOOR_COUNT; j++) grad[j] += 2 * err * Xc[i][j];
  }
  for (let j = 0; j < FLOOR_COUNT; j++) {
    d[j] = Math.max(0, d[j] - 1e-7 * grad[j]);
  }
}
const rate = [];
let acc = 0;
for (let f = 0; f < FLOOR_COUNT; f++) {
  acc += d[f];
  rate.push(acc);
}

// expected attack size for the simulator's skewed roll: 1 + floor(u^2 * max)
function expectedAttackSize(max) {
  let s = 0;
  const n = 100000;
  for (let i = 0; i < n; i++) s += 1 + Math.floor(((i + 0.5) / n) ** 2 * max);
  return s / n;
}

const attackMax = [2, 2, 3, 4, 5, 5, 6, 6, 7, 8]; // keep in sync with FLOORS
console.log(`\n${runs.length} runs (alt ${Math.min(...runs.map((r) => r.altitude)).toFixed(0)}–${Math.max(...runs.map((r) => r.altitude)).toFixed(0)}m)`);
console.log('floor  lines/min  E[attack]  attackEveryMs');
for (let f = 0; f < FLOOR_COUNT; f++) {
  const ea = expectedAttackSize(attackMax[f]);
  const gap = rate[f] > 0.05 ? Math.round((ea / rate[f]) * 60000) : Infinity;
  console.log(`F${String(f + 1).padEnd(4)} ${rate[f].toFixed(1).padStart(8)} ${ea.toFixed(2).padStart(10)} ${String(gap).padStart(13)}`);
}

// sanity: total residual
let sse = 0, sst = 0;
const mean = y.reduce((a, b) => a + b, 0) / y.length;
for (let i = 0; i < X.length; i++) {
  let pred = 0;
  for (let f = 0; f < FLOOR_COUNT; f++) pred += rate[f] * X[i][f];
  sse += (pred - y[i]) ** 2;
  sst += (y[i] - mean) ** 2;
}
console.log(`R² = ${(1 - sse / sst).toFixed(3)}`);
