// Train the learned LST evaluator (src/data/lst-eval-net.json).
//
//   npx tsx tools/train-lst-eval.ts [games=300] [seed=1] [blend=0.5]
//
// 1. Self-play: the engine plays LST loops from the post-TKI board with
//    shallow search (ε-greedy for diversity), recording each position's
//    feature vector, its heuristic score, and the shaped move reward.
// 2. Label: Monte-Carlo discounted return of the rest of the trajectory
//    (γ=0.85, heuristic bootstrap at the horizon) MINUS the heuristic score
//    of the position — the net learns the residual the heuristic misses,
//    so a zero net is a no-op.
// 3. Train a 14→16→1 ReLU MLP (SGD + momentum) and export the weights with
//    the standardization folded in.

import { writeFileSync } from 'fs';
import { Board } from '../src/core/board';
import { SevenBag, mulberry32 } from '../src/core/rng';
import type { PieceType } from '../src/core/pieces';
import { enumeratePlacements } from '../src/engine/enumerate';
import { evaluateBoard, clearReward, findLstSite, findTSlots, lstFeatureVector } from '../src/engine/eval';
import { searchBestLine, LOOP_DEATH_TOLL, WASTED_T_TOLL, B2B_BREAK_TOLL, breaksB2b } from '../src/engine/search';
import { setNeuralBlend } from '../src/engine/neural';

setNeuralBlend(0); // data must come from the pure heuristic

const GAMES = Number(process.argv[2] ?? 300);
const SEED = Number(process.argv[3] ?? 1);
const BLEND = Number(process.argv[4] ?? 0.5);
const GAMMA = 0.85;
const MAX_PIECES = 70;
const EPS = 0.12;
const CLIP = 1200;
const HIDDEN = 16;
const START = ['_______X__', 'X__XX_XXXX'];
const SEARCH = { depth: 2, beamWidth: 8, lstBias: true };

interface Sample { f: number[]; y: number }

const rng = mulberry32(SEED);
const samples: Sample[] = [];

function shapedReward(p: { linesCleared: number; spin: string; type: PieceType; after: Board }, hadReadySlot: boolean): number {
  let r = clearReward({ linesCleared: p.linesCleared, spin: p.spin as 'none' | 'mini' | 'full' }, p.type);
  if (!findLstSite(p.after)) r += LOOP_DEATH_TOLL;
  if (p.type === 'T' && p.spin !== 'full') r += hadReadySlot ? -320 : WASTED_T_TOLL;
  if (breaksB2b(p.linesCleared, p.spin)) r += B2B_BREAK_TOLL;
  return r;
}

// ---- self-play ----
for (let g = 0; g < GAMES; g++) {
  const bag = new SevenBag(SEED * 1000 + g);
  let board = Board.fromStrings(START);
  let hold: PieceType | null = null;
  const queue: PieceType[] = [];
  const top = () => { while (queue.length < 6) queue.push(bag.next()); };

  const feats: number[][] = [];
  const heur: number[] = [];
  const rewards: number[] = [];
  let deadStreak = 0;

  for (let step = 0; step < MAX_PIECES; step++) {
    top();
    const active = queue[0];
    const preview = queue.slice(1);
    const hadReadySlot = findTSlots(board).some((s) => s.clears2);

    interface Cand { after: Board; r: number; s: number; queueAfter: PieceType[]; holdAfter: PieceType | null }
    const cands: Cand[] = [];
    const add = (piece: PieceType, queueAfter: PieceType[], holdAfter: PieceType | null) => {
      for (const p of enumeratePlacements(board, piece)) {
        const r = shapedReward(p, hadReadySlot);
        cands.push({ after: p.after, r, s: r + evaluateBoard(p.after, true).score, queueAfter, holdAfter });
      }
    };
    add(active, preview, hold);
    const holdPiece = hold ?? preview[0];
    if (holdPiece && holdPiece !== active) add(holdPiece, hold ? preview : preview.slice(1), active);
    if (cands.length === 0) break;

    cands.sort((a, b) => b.s - a.s);
    const searched = cands.slice(0, 10).map((c) => ({
      c,
      total: c.r + searchBestLine(c.after, c.queueAfter, 0, c.holdAfter, true, SEARCH).score,
    })).sort((a, b) => b.total - a.total);

    // ε-greedy among the top few, plus rare fully-random moves so the data
    // covers bad/dead states the policy would otherwise never visit
    const roll = rng();
    const pick = roll < 0.05
      ? cands[Math.floor(rng() * cands.length)]
      : searched[roll < EPS + 0.05 ? Math.floor(rng() * Math.min(4, searched.length)) : 0].c;

    board = pick.after;
    hold = pick.holdAfter;
    queue.length = 0;
    queue.push(...pick.queueAfter);

    feats.push(lstFeatureVector(board));
    heur.push(evaluateBoard(board, true).score);
    rewards.push(pick.r);

    deadStreak = findLstSite(board) ? 0 : deadStreak + 1;
    if (deadStreak >= 6 || board.maxHeight() >= 16) break;
  }

  // Monte-Carlo returns with a heuristic bootstrap at the horizon:
  // G_t = r_{t+1} + γ G_{t+1};  G_last = V_h(s_last)
  const returns = new Array<number>(rewards.length);
  for (let t = rewards.length - 1; t >= 0; t--) {
    returns[t] = t === rewards.length - 1
      ? heur[t]
      : rewards[t + 1] + GAMMA * returns[t + 1];
  }
  for (let t = 0; t < feats.length; t++) {
    const y = Math.max(-CLIP, Math.min(CLIP, returns[t] - heur[t]));
    samples.push({ f: feats[t], y });
  }
  if ((g + 1) % 50 === 0) console.error(`game ${g + 1}/${GAMES} — ${samples.length} samples`);
}
console.error(`${samples.length} samples from ${GAMES} games`);

