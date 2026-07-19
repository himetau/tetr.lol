// Action-text juice layer: tetr.io-style popups over the field panel
// ("QUAD", "T-SPIN DOUBLE", "B2B ×7", "ALL CLEAR", floor-ups). The canvas
// effects (particles, shake, flashes) live in FieldRenderer; this file is
// the DOM half plus the naming logic for what a lock event should shout.

import type { LockEvent } from '../core/game';

export type ActionKind = 'plain' | 'spin' | 'quad' | 'allclear' | 'surge' | 'floor' | 'combo';

/** Pop a floating action label over the field. Stacks briefly, cleans itself up. */
export function actionText(host: HTMLElement, main: string, sub = '', kind: ActionKind = 'plain'): void {
  let layer = host.querySelector<HTMLElement>(':scope > .action-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'action-layer';
    host.appendChild(layer);
  }
  const el = document.createElement('div');
  el.className = `action-text at-${kind}`;
  const m = document.createElement('div');
  m.className = 'at-main';
  m.textContent = main;
  el.appendChild(m);
  if (sub) {
    const s = document.createElement('div');
    s.className = 'at-sub';
    s.textContent = sub;
    el.appendChild(s);
  }
  // slight random tilt/offset so rapid-fire popups don't stamp on each other
  el.style.setProperty('--at-x', `${(Math.random() * 2 - 1) * 14}px`);
  el.style.setProperty('--at-r', `${(Math.random() * 2 - 1) * 3}deg`);
  el.addEventListener('animationend', (e) => {
    if (e.target === el) el.remove();
  });
  while (layer.children.length >= 3) layer.firstChild!.remove();
  layer.appendChild(el);
}

/**
 * A big "+N" attack number that punches in over the field and rattles harder
 * the more lines you sent — the bigger the spike, the larger and shakier it is.
 * `intensity` is 0..1 (how far above the big-send threshold the attack was).
 */
export function sentNumber(host: HTMLElement, lines: number, intensity: number): void {
  let layer = host.querySelector<HTMLElement>(':scope > .action-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'action-layer';
    host.appendChild(layer);
  }
  const t = Math.max(0, Math.min(1, intensity));
  const el = document.createElement('div');
  el.className = 'sent-pop';
  el.textContent = `+${lines}`;
  el.style.setProperty('--sp-scale', `${1 + t * 1.2}`);  // grows with the spike
  el.style.setProperty('--sp-shake', `${2 + t * 12}px`);  // rattles harder
  el.style.setProperty('--sp-dur', `${0.5 + t * 0.5}s`);  // lingers a touch longer
  el.addEventListener('animationend', (e) => {
    if (e.target === el) el.remove();
  });
  layer.appendChild(el);
}

const LINES_NAME = ['', 'SINGLE', 'DOUBLE', 'TRIPLE', 'QUAD'];

export interface ActionLabel {
  main: string;
  kind: ActionKind;
}

/** What a lock event should shout, tetr.io-style. Null = nothing noteworthy. */
export function lockActionLabel(ev: LockEvent): ActionLabel | null {
  const n = ev.linesCleared;
  const allClear = n > 0 && ev.boardAfter.isEmpty();
  if (allClear) return { main: 'ALL CLEAR', kind: 'allclear' };
  if (ev.spin !== 'none') {
    const mini = ev.spin === 'mini' ? 'MINI ' : '';
    const what = n > 0 ? ` ${LINES_NAME[Math.min(n, 4)]}` : '';
    return { main: `${mini}${ev.piece}-SPIN${what}`, kind: 'spin' };
  }
  if (n === 4) return { main: 'QUAD', kind: 'quad' };
  if (n > 0) return { main: LINES_NAME[n], kind: 'plain' };
  return null;
}

/** Cleared row indices (pre-clear, bottom-up) implied by a lock event. */
export function clearedRowsOf(ev: LockEvent): number[] {
  if (ev.linesCleared === 0) return [];
  const b = ev.boardBefore.clone();
  b.place(ev.cells);
  return b.clearLines();
}
