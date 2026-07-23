// Dumps solveLstRun parity fixtures for the Rust port. For each case it
// reproduces harvestSeed's setup (opener plan applied to a real Game), then
// captures the exact solveLstRun INPUT (board rows, queue, hold, target,
// resolved options) and OUTPUT (full SolveResult). The Rust parity test runs
// solve_lst_run on the identical input and asserts byte-identical output,
// including the node count -- an exact match proves the search trees are
// algorithmically identical.
//
//   npx tsx tools/rust-solver-fixtures.ts          # tier A (fast, small targets)
//   BIG=1 npx tsx tools/rust-solver-fixtures.ts    # + tier B (full 20-TSD solves)

import { writeFileSync, mkdirSync } from "node:fs";
import { Game } from "../src/core/game";
import { planOpener } from "../src/engine/opener";
import { solveLstRun, type SolveOptions } from "../src/engine/lst-solver";
import type { PieceType } from "../src/core/pieces";

const DEFAULTS: Required<SolveOptions> = {
  budgetMs: 8000,
  nodeBudget: 4_000_000,
  maxBranch: 12,
  cycleSolutions: 24,
  cycleNodeCap: 5000,
  tailFree: 2,
  debug: false,
  maxDisc: 64,
  frontierBand: 4,
  allowQuad: false,
  szReserve: 0,
  partialHealth: false,
  leftOCapHorizon: 0,
};

interface Case {
  seed: number;
  targetTotal: number;
  opts: SolveOptions;
}

const tierA: Case[] = [
  { seed: 10, targetTotal: 5, opts: { budgetMs: 60000, nodeBudget: 200_000_000, tailFree: 3 } },
  { seed: 165, targetTotal: 6, opts: { budgetMs: 60000, nodeBudget: 200_000_000, tailFree: 3 } },
  { seed: 392, targetTotal: 5, opts: { budgetMs: 60000, nodeBudget: 200_000_000, tailFree: 3 } },
  { seed: 1228, targetTotal: 6, opts: { budgetMs: 60000, nodeBudget: 200_000_000, tailFree: 3 } },
  {
    seed: 10,
    targetTotal: 6,
    opts: { budgetMs: 60000, nodeBudget: 200_000_000, tailFree: 3, allowQuad: true },
  },
  // S/Z reserve path (opts.szReserve): node-capped partials mirror the live
  // budget-limited regime and stay deterministic by node count, so TS and Rust
  // must still be byte-identical with the toll on.
  {
    seed: 10,
    targetTotal: 20,
    opts: { budgetMs: 60000, nodeBudget: 300_000, tailFree: 3, szReserve: 150 },
  },
  {
    seed: 165,
    targetTotal: 20,
    opts: { budgetMs: 60000, nodeBudget: 300_000, tailFree: 3, szReserve: 150 },
  },
  // partialHealth path (opts.partialHealth): node-capped partials where the
  // healthiest-exit tie-break decides the returned line; TS and Rust must pick
  // the identical partial (same pieces-consumed + stack-side-imbalance math).
  {
    seed: 10,
    targetTotal: 20,
    opts: { budgetMs: 60000, nodeBudget: 300_000, tailFree: 3, szReserve: 150, partialHealth: true },
  },
  {
    seed: 165,
    targetTotal: 20,
    opts: { budgetMs: 60000, nodeBudget: 300_000, tailFree: 3, partialHealth: true },
  },
];

const tierB: Case[] = [
  { seed: 10, targetTotal: 20, opts: { budgetMs: 180000, nodeBudget: 200_000_000, tailFree: 3 } },
];

const cases = process.env.BIG ? [...tierA, ...tierB] : tierA;

function runCase(c: Case) {
  const game = new Game(c.seed);
  const plan = planOpener([game.active!.type, ...game.peekQueue(9)]);
  if (!plan) throw new Error(`seed ${c.seed}: no opener plan`);
  let openerTsds = 0;
  for (const mv of plan.moves) {
    const ev = game.applyMove(mv.piece, mv.cells, mv.spin);
    if (!ev) throw new Error(`seed ${c.seed}: opener move failed`);
    if (ev.piece === "T" && ev.spin === "full" && ev.linesCleared >= 2) openerTsds++;
  }
  const target = c.targetTotal - openerTsds;
  const queue = [game.active!.type, ...game.peekQueue(c.targetTotal * 9 + 20)] as PieceType[];
  const hold = game.hold;
  const rows = Array.from(game.board.rows);
  const opts = { ...DEFAULTS, ...c.opts };

  const t0 = Date.now();
  const res = solveLstRun(game.board, queue, hold, target, c.opts);
  const ms = Date.now() - t0;
  if (!res) throw new Error(`seed ${c.seed}: solveLstRun returned null`);

  return {
    seed: c.seed,
    targetTotal: c.targetTotal,
    openerTsds,
    input: { rows, queue, hold, target, opts },
    output: {
      moves: res.moves.map((m) => ({
        piece: m.piece,
        cells: m.cells,
        spin: m.spin,
        linesCleared: m.linesCleared,
        beforeKey: m.beforeKey,
        isTsd: m.isTsd,
      })),
      tsds: res.tsds,
      solved: res.solved,
      mirrored: res.mirrored,
      nodes: res.nodes,
    },
    solveMs: ms,
  };
}

const dumped = cases.map((c) => {
  const r = runCase(c);
  console.log(
    `seed ${r.seed} target ${r.input.target} (of ${r.targetTotal}): ` +
      `solved=${r.output.solved} tsds=${r.output.tsds} nodes=${r.output.nodes} in ${r.solveMs}ms`,
  );
  return r;
});

const outDir = "rust/lst-solver/tests";
mkdirSync(outDir, { recursive: true });
const out = `${outDir}/solver-fixtures.json`;
writeFileSync(out, JSON.stringify({ cases: dumped }, null, 0));
console.log(`wrote ${out}: ${dumped.length} cases`);
