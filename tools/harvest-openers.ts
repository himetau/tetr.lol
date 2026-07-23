// Offline opener-shape harvester. For bags the fixed planOpener can't build,
// search (generously, offline) for a CLEAN opener from empty that fires one TSD
// and lands on-book, then bank the pre-TSD board as a new goal shape the live
// generative filler can reuse for any bag. This step is just the yield probe:
// can the offline search even find openers for the failing bags, and how fast?
//   npx tsx tools/harvest-openers.ts [sample=30] [budgetMs=4000]

import { Board } from "../src/core/board";
import type { PieceType } from "../src/core/pieces";
import { enumeratePlacements } from "../src/engine/enumerate";
import { lstHoles, findLstSite, isLstState } from "../src/engine/eval";
import { planOpener } from "../src/engine/opener";

// The opener has succeeded once the loop player can take over: a valid LST shape
// with a ready col-2 TSD site. This is BROADER (and far more reachable) than the
// cover-book onBook match - the live loop is driven by lstLoopMove, not the book.
const continuable = (board: Board) => isLstState(board) && findLstSite(board) !== null;

const PIECES: PieceType[] = ["I", "O", "T", "S", "Z", "J", "L"];
function mul(s: number) { let a = s >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function bag(r: () => number) { const b = [...PIECES]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }

interface Move { piece: PieceType; cells: [number, number][]; spin: string }

// Blind clean-build search to an on-book board, height-ordered (does NOT punish
// the single notch, so TSD setups are reachable), full enumeration (tucks), one
// clear event, T only as the finishing TSD. Offline budget in ms.
function findOpener(queue: PieceType[], budgetMs: number): Move[] | null {
  const deadline = Date.now() + budgetMs;
  const moves: Move[] = [];
  const seen = new Set<string>();
  const dfs = (board: Board, qi: number, hold: PieceType | null, tsdFired: boolean, clears: number): boolean => {
    if (tsdFired && continuable(board)) return true;
    if (qi >= queue.length || qi >= 11 || board.maxHeight() > 6 || Date.now() > deadline) return false;
    const sk = `${board.key()}|${qi}|${hold ?? "-"}|${tsdFired ? 1 : 0}`;
    if (seen.has(sk)) return false;
    seen.add(sk);
    const tryPlace = (piece: PieceType, nextHold: PieceType | null, nextQi: number): boolean => {
      const cands = enumeratePlacements(board, piece)
        .filter((p) => {
          if (piece === "T") return p.spin === "full" && p.linesCleared >= 2;
          if (p.linesCleared > 0) return false;
          return p.after.maxHeight() <= 6 && lstHoles(p.after) <= 1;
        })
        .sort((a, b) => a.after.maxHeight() - b.after.maxHeight()); // height only - keep the notch
      for (const p of cands) {
        if (p.linesCleared > 0 && clears > 0) continue;
        const fired = p.type === "T" && p.spin === "full" && p.linesCleared >= 2;
        moves.push({ piece, cells: p.cells.map(([a, b]) => [a, b] as [number, number]), spin: p.spin });
        if (dfs(p.after, nextQi, nextHold, tsdFired || fired, clears + (p.linesCleared > 0 ? 1 : 0))) return true;
        moves.pop();
      }
      return false;
    };
    const cur = queue[qi];
    if (tryPlace(cur, hold, qi + 1)) return true;
    if (hold && hold !== cur && tryPlace(hold, cur, qi + 1)) return true;
    if (!hold && qi + 1 < queue.length && tryPlace(queue[qi + 1], cur, qi + 2)) return true;
    if (!hold && dfs(board, qi + 1, cur, tsdFired, clears)) return true;
    return false;
  };
  return dfs(new Board(), 0, null, false, 0) ? moves : null;
}

const SAMPLE = Number(process.argv[2] ?? 30);
const BUDGET = Number(process.argv[3] ?? 4000);
let failing = 0, harvested = 0;
const times: number[] = [];
for (let i = 0; i < SAMPLE; i++) {
  const r = mul(9000 + i);
  const q = [...bag(r), ...bag(r)];
  if (planOpener(q)) continue; // only the bags the fixed planner drops
  failing++;
  const t0 = Date.now();
  const op = findOpener(q, BUDGET);
  const ms = Date.now() - t0;
  times.push(ms);
  if (op) { harvested++; console.log(`  ${q.slice(0, 7).join("")}: HARVESTED ${op.length} moves ${ms}ms`); }
  else console.log(`  ${q.slice(0, 7).join("")}: none ${ms}ms`);
}
console.log(`\nfailing bags in sample: ${failing}, harvested openers: ${harvested} (${failing ? ((100 * harvested) / failing).toFixed(0) : 0}%)`);
if (times.length) console.log(`search time: avg ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(0)}ms, max ${Math.max(...times)}ms`);
