// Cheap probe (pure DFS, no beam) of planOpener's success rate over random
// 7-bag queues - the "?unpooled=1 = testing the engine itself" opener path.
// Reports how often the opener plans on-rails vs falls back to drift, and which
// targets carry the load. Also prints a few failing bag orders to diagnose.
//   npx tsx tools/opener-probe.ts [runs=40]

import type { PieceType } from "../src/core/pieces";
import { planOpener, planOpenerGenerative, TKI_TARGETS } from "../src/engine/opener";

const PIECES: PieceType[] = ["I", "O", "T", "S", "Z", "J", "L"];
function mul(s: number) { let a = s >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function bag(r: () => number) { const b = [...PIECES]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }

const usable = TKI_TARGETS.filter((t) => (Object.keys(t.pieces).length >= 7 && t.pieces["T"]));
console.log(`TKI_TARGETS: ${TKI_TARGETS.length} total, ${usable.length} usable by planOpener (>=7 letters + T):`);
for (const t of usable) console.log(`   - ${t.name}`);

const RUNS = Number(process.argv[2] ?? 40);
let ok = 0, okGen = 0, okCombined = 0, tGen = 0;
const fails: string[] = [];
const genFails: string[] = [];
const byTarget = new Map<string, number>();
for (let i = 0; i < RUNS; i++) {
  const r = mul(9000 + i);
  const q = [...bag(r), ...bag(r)]; // 14 pieces (2 bags) - opener spans ~bag 1.5
  const plan = planOpener(q);
  if (plan) { ok++; byTarget.set(plan.target.name, (byTarget.get(plan.target.name) ?? 0) + 1); }
  else if (fails.length < 6) fails.push(q.slice(0, 7).join(""));
  const t0 = Date.now();
  const gen = planOpenerGenerative(q);
  tGen += Date.now() - t0;
  if (gen) okGen++; else if (genFails.length < 8) genFails.push(q.slice(0, 7).join(""));
  if (plan || gen) okCombined++;
}
console.log(`\nplanOpener (fixed-target) success: ${ok}/${RUNS} (${((100 * ok) / RUNS).toFixed(0)}%)`);
console.log("  targets used:", [...byTarget].map(([n, k]) => `${n}=${k}`).join(", "));
console.log(`planOpenerGenerative success:      ${okGen}/${RUNS} (${((100 * okGen) / RUNS).toFixed(0)}%)  avg ${(tGen / RUNS).toFixed(0)}ms/bag`);
console.log(`combined (fixed || generative):    ${okCombined}/${RUNS} (${((100 * okCombined) / RUNS).toFixed(0)}%)`);
if (fails.length) console.log("still failing fixed:", fails.join("  "));
if (genFails.length) console.log("still failing generative:", genFails.join("  "));
