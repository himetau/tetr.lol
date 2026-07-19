// Plans a keyboard script for the e2e drive: TKI opener -> TSD -> bag-2 book
// line (with one deliberate deviation + undo). Prints JSON steps for the
// playwright driver. Planning uses the engine; execution happens in the app.

import { Game, SPAWN_X } from '../../src/core/game';
import { Board } from '../../src/core/board';
import { cellsAt, type PieceType } from '../../src/core/pieces';
import { enumeratePlacements, type Placement } from '../../src/engine/enumerate';
import { bookAdvice } from '../../src/engine/book';
import { TKI_TARGETS, type OpenerTarget } from '../../src/engine/opener';
import coverData from '../../src/data/lst-cover.json';

type Cells = [number, number][];
const key = (cs: Cells) => cs.map(([x, y]) => x * 32 + y).sort((a, b) => a - b).join(',');

interface Step { keys: string[]; desc: string; expect?: string }

function pureDropReaches(board: Board, p: Placement): boolean {
  // rotate at spawn, shift to x, hard drop: does it land on the target cells?
  let y = 20;
  while (!board.collides(cellsAt(p.type, p.rot, p.x, y - 1))) y--;
  return key(cellsAt(p.type, p.rot, p.x, y) as Cells) === key(p.cells as Cells);
}

function keysFor(board: Board, p: Placement, useHold: boolean): string[] {
  const keys: string[] = useHold ? ['KeyC'] : [];
  if (!pureDropReaches(board, p)) {
    // spin/tuck: replay the finesse path, collapsing sd-runs (sdf=41 -> floor)
    let prevSd = false;
    for (const m of p.path) {
      if (m === 'sd') { if (!prevSd) keys.push('ArrowDown'); prevSd = true; continue; }
      prevSd = false;
      keys.push(m === 'left' ? 'ArrowLeft' : m === 'right' ? 'ArrowRight' : m === 'cw' ? 'ArrowUp' : m === 'ccw' ? 'KeyZ' : 'KeyA');
    }
  } else {
    if (p.rot === 1) keys.push('ArrowUp');
    else if (p.rot === 2) keys.push('KeyA');
    else if (p.rot === 3) keys.push('KeyZ');
    const dx = p.x - SPAWN_X;
    for (let i = 0; i < Math.abs(dx); i++) keys.push(dx < 0 ? 'ArrowLeft' : 'ArrowRight');
  }
  keys.push('Space');
  return keys;
}

function findPlacement(board: Board, piece: PieceType, cells: Cells): Placement | null {
  return enumeratePlacements(board, piece).find((p) => key(p.cells as Cells) === key(cells)) ?? null;
}

// ---- choose seed + TKI target that chains into the bag-2 book ----
const bag2 = coverData.groups.find((g) => g.name === 'flattop LST bag 2')!;
const rawStart = Board.fromStrings(bag2.start);
const mirStart = new Board();
for (let y = 0; y < 26; y++) for (let x = 0; x < 10; x++) if (rawStart.rows[y] >>> x & 1) mirStart.rows[y] |= 1 << (9 - x);
const startKeys = new Set([rawStart.key(), mirStart.key()]);

interface OpenerPlan { actions: { piece: PieceType; cells: Cells }[]; tsd: Cells }

function solveOpener(target: OpenerTarget, queue: PieceType[]): OpenerPlan | null {
  const tCells = target.pieces.T as Cells | undefined;
  if (!tCells) return null;
  const full = Board.fromStrings(target.rows.map((r) => r.replace(/[A-Z]/g, 'X')));
  const cleared = full.clone();
  if (cleared.clearLines().length < 2 || !startKeys.has(cleared.key())) return null;

  const build = (Object.entries(target.pieces) as [PieceType, Cells][]).filter(([pc]) => pc !== 'T');
  const done: { piece: PieceType; cells: Cells }[] = [];
  const dfs = (board: Board, rem: [PieceType, Cells][], qi: number, hold: PieceType | null): boolean => {
    if (rem.length === 0) return true;
    if (qi >= queue.length) return false;
    const tryPiece = (piece: PieceType, nextHold: PieceType | null): boolean => {
      for (let i = 0; i < rem.length; i++) {
        if (rem[i][0] !== piece) continue;
        const p = findPlacement(board, piece, rem[i][1]);
        if (!p || p.linesCleared > 0) continue;
        done.push({ piece, cells: rem[i][1] });
        if (dfs(p.after, rem.filter((_, j) => j !== i), qi + 1, nextHold)) return true;
        done.pop();
      }
      return false;
    };
    const active = queue[qi];
    if (tryPiece(active, hold)) return true;
    if (hold && hold !== active && tryPiece(hold, active)) return true;
    if (hold === null && dfs(board, rem, qi + 1, active)) return true; // park in hold
    return false;
  };
  if (!dfs(new Board(), build, 0, null)) return null;
  return { actions: done, tsd: tCells };
}