// ---- standardize ----
const D = samples[0].f.length;
const mean = new Array(D).fill(0);
const std = new Array(D).fill(0);
for (const s of samples) for (let i = 0; i < D; i++) mean[i] += s.f[i];
for (let i = 0; i < D; i++) mean[i] /= samples.length;
for (const s of samples) for (let i = 0; i < D; i++) std[i] += (s.f[i] - mean[i]) ** 2;
for (let i = 0; i < D; i++) std[i] = Math.max(1e-6, Math.sqrt(std[i] / samples.length));
const yMean = samples.reduce((a, s) => a + s.y, 0) / samples.length;
const yStd = Math.max(1e-6, Math.sqrt(samples.reduce((a, s) => a + (s.y - yMean) ** 2, 0) / samples.length));

const X = samples.map((s) => s.f.map((v, i) => (v - mean[i]) / std[i]));
const Y = samples.map((s) => (s.y - yMean) / yStd);

// train/val split
const idx = X.map((_, i) => i);
for (let i = idx.length - 1; i > 0; i--) {
  const j = Math.floor(rng() * (i + 1));
  [idx[i], idx[j]] = [idx[j], idx[i]];
}
const nVal = Math.floor(idx.length * 0.1);
const valIx = idx.slice(0, nVal);
const trainIx = idx.slice(nVal);

// ---- MLP D→HIDDEN→1 ----
const w1 = Array.from({ length: HIDDEN }, () => Array.from({ length: D }, () => (rng() * 2 - 1) * Math.sqrt(2 / D)));
const b1 = new Array(HIDDEN).fill(0);
const w2 = Array.from({ length: HIDDEN }, () => (rng() * 2 - 1) * Math.sqrt(2 / HIDDEN));
let b2 = 0;
const mw1 = w1.map((r) => r.map(() => 0));
const mb1 = new Array(HIDDEN).fill(0);
const mw2 = new Array(HIDDEN).fill(0);
let mb2 = 0;

function forward(x: number[]): { out: number; a: number[] } {
  const a = new Array(HIDDEN);
  let out = b2;
  for (let j = 0; j < HIDDEN; j++) {
    let z = b1[j];
    for (let i = 0; i < D; i++) z += w1[j][i] * x[i];
    a[j] = z > 0 ? z : 0;
    out += w2[j] * a[j];
  }
  return { out, a };
}

function valLoss(): number {
  let se = 0;
  for (const i of valIx) se += (forward(X[i]).out - Y[i]) ** 2;
  return se / valIx.length;
}

const EPOCHS = 60;
const MOM = 0.9;
const BATCH = 32;
const CLIP_G = 1.5; // per-sample gradient clip on the output error
for (let ep = 0; ep < EPOCHS; ep++) {
  const lr = 0.002 * (1 - ep / EPOCHS) + 0.0002;
  // shuffle train set
  for (let i = trainIx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [trainIx[i], trainIx[j]] = [trainIx[j], trainIx[i]];
  }
  for (let start = 0; start + BATCH <= trainIx.length; start += BATCH) {
    const gw1 = w1.map((r) => r.map(() => 0));
    const gb1 = new Array(HIDDEN).fill(0);
    const gw2 = new Array(HIDDEN).fill(0);
    let gb2 = 0;
    for (let k = 0; k < BATCH; k++) {
      const x = X[trainIx[start + k]];
      const { out, a } = forward(x);
      let g = 2 * (out - Y[trainIx[start + k]]) / BATCH;
      g = Math.max(-CLIP_G, Math.min(CLIP_G, g));
      gb2 += g;
      for (let j = 0; j < HIDDEN; j++) {
        gw2[j] += g * a[j];
        if (a[j] > 0) {
          const gh = g * w2[j];
          gb1[j] += gh;
          for (let i = 0; i < D; i++) gw1[j][i] += gh * x[i];
        }
      }
    }
    mb2 = MOM * mb2 + gb2;
    b2 -= lr * mb2;
    for (let j = 0; j < HIDDEN; j++) {
      mw2[j] = MOM * mw2[j] + gw2[j];
      w2[j] -= lr * mw2[j];
      mb1[j] = MOM * mb1[j] + gb1[j];
      b1[j] -= lr * mb1[j];
      for (let i = 0; i < D; i++) {
        mw1[j][i] = MOM * mw1[j][i] + gw1[j][i];
        w1[j][i] -= lr * mw1[j][i];
      }
    }
  }
  const v = valLoss();
  if (!Number.isFinite(v)) {
    console.error(`DIVERGED at epoch ${ep + 1} — aborting without export`);
    process.exit(1);
  }
  if ((ep + 1) % 10 === 0) console.error(`epoch ${ep + 1}: val MSE ${v.toFixed(4)} (var=1)`);
}

// correlation on val
let sxy = 0, sx = 0, sy = 0, sxx = 0, syy = 0;
for (const i of valIx) {
  const p = forward(X[i]).out;
  sxy += p * Y[i]; sx += p; sy += Y[i]; sxx += p * p; syy += Y[i] * Y[i];
}
const n = valIx.length;
const corr = (n * sxy - sx * sy) / Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
console.error(`val correlation: ${corr.toFixed(3)}`);

// fold the target scaling back in: raw = out * yStd + yMean
const net = {
  mean, std, w1, b1,
  w2: w2.map((v) => v * yStd),
  b2: b2 * yStd + yMean,
  scale: BLEND,
};
writeFileSync('src/data/lst-eval-net.json', JSON.stringify(net));
console.error(`wrote src/data/lst-eval-net.json (blend ${BLEND})`);
