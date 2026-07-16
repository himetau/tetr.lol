// For each seed: reproduce the generated board, brute-force the spin entry,
// and emit UI keys that execute it. Used by the e2e driver.
import { genAllspin } from '../../src/engine/allspin-gen';
import { Game } from '../../src/core/game';
import type { Rot } from '../../src/core/pieces';

function orient(g: Game, rot: Rot): void {
  if (rot === 1) g.rotate(1); else if (rot === 3) g.rotate(-1); else if (rot === 2) g.rotate(2);
}
function shiftTo(g: Game, x: number): boolean {
  let guard = 20;
  while (g.active && g.active.x < x && guard-- > 0) if (!g.moveRight()) break;
  guard = 20;
  while (g.active && g.active.x > x && guard-- > 0) if (!g.moveLeft()) break;
  return !!g.active && g.active.x === x;
}
function orientKeys(rot: Rot): string[] { return rot === 1 ? ['KeyX'] : rot === 3 ? ['KeyZ'] : rot === 2 ? ['KeyA'] : []; }
function shiftKeys(x: number): string[] { const n = x - 4; return Array.from({ length: Math.abs(n) }, () => (n > 0 ? 'ArrowRight' : 'ArrowLeft')); }
function rotKey(dir: 1 | -1 | 2): string { return dir === 1 ? 'KeyX' : dir === -1 ? 'KeyZ' : 'KeyA'; }

const seeds = [2, 4, 6, 8, 10];
const out = [];
for (const seed of seeds) {
  const { board, spinPiece } = genAllspin(seed, (seed & 1) === 1);
  let found = null;
  outer:
  for (let preRot = 0 as Rot; preRot < 4; preRot = (preRot + 1) as Rot) {
    for (let preX = 0; preX < 10; preX++) {
      for (const dir of [1, -1, 2] as const) {
        const g = new Game(1);
        g.reset(board.clone(), 1, [spinPiece]);
        orient(g, preRot);
        if (!shiftTo(g, preX)) continue;
        g.softDropToFloor();
        if (!g.rotate(dir)) continue;
        const ev = g.hardDrop();
        if (ev && ev.spin !== 'none' && ev.linesCleared >= 2) { found = { preRot, preX, dir }; break outer; }
      }
    }
  }
  if (!found) continue;
  const keys = [...orientKeys(found.preRot), ...shiftKeys(found.preX), 'ArrowDown', rotKey(found.dir), 'Space'];
  out.push({ seed, piece: spinPiece, keys });
}
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
