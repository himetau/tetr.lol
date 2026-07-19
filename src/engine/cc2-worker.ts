// Cold Clear 2 analysis worker. Loads the (all-spin-patched) CC2 bot compiled
// to WASM and answers "best move" queries for the all-spin trainer. One bot is
// built per query from the given position, thought about for a fixed node
// budget, then discarded - we only ever analyse a single position at a time.

import init, { ColdClear } from './cc2/cold_clear_2.js';

export interface CC2Request {
  id: number;
  cols: number[];      // 10 column bitboards (bit y set = filled at row y)
  queue: string;       // upcoming pieces, front = current
  hold: string;        // hold piece letter, or ''
  b2b: boolean;
  combo: number;
  nodes: number;       // search work units
  weights?: string;    // BotConfig JSON override (e.g. LST-loop profile), or ''
}

export interface CC2Move {
  piece: string;
  spin: 'n' | 'm' | 'f';
  lines: number;
  usesHold: boolean;
  soft: boolean;       // needs a soft-drop / tuck - more cognitively demanding
  x: number;
  y: number;
  cells: number[];     // [x0,y0, x1,y1, x2,y2, x3,y3]
}

const readyP = init().catch(() => { /* wasm unavailable */ });

self.onmessage = async (e: MessageEvent<CC2Request>) => {
  const req = e.data;
  await readyP;
  let moves: CC2Move[] = [];
  try {
    const cc = new ColdClear(new Uint32Array(req.cols), req.queue, req.hold, req.b2b, req.combo, req.weights ?? '');
    cc.work(req.nodes);
    const s = cc.suggest();
    cc.free();
    moves = s ? (JSON.parse(s) as CC2Move[]) : [];
  } catch {
    moves = [];
  }
  (self as unknown as Worker).postMessage({ id: req.id, moves });
};