let plan: OpenerPlan | null = null;
let seed = 0;
let targetName = '';
outer:
for (let s = 1; s < 80; s++) {
  const g = new Game(s);
  const bag1 = [g.active!.type, ...g.preview(), ...(g as any).bag.peek(1)] as PieceType[];
  for (const t of TKI_TARGETS) {
    const p = solveOpener(t, bag1);
    if (p) { plan = p; seed = s; targetName = t.name; break outer; }
  }
}
if (!plan) throw new Error('no seed/target combo found');

// ---- replay on a sim game, emitting key steps ----
const steps: Step[] = [];
const sim = new Game(seed);

const doPlacement = (piece: PieceType, cells: Cells, desc: string, expect?: string) => {
  let useHold = false;
  if (sim.active!.type !== piece) {
    useHold = true;
    sim.holdPiece();
    if (sim.active!.type !== piece) throw new Error(`sim desync at "${desc}": want ${piece}, active ${sim.active!.type}, hold ${sim.hold}`);
  }
  const p = findPlacement(sim.board, piece, cells);
  if (!p) throw new Error(`unreachable ${piece} at "${desc}"`);
  steps.push({ keys: keysFor(sim.board, p, useHold), desc, expect });
  // teleport the sim piece to the planned pose; hardDrop locks it in place
  sim.active!.rot = p.rot; sim.active!.x = p.x; sim.active!.y = p.y;
  const ev = sim.hardDrop();
  if (!ev || key(ev.cells as Cells) !== key(cells)) throw new Error(`sim landed wrong at "${desc}"`);
};

for (const a of plan.actions) doPlacement(a.piece, a.cells, `opener ${a.piece}`, 'Book ·');
doPlacement('T', plan.tsd, 'opener TSD', 'into LST');

// ---- bag 2: follow the book, with one deviation + undo up front ----
let deviated = false;
let placed = 0;
let guard = 0;
while (placed < 6 && guard++ < 20) {
  const queue = [sim.active!.type, ...sim.preview()] as PieceType[];
  const adv = bookAdvice(sim.board, queue, sim.hold);
  if (!adv.onBook) throw new Error(`sim off book at bag2 piece ${placed}`);
  if (!adv.sustainable) {
    steps.push({ keys: [], desc: `bag2 queue unsustainable at piece ${placed} - plan ends here`, expect: 'sustained' });
    break;
  }
  if (adv.moves.length === 0) {
    if (!adv.holdIsBook) throw new Error(`bag2 stuck at piece ${placed}: no moves, no hold`);
    steps.push({ keys: ['KeyC'], desc: `bag2: park ${sim.active!.type} in hold (book)` });
    sim.holdPiece();
    continue;
  }
  const mv = adv.moves.find((m) => !m.usesHold) ?? adv.moves[0];
  if (!deviated) {
    deviated = true;
    // deliberate non-book move with the active piece: flat at the far right
    const stray = enumeratePlacements(sim.board, sim.active!.type)
      .filter((p) => key(p.cells as Cells) !== key(mv.cells as Cells) && p.linesCleared === 0)
      .sort((a, b) => b.x - a.x)[0];
    steps.push({ keys: keysFor(sim.board, stray, false), desc: `bag2 deviation: ${stray.type} far right (expect book hint)`, expect: 'Book' });
    steps.push({ keys: ['Escape', 'Ctrl+KeyZ'], desc: 'dismiss + undo the deviation' });
    // sim never applies the deviation: the app's undo restores this exact state
  }
  doPlacement(mv.piece, mv.cells as Cells, `bag2 book ${mv.piece} (${mv.solution})`, 'Book ·');
  placed++;
}

// bag-2 TSD: prefer the one whose result is a bag-3 book start
const bag3Starts = new Set<string>();
for (const g of coverData.groups.filter((g) => / bag 3$/.test(g.name))) {
  const b = Board.fromStrings(g.start);
  bag3Starts.add(b.key());
  const m = new Board();
  for (let y = 0; y < 26; y++) for (let x = 0; x < 10; x++) if (b.rows[y] >>> x & 1) m.rows[y] |= 1 << (9 - x);
  bag3Starts.add(m.key());
}
if (sim.active!.type === 'T' || sim.hold === 'T') {
  const tsds = enumeratePlacements(sim.board, 'T').filter((p) => p.spin === 'full' && p.linesCleared >= 2);
  const chaining = tsds.find((p) => bag3Starts.has(p.after.key()));
  console.error(`bag2 TSD options: ${tsds.length}, chaining into bag-3 book: ${chaining ? 'YES' : 'NO'}`);
  const tsd = chaining ?? tsds[0];
  if (tsd) doPlacement('T', tsd.cells as Cells, 'bag2 TSD', 'TSD');
}
// post-TSD: is the board a live bag-3 book state?
{
  const queue = [sim.active!.type, ...sim.preview()] as PieceType[];
  const adv = bookAdvice(sim.board, queue, sim.hold);
  console.error(`post-TSD book state: onBook=${adv.onBook} sustainable=${adv.sustainable} solutions=${adv.solutions.slice(0, 3).join(' ; ')}`);
}

console.log(JSON.stringify({ seed, targetName, steps }, null, 1));
