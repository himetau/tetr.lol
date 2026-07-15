// Tiny learned evaluator: a 14→16→1 MLP trained by tools/train-lst-eval.ts
// on self-play LST trajectories. It predicts the RESIDUAL between the
// hand-tuned heuristic and the realized discounted future reward, so an
// untrained/zero net changes nothing and the heuristic stays the baseline.

import net from '../data/lst-eval-net.json';

interface Net {
  mean: number[];
  std: number[];
  w1: number[][];   // [hidden][inputs]
  b1: number[];
  w2: number[];     // [hidden]
  b2: number;
  scale: number;    // 0 disables; also folds in the blend weight
}

const N = net as Net;

let blend = 1;

/** Kill switch (settings toggle / data generation). */
export function setNeuralBlend(x: number): void {
  blend = x;
}

export function neuralEnabled(): boolean {
  return blend > 0 && N.scale > 0;
}

/** Learned correction in heuristic-score units. */
export function neuralValue(features: number[]): number {
  if (blend === 0 || N.scale === 0) return 0;
  const h = N.b1.length;
  let out = N.b2;
  for (let j = 0; j < h; j++) {
    let a = N.b1[j];
    const wj = N.w1[j];
    for (let i = 0; i < features.length; i++) {
      a += wj[i] * ((features[i] - N.mean[i]) / N.std[i]);
    }
    if (a > 0) out += N.w2[j] * a; // ReLU
  }
  return out * N.scale * blend;
}
